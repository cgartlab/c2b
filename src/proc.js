/**
 * proc.js — 子进程执行工具
 *
 * 核心约束（本机实测）：
 * 在受限沙箱中，凡是会创建管道的子进程调用都会抛 EPERM。
 *   - execFile / exec  → 永远 EPERM（内部必建管道，即使传 stdio:'ignore'）
 *   - spawn + stdio:'inherit' → 正常
 * 因此统一采用「spawn + inherit + 输出重定向到临时文件」的方式捕获输出。
 *
 * 这一写法在沙箱外同样成立，所以无需分支：沙箱内外行为一致。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

/** 统一临时文件名前缀，便于排查残留。 */
const TMP_PREFIX = 'cam-to-bg';

function tmpFile(tag) {
  return path.join(os.tmpdir(), `${TMP_PREFIX}-${tag}-${process.pid}-${crypto.randomBytes(5).toString('hex')}.txt`);
}

/**
 * 运行一个子进程并捕获 stdout / stderr。
 *
 * 实现方式：让 shell 把两个流重定向到文件（cmd 的 > 与 2>），
 * 再用 stdio:'inherit' 启动，最后读文件。
 *
 * @param {string} command 可执行文件路径（勿含 shell 元字符）
 * @param {string[]} args 参数数组（每个参数会被单独引号包裹）
 * @param {object} [options]
 * @param {number} [options.timeout=30000] 超时（毫秒）
 * @param {string} [options.cwd] 工作目录
 * @returns {Promise<{code:number|null, stdout:string, stderr:string, timedOut:boolean}>}
 */
export function runCaptured(command, args, options = {}) {
  const { timeout = 30000, cwd } = options;

  const outFile = tmpFile('out');
  const errFile = tmpFile('err');

  const readAndRemove = (file) => {
    try {
      return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    } catch {
      return '';
    } finally {
      try { fs.unlinkSync(file); } catch { /* 忽略 */ }
    }
  };

  // 直接把打开的 fd 作为子进程的 stdout/stderr。
  //
  // 为什么不用 cmd.exe 重定向：Node 在不带 shell 的情况下 spawn cmd.exe 时，
  // 会按 CreateProcess 规则转义参数，导致 cmd /s /c 的引号解析错乱
  //（实测报 "filename, directory name, or volume label syntax is incorrect"）。
  // 直接用 fd 既避开 shell 引用问题，也避开沙箱的管道限制。
  const outFd = fs.openSync(outFile, 'w');
  const errFd = fs.openSync(errFile, 'w');

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        stdio: ['ignore', outFd, errFd],
        windowsHide: true,
        cwd,
      });
    } catch (err) {
      try { fs.closeSync(outFd); } catch { /* 忽略 */ }
      try { fs.closeSync(errFd); } catch { /* 忽略 */ }
      const stdout = readAndRemove(outFile);
      const stderr = readAndRemove(errFile);
      resolve({ code: null, stdout, stderr: stderr + String(err?.message || err), timedOut: false, spawnError: err });
      return;
    }

    // 子进程已继承自己的句柄副本，父进程可以立刻关闭
    try { fs.closeSync(outFd); } catch { /* 忽略 */ }
    try { fs.closeSync(errFd); } catch { /* 忽略 */ }

    let timedOut = false;
    const timer = timeout > 0
      ? setTimeout(() => {
          timedOut = true;
          try { child.kill(); } catch { /* 已退出 */ }
        }, timeout)
      : null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
    };

    const settle = (code) => {
      cleanup();
      // 注意：先读再删，readAndRemove 内部保证顺序
      const stdout = readAndRemove(outFile);
      const stderr = readAndRemove(errFile);
      resolve({ code, stdout, stderr, timedOut });
    };

    child.on('error', () => settle(null));
    child.on('exit', (code) => settle(code));
  });
}

/** 单个日志文件的大小上限：超过则把旧内容挪到 `<path>.old`（仅保留一份）。 */
const LOG_MAX_BYTES = 4 * 1024 * 1024;

/**
 * 打开日志前做体积轮转。
 *
 * 历史缺陷：CLI 录制不带 runDir，日志落到固定路径 `cam-to-bg-recorder.log`
 * 且**永远追加**——每次录制都往上叠，长期使用会无限膨胀吃满磁盘。
 * 这里统一在打开前兜底：超过 4MB 就把旧文件改名为 `.old`（覆盖上一份），
 * 有界即安全（上限 2×4MB）。
 *
 * @param {string} logPath
 * @param {number} [maxBytes]
 * @returns {boolean} 是否发生了轮转
 */
export function rotateLogIfNeeded(logPath, maxBytes = LOG_MAX_BYTES) {
  try {
    if (!logPath || !fs.existsSync(logPath)) return false;
    if (fs.statSync(logPath).size < maxBytes) return false;
    fs.renameSync(logPath, `${logPath}.old`);
    return true;
  } catch {
    return false; // 轮转失败不阻塞启动（日志只是少了上限保证）
  }
}

/**
 * 启动一个长期运行的子进程（ffmpeg / mpv）。
 *
 * 输出默认被重定向到日志文件，既避免管道限制，
 * 也便于在调试时查看编码器/解码器报错。
 *
 * stdinPipe=true 时优先以管道接 stdin（供录制进程接收 'q' 优雅退出）；
 * 受限沙箱会对**任何**管道 stdio 直接抛 EPERM（实测），
 * 此时自动回退为无管道模式——录制仍可工作，只是失去优雅退出通道
 * （分片 MP4 已保证强杀后文件可播，优雅收尾只是"锦上添花"）。
 *
 * @param {string} command
 * @param {string[]} args
 * @param {object} [options]
 * @param {string} [options.logPath] 日志文件路径
 * @param {string} [options.cwd]
 * @param {boolean} [options.stdinPipe=false] 以管道接 stdin
 * @returns {{child: import('node:child_process').ChildProcess, logPath: string|null}}
 */
export function spawnLongRunning(command, args, options = {}) {
  const { logPath = null, cwd, stdinPipe = false } = options;
  if (logPath) rotateLogIfNeeded(logPath); // 打开前轮转，防止无限追加
  const fd = logPath ? fs.openSync(logPath, 'a') : null;

  const spawnWith = (stdio) => {
    const child = spawn(command, args, { stdio, windowsHide: true, cwd });
    // 立即关父进程副本（与 runCaptured 同款）：子进程在 spawn() 内已同步继承句柄。
    // 历史缺陷：once('spawn') 才关 —— spawn **异步失败**（只发 'error' 不发
    // 'spawn'，如命令随后被删/权限变化）时关闭回调永不触发 → 父进程 fd 永久泄漏，
    // 每次失败漏一个，长期运行可耗尽句柄。
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* 忽略 */ } }
    return child;
  };

  const base = fd !== null ? fd : 'ignore';

  if (stdinPipe) {
    try {
      const stdio = ['pipe', fd !== null ? fd : 'ignore', fd !== null ? fd : 'ignore'];
      const child = spawnWith(stdio);
      // 吞掉 stdin 的异步 EPIPE：目标进程可能恰在写 'q' 的同时退出
      //（-t 到点、ffmpeg/mpv 崩溃与停止操作的竞态窗口），流会在 write 之后
      // 异步报 'error'——无监听器的流 error = uncaughtException = 整个应用退出
      if (child.stdin) child.stdin.on('error', () => {});
      return { child, logPath };
    } catch (err) {
      if (fd !== null) { try { fs.closeSync(fd); } catch { /* 忽略 */ } }
      if (!err || (err.code !== 'EPERM' && err.code !== 'EACCES')) throw err;
      // 沙箱限制：落到无管道模式，fd 需要重新打开（上面可能已关）
      const retryFd = logPath ? fs.openSync(logPath, 'a') : null;
      const child = spawn(command, args, {
        stdio: ['ignore', retryFd !== null ? retryFd : 'ignore', retryFd !== null ? retryFd : 'ignore'],
        windowsHide: true, cwd,
      });
      if (retryFd !== null) { try { fs.closeSync(retryFd); } catch { /* 忽略 */ } }
      return { child, logPath };
    }
  }

  if (logPath) return { child: spawnWith([base, base, base]), logPath };
  return { child: spawnWith(['ignore', 'ignore', 'ignore']), logPath: null };
}

/** 读取文件尾部若干字节，用于展示日志。 */
export function readLogTail(logPath, maxBytes = 4000) {
  try {
    if (!logPath || !fs.existsSync(logPath)) return '';
    const stat = fs.statSync(logPath);
    const start = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(logPath, 'r');
    try {
      const buf = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

/**
 * 生成一个日志文件路径。
 *
 * 优先放进指定的运行目录（每次运行的日志归拢到一处，便于排查）；
 * 未指定时回退到系统临时目录（保持向后兼容）。
 *
 * @param {string} tag 日志类别（ffmpeg / mpv / recorder）
 * @param {string|null} [runDir] 运行目录
 */
export function makeLogPath(tag, runDir = null) {
  if (runDir) return path.join(runDir, `${tag}.log`);
  return path.join(os.tmpdir(), `${TMP_PREFIX}-${tag}.log`);
}

/** 定位可执行文件是否存在于 PATH 或给定绝对路径。 */
export function resolveExecutable(nameOrPath) {
  if (!nameOrPath) return null;
  if (path.isAbsolute(nameOrPath)) {
    try { return fs.statSync(nameOrPath).isFile() ? nameOrPath : null; } catch { return null; }
  }
  const exts = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';');
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of ['', ...exts]) {
      const candidate = path.join(dir, nameOrPath + ext);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch { /* 继续找 */ }
    }
  }
  return null;
}
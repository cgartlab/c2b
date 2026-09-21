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

/**
 * 启动一个长期运行的子进程（ffmpeg / mpv）。
 *
 * 输出默认被重定向到日志文件，既避免管道限制，
 * 也便于在调试时查看编码器/解码器报错。
 *
 * @param {string} command
 * @param {string[]} args
 * @param {object} [options]
 * @param {string} [options.logPath] 日志文件路径
 * @param {string} [options.cwd]
 * @returns {{child: import('node:child_process').ChildProcess, logPath: string|null}}
 */
export function spawnLongRunning(command, args, options = {}) {
  const { logPath = null, cwd } = options;

  let stdio;
  if (logPath) {
    // 日志文件用追加模式，保留上一次崩溃的现场
    const fd = fs.openSync(logPath, 'a');
    stdio = ['ignore', fd, fd];
    const child = spawn(command, args, { stdio, windowsHide: true, cwd });
    // 父进程可以立刻关掉自己的 fd 副本，子进程仍持有
    child.once('spawn', () => { try { fs.closeSync(fd); } catch { /* 忽略 */ } });
    return { child, logPath };
  }

  const child = spawn(command, args, { stdio: 'ignore', windowsHide: true, cwd });
  return { child, logPath: null };
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
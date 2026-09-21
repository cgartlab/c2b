/**
 * win32.js — 调用 scripts/win32.ps1 的 Node 桥
 *
 * 两个关键约束（均由本机实测得出）：
 *
 * 1) 必须使用 pwsh (PowerShell 7+)，不能用 powershell.exe (5.1)。
 *    win32.ps1 含中文并以无 BOM 的 UTF-8 保存，PS 5.1 会按 ANSI 解析导致语法错误。
 *
 * 2) 结果通过「临时文件」而非管道传回。
 *    在受限沙箱中，子进程的管道 stdio 会返回 EPERM；
 *    让 ps1 把 JSON 写进临时文件、Node 再读文件，可完全绕开该限制。
 */
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, '..', 'scripts', 'win32.ps1');

/**
 * 定位 PowerShell 7+。
 *
 * 查找顺序（先做无子进程的开销检查，最后才动用外部命令）：
 *   1) 环境变量显式指定
 *   2) 常见安装路径（纯文件系统检查，不需要启动子进程）
 *   3) PATH 查找（用 where.exe；在受限沙箱下会 EPERM，故放在最后且容错）
 *   4) 兜底 powershell.exe（会告警：它无法正确解析本脚本的中文）
 *
 * 早期版本把 PATH 查找放在最前，且未做容错：
 * 在受限环境下 execFileSync 抛 EPERM，会导致模块加载即失败。
 */
function resolvePowerShell() {
  const explicit = process.env.CAM_TO_BG_PWSH;
  if (explicit) return { cmd: explicit, isPwsh: true };

  // 常见安装路径优先：不启动子进程，任何环境下都能用
  const known = [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'PowerShell', '7', 'pwsh.exe'),
  ];
  const found = known.find((p) => {
    try { return fs.statSync(p).isFile(); } catch { return false; }
  });
  if (found) return { cmd: found, isPwsh: true };

  // 再尝试 PATH（可能因沙箱限制失败，失败就跳过）
  for (const name of ['pwsh.exe', 'pwsh']) {
    try {
      const out = execFileSync('where.exe', [name], { encoding: 'utf8', windowsHide: true });
      const first = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
      if (first) return { cmd: first, isPwsh: true };
    } catch { /* 沙箱限制或未安装，继续尝试下一个 */ }
  }

  return { cmd: 'powershell.exe', isPwsh: false };
}

const PS = resolvePowerShell();

export class Win32Error extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'Win32Error';
    this.detail = detail;
  }
}

/** 创建一次性的结果文件路径，位于系统临时目录。 */
function makeResultPath() {
  const name = `cam-to-bg-${process.pid}-${crypto.randomBytes(6).toString('hex')}.json`;
  return path.join(os.tmpdir(), name);
}

/**
 * 执行 win32.ps1 的一个 action。
 * @param {string} action probe | attach | detach | monitors
 * @param {object} [opts] 额外参数，如 { Hwnd: 123 }
 * @returns {Promise<object>} 解析后的 JSON
 */
export function runWin32(action, opts = {}) {
  const resultPath = makeResultPath();

  return new Promise((resolve, reject) => {
    const args = [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File', SCRIPT,
      '-Action', action,
      '-ResultPath', resultPath,
    ];
    for (const [key, value] of Object.entries(opts)) {
      if (key === 'ResultPath') continue;
      args.push(`-${key}`, String(value));
    }

    // 必须用 spawn + stdio:'inherit'。
    // execFile/exec 即使传 stdio:'ignore' 也会在内部建管道，在受限沙箱下抛 EPERM；
    // 只有 spawn 配 'inherit' 可用。结果因此经由 ResultPath 文件回传，不走 stdout。
    const child = spawn(PS.cmd, args, { windowsHide: true, stdio: 'inherit' });

    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 进程可能已退出 */ }
      finish(() => reject(new Win32Error(`win32.ps1 ${action} 超时（20s）`)));
    }, 20000);

    child.on('error', (err) => {
      const hint = PS.isPwsh
        ? ''
        : '\n提示：Win32 桥需要 PowerShell 7+，请安装 pwsh 或设置环境变量 CAM_TO_BG_PWSH';
      finish(() => reject(new Win32Error(`无法启动 ${PS.cmd}: ${err.message}${hint}`, err)));
    });

    child.on('exit', (code) => {
      finish(() => {
        let raw = null;
        try {
          if (fs.existsSync(resultPath)) raw = fs.readFileSync(resultPath, 'utf8');
        } catch {
          // 读取失败走下方统一报错
        } finally {
          try { fs.unlinkSync(resultPath); } catch { /* 清理失败无关紧要 */ }
        }

        if (raw) {
          let parsed;
          try {
            parsed = JSON.parse(raw.trim());
          } catch (parseErr) {
            reject(new Win32Error(`win32.ps1 ${action} 返回的 JSON 无法解析: ${raw.slice(0, 300)}`, parseErr));
            return;
          }
          if (parsed.ok === false) {
            reject(new Win32Error(parsed.error || 'win32.ps1 返回失败'));
            return;
          }
          resolve(parsed);
          return;
        }

        reject(new Win32Error(`win32.ps1 ${action} 未产生结果文件（exit=${code}）`));
      });
    });
  });
}

/** 探测桌面环境（Progman / WorkerW / 显示器）。 */
export async function probeDesktop() {
  const res = await runWin32('probe');
  return {
    progman: res.progman,
    workerWCount: res.workerWCount,
    hasWorkerW: res.hasWorkerW,
    screen: { width: res.screenWidth, height: res.screenHeight },
    host: {
      hwnd: res.hostHwnd,
      mode: res.hostMode,
      width: res.hostWidth,
      height: res.hostHeight,
    },
    monitors: (res.monitors || []).map((m) => ({
      handle: m.handle,
      x: m.left,
      y: m.top,
      width: m.width,
      height: m.height,
      primary: m.primary,
    })),
  };
}

/**
 * 按窗口标题查找顶层窗口句柄。
 * 用于定位 mpv 创建的窗口（其标题由 --title=cam-to-bg 指定）。
 *
 * @param {string} title 精确匹配的窗口标题
 * @returns {Promise<number>} 找到的句柄；未找到返回 0
 */
export async function findWindowByTitle(title) {
  if (!title) return 0;
  try {
    const res = await runWin32('findwindow', { Title: title });
    return res.found ? res.hwnd : 0;
  } catch {
    // 查找失败不应中断主流程：窗口可能还没创建好
    return 0;
  }
}

/**
 * 把窗口挂载为桌面背景。
 *
 * 除了调用 SetParent，还会：
 *   · 校验父子关系是否真的建立（SetParent 可能静默失败）
 *   · 把窗口尺寸设为宿主大小（SetParent 不会自动调整尺寸）
 *
 * @param {number} hwnd 目标窗口句柄（mpv 的 --wid）
 */
export async function attachToDesktop(hwnd) {
  if (!Number.isInteger(hwnd) || hwnd <= 0) {
    throw new Win32Error(`attachToDesktop 需要有效的窗口句柄，收到: ${hwnd}`);
  }
  const res = await runWin32('attach', { Hwnd: hwnd });
  return {
    mode: res.mode,
    host: res.host,
    hostSize: { width: res.hostW, height: res.hostH },
    child: res.child,
    foundWorkerW: res.foundWorkerW,
    parentStuck: res.parentStuck,
    parentBefore: res.parentBefore,
    parentAfter: res.parentAfter,
  };
}

/** 还原窗口（取消父子关系）。 */
export async function detachFromDesktop(hwnd) {
  if (!Number.isInteger(hwnd) || hwnd <= 0) return { skipped: true };
  const res = await runWin32('detach', { Hwnd: hwnd });
  return { child: res.child };
}

/** 列出显示器。 */
export async function listMonitors() {
  const res = await runWin32('monitors');
  return res.monitors || [];
}

export const usingPwsh = PS.isPwsh;
export const powershellPath = PS.cmd;
export const scriptPath = SCRIPT;
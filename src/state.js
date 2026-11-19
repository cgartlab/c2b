/**
 * state.js — 运行状态文件
 *
 * 让 `cam-to-bg status` / `stop` 能在另一个进程里找到正在运行的实例。
 * 由于不能依赖命名管道（沙箱限制），用 JSON 文件共享状态。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runCaptured } from './proc.js';

function stateDir() {
  return process.env.CAM_TO_BG_HOME || path.join(os.homedir(), '.cam-to-bg');
}

export function statePath() {
  return path.join(stateDir(), 'state.json');
}

export function writeState(obj) {
  const file = statePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  // processStartedAt：本进程的创建时刻（绝对时间）。
  // 用于后续验证 pid 是否被系统复用——见 verifyStateProcess。
  const processStartedAt = Number.isFinite(obj.processStartedAt)
    ? obj.processStartedAt
    : Math.round(Date.now() - process.uptime() * 1000);
  fs.writeFileSync(tmp, JSON.stringify({ ...obj, processStartedAt, updatedAt: Date.now() }, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

export function readState() {
  try {
    const file = statePath();
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function clearState() {
  try {
    const file = statePath();
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch { /* 忽略 */ }
}

/** 检查 pid 是否还活着。 */
export function isAlive(pid) {
  if (!pid || !Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** .NET DateTime 的 Unix 纪元偏移（ticks）。 */
const DOTNET_EPOCH_TICKS = 621355968000000000n;

/**
 * 查询进程名（失败返回 null）。
 * 用于杀进程前的复用防护：state 记录的 ffmpeg/mpv pid 若已被复用，
 * 进程名会不匹配——向无辜进程发强杀是不可接受的误伤。
 *
 * @param {number} pid
 * @returns {Promise<string|null>} 如 'ffmpeg' / 'mpv'；查不到返回 null
 */
export async function processName(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const { powershellPath } = await import('./win32.js');
    const r = await runCaptured(powershellPath,
      ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).ProcessName`],
      { timeout: 6000 });
    return r.code === 0 ? String(r.stdout || '').trim() || null : null;
  } catch {
    return null;
  }
}

/**
 * 校验 state 里的 pid 确实还是「我们那个进程」——防 pid 复用误判。
 *
 * 风险场景：实例崩溃/被杀后 state.json 残留；系统把该 pid 分配给**另一个
 * 进程**（开发机上 node 进程频繁启停，复用并不罕见）。此时：
 *   · `c2b start` 会误报"已在运行中"拒绝启动；
 *   · `c2b stop` 会向**无辜进程**发 SIGTERM —— 商用级不可接受的误伤。
 *
 * 验证依据：进程创建时刻是固定绝对量，把 state 里记录的
 * `Date.now() - uptime` 与目标进程真实的 StartTime 对表（±5s 容差）。
 * pid 被复用意味着新进程创建时刻必晚于记录值，一次比对即可识破；
 * 且该量不受之后任何时钟漂移/系统休眠影响（两者都描述同一个创建瞬间）。
 *
 * 降级策略：旧格式 state（无记录）或查询失败（权限/环境）时退化为信任
 * isAlive —— 保持 stop/start 的可用性优先（查询手段对同用户进程始终可用，
 * 失败属异常环境而非复用信号）。
 *
 * @param {object|null} st readState() 的结果
 * @returns {Promise<boolean>}
 */
export async function verifyStateProcess(st) {
  if (!st || !Number.isInteger(st.pid) || st.pid <= 0) return false;
  if (!isAlive(st.pid)) return false;
  if (!Number.isFinite(st.processStartedAt)) return true; // 旧格式：退化信任

  try {
    const { powershellPath } = await import('./win32.js');
    const cmd = `(Get-Process -Id ${st.pid}).StartTime.ToUniversalTime().Ticks`;
    const r = await runCaptured(powershellPath,
      ['-NoProfile', '-NonInteractive', '-Command', cmd], { timeout: 8000 });
    const out = String(r.stdout || '').trim();
    if (r.code !== 0 || !out) return isAlive(st.pid); // 查询失败 → 退化复核存活

    const actual = BigInt(out);
    const expected = BigInt(Math.round(st.processStartedAt)) * 10000n + DOTNET_EPOCH_TICKS;
    const diff = actual > expected ? actual - expected : expected - actual;
    return diff <= 5000n * 10000000n; // 容差 5 秒
  } catch {
    return isAlive(st.pid);
  }
}
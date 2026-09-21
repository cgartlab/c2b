/**
 * state.js — 运行状态文件
 *
 * 让 `cam-to-bg status` / `stop` 能在另一个进程里找到正在运行的实例。
 * 由于不能依赖命名管道（沙箱限制），用 JSON 文件共享状态。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

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
  fs.writeFileSync(tmp, JSON.stringify({ ...obj, updatedAt: Date.now() }, null, 2), 'utf8');
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
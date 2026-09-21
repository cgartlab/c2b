/**
 * runs.js — 运行会话管理
 *
 * 每次 `start` 生成一个专属运行目录（runId = YYYYMMDD_HHMMSS_<pid>）：
 *   <logsDir>/<runId>/
 *     manifest.json   ← 启动快照 + 退出码 + 错误摘要
 *     run.jsonl       ← 结构化日志（由 logger 写入）
 *     ffmpeg.log      ← 子进程日志（由 pipeline 写入）
 *     mpv.log         ← 子进程日志（由 renderer 写入）
 *     recorder.log    ← 子进程日志（由 recorder 写入）
 *
 * 同时维护 <logsDir>/last-run.json，指向最近一次运行，供 status / UI 快速展示。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** 日志根目录：<CAM_TO_BG_HOME>/logs，默认 ~/.cam-to-bg/logs */
export function logsDir() {
  const base = process.env.CAM_TO_BG_HOME || path.join(os.homedir(), '.cam-to-bg');
  return path.join(base, 'logs');
}

/**
 * 生成运行 ID：YYYYMMDD_HHMMSS_<pid>_<rand4>
 *
 * 带随机后缀的原因：秒级精度下，快速连续启动（如用户快速点重启，
 * 或测试脚本循环调用）会在同一秒内产生相同 runId。
 * 若不加随机位，后一次运行会写进前一次的目录，**日志被覆盖**，
 * 正是排查错误时最不希望发生的事。
 */
export function makeRunId(date = new Date(), pid = process.pid) {
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_`
    + `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  const rand = Math.random().toString(16).slice(2, 6);
  return `${stamp}_${pid}_${rand}`;
}

export function runDir(runId) {
  return path.join(logsDir(), runId);
}

/** 读取运行 manifest；不存在或损坏返回 null。 */
export function readRun(runId) {
  try {
    const p = path.join(runDir(runId), 'manifest.json');
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/** 列出所有运行（按 runId 倒序，最新在前）。 */
export function listRuns() {
  try {
    const dir = logsDir();
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'manifest.json')))
      .map((e) => readRun(e.name))
      .filter(Boolean)
      // 按 startedAt 倒序（最新在前）。
      // 注意不能按 runId 字符串排序：runId 带随机后缀，同一秒创建的两次运行
      // 前缀相同、后缀随机，按 runId 排序会让 latestRun() 返回错误的运行。
      .sort((a, b) => {
        const ta = a.startedAt || a.runId;
        const tb = b.startedAt || b.runId;
        const byTime = String(tb).localeCompare(String(ta));
        return byTime !== 0 ? byTime : String(b.runId).localeCompare(String(a.runId));
      })
      // 硬上限保护：即使保留策略被调得很大，单次列表也不读超过 200 个 manifest，
      // 避免日志目录异常膨胀时 CLI/UI 读取放大（内存与耗时）。
      .slice(0, 200);
  } catch {
    return [];
  }
}

/** 最近一次运行。 */
export function latestRun() {
  const runs = listRuns();
  return runs[0] || null;
}

/**
 * 启动一次运行：创建目录、写 manifest（含启动快照）。
 *
 * @param {object} [opts]
 * @param {object} [opts.config] 规范化后的配置快照
 * @param {object} [opts.env] 环境快照（ffmpeg/mpv 路径与版本等）
 * @returns {{runId:string, dir:string, manifestPath:string, manifest:object}}
 */
export function startRun(opts = {}) {
  const { config = {}, env = {} } = opts;
  const runId = makeRunId();
  const dir = runDir(runId);
  fs.mkdirSync(dir, { recursive: true });

  const manifest = {
    runId,
    startedAt: new Date().toISOString(),
    pid: process.pid,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    config: config,
    env: env,
    exitCode: null,
    endedAt: null,
    errorSummary: null,
  };

  const manifestPath = path.join(dir, 'manifest.json');
  writeJson(manifestPath, manifest);
  writeLastRun(manifest);
  return { runId, dir, manifestPath, manifest };
}

/**
 * 结束一次运行：写入退出码与错误摘要，更新 last-run.json。
 */
export function endRun(runId, { exitCode = 0, error = null } = {}) {
  const manifestPath = path.join(runDir(runId), 'manifest.json');
  let manifest = readRun(runId) || { runId, startedAt: new Date().toISOString(), pid: process.pid };
  manifest.exitCode = exitCode;
  manifest.endedAt = new Date().toISOString();
  if (error) {
    manifest.errorSummary = summarizeError(error);
  }
  writeJson(manifestPath, manifest);
  writeLastRun(manifest);
  return manifest;
}

/** 把错误转成可序列化的摘要（含 code/hint/stack）。 */
export function summarizeError(err) {
  if (!err) return null;
  return {
    name: err.name || 'Error',
    message: err.message || String(err),
    code: err.code || null,
    hint: err.hint || null,
    stack: err.stack || null,
    at: new Date().toISOString(),
  };
}

function writeLastRun(manifest) {
  try {
    writeJson(path.join(logsDir(), 'last-run.json'), {
      runId: manifest.runId,
      startedAt: manifest.startedAt,
      endedAt: manifest.endedAt,
      exitCode: manifest.exitCode,
      errorSummary: manifest.errorSummary,
    });
  } catch { /* 忽略 */ }
}

function writeJson(file, obj) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * 清理旧的运行目录，只保留最近 retain 个。
 * 返回删除的目录名数组。
 */
export function cleanupOldRuns(retain = 10) {
  const runs = listRuns();
  const toDelete = runs.slice(retain);
  const removed = [];
  for (const r of toDelete) {
    try {
      fs.rmSync(runDir(r.runId), { recursive: true, force: true });
      removed.push(r.runId);
    } catch { /* 忽略 */ }
  }
  return removed;
}

/** 读取某次运行的 JSONL 日志（原始文本），供 CLI/UI 展示。 */
export function readRunLog(runId, maxBytes = 200000) {
  try {
    const p = path.join(runDir(runId), 'run.jsonl');
    if (!fs.existsSync(p)) return '';
    const stat = fs.statSync(p);
    const start = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(p, 'r');
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

/** 解析 JSONL 为对象数组。 */
export function parseRunLog(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try { return JSON.parse(l); } catch { return { msg: l, level: 'raw' }; }
    });
}
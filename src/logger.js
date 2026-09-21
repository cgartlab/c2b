/**
 * logger.js — 结构化分级日志器
 *
 * 设计目标：
 *   · 每次运行一个 JSONL 日志文件（run.jsonl），同步追加写，崩溃不丢已写内容
 *   · 分级：debug / info / warn / error
 *   · 结构化：{ ts, level, module, msg, ...extra }
 *   · 可选控制台镜像（verbose 时输出）
 *   · 写盘失败绝不抛出 —— 日志机制不能成为新的崩溃源
 *
 * 用法：
 *   import { logger } from './logger.js';
 *   logger.info('wallpaper', '启动完成', { hwnd: 123 });
 *   const log = logger.child('pipeline');
 *   log.error('ffmpeg 异常退出', { code, tail });
 */
import fs from 'node:fs';

export const LOG_LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

/** 判断某级别是否应被输出（threshold 为当前生效级别）。 */
export function shouldLog(level, threshold = 'info') {
  const lv = LOG_LEVELS[level] ?? LOG_LEVELS.info;
  const th = LOG_LEVELS[threshold] ?? LOG_LEVELS.info;
  return lv >= th;
}

/**
 * 创建日志器。
 *
 * @param {object} [opts]
 * @param {string} [opts.logPath] JSONL 输出路径；为空则只走控制台
 * @param {string} [opts.level='info'] 生效级别
 * @param {boolean} [opts.console=false] 是否镜像到控制台
 * @param {string} [opts.module='app'] 默认模块标签
 */
export function createLogger(opts = {}) {
  const { logPath = null, level = 'info', console: toConsole = false, module: defaultModule = 'app' } = opts;

  let buffer = '';
  let logFd = null;
  let writeTimer = null;
  let lastError = null;

  // 缓冲绝对上限：防止极端场景（如 writeSync 持续失败、flush 被延迟）下
  // buffer 无界增长导致内存耗尽。达到上限立即强刷（即使写失败也清空，宁丢不涨）。
  const MAX_BUFFER_BYTES = 1 << 20; // 1 MiB

  function ensureFd() {
    if (logFd !== null || !logPath) return;
    try {
      logFd = fs.openSync(logPath, 'a');
    } catch (err) {
      lastError = err;
      logFd = null; // 打开失败则退化为纯控制台
    }
  }

  function flushLocked() {
    if (!buffer || logFd === null) return;
    try {
      fs.writeSync(logFd, buffer);
      buffer = '';
    } catch (err) {
      lastError = err;
      buffer = '';
    }
  }

  function scheduleFlush() {
    if (writeTimer) return;
    writeTimer = setTimeout(() => {
      writeTimer = null;
      flushLocked();
    }, 300);
    if (writeTimer.unref) writeTimer.unref();
  }

  function writeRecord(rec) {
    ensureFd();
    const line = JSON.stringify(rec) + '\n';
    if (toConsole) {
      const prefix = `[${rec.level.toUpperCase()}]`;
      const who = rec.module ? `(${rec.module})` : '';
      const extra = rec.extra && Object.keys(rec.extra).length
        ? ' ' + JSON.stringify(rec.extra)
        : '';
      if (rec.level === 'error') console.error(`${prefix}${who} ${rec.msg}${extra}`);
      else if (rec.level === 'warn') console.warn(`${prefix}${who} ${rec.msg}${extra}`);
      else console.log(`${prefix}${who} ${rec.msg}${extra}`);
    }

    if (logFd !== null) {
      buffer += line;
      if (rec.level === 'error') flushLocked(); // error 级立即落盘
      else if (Buffer.byteLength(buffer, 'utf8') >= MAX_BUFFER_BYTES) flushLocked(); // 上限保护
      else scheduleFlush();
    }
  }

  function log(level, module, msg, extra = {}) {
    if (!shouldLog(level, currentLevel())) return;
    const rec = {
      ts: new Date().toISOString(),
      level,
      module: module || defaultModule,
      msg: String(msg),
    };
    if (extra && Object.keys(extra).length) rec.extra = extra;
    writeRecord(rec);
  }

  function currentLevel() {
    return level;
  }

  /** 同步把缓冲写入文件并关闭。进程退出前调用。 */
  function close() {
    if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
    flushLocked();
    if (logFd !== null) {
      try { fs.closeSync(logFd); } catch { /* 忽略 */ }
      logFd = null;
    }
  }

  /** 供测试/调试：读取最近一次写盘错误。 */
  function getLastError() { return lastError; }

  const api = {
    debug: (m, x) => log('debug', undefined, m, x),
    info: (m, x) => log('info', undefined, m, x),
    warn: (m, x) => log('warn', undefined, m, x),
    error: (m, x) => log('error', undefined, m, x),
    child(mod) {
      return {
        debug: (m, x) => log('debug', mod, m, x),
        info: (m, x) => log('info', mod, m, x),
        warn: (m, x) => log('warn', mod, m, x),
        error: (m, x) => log('error', mod, m, x),
      };
    },
    close,
    getLastError,
    get level() { return level; },
    get path() { return logPath; },
  };
  return api;
}

/**
 * 全局默认日志器。
 *
 * 应用启动时会通过 configureGlobalLogger() 把它指向本次运行的 run.jsonl。
 * 在未配置前，它只走控制台（保证任何 import 顺序下都有输出）。
 */
let globalLogger = createLogger({ console: true, level: 'info' });

export function configureGlobalLogger(opts) {
  try { globalLogger.close(); } catch { /* 忽略 */ }
  globalLogger = createLogger(opts);
  return globalLogger;
}

export function getLogger() {
  return globalLogger;
}

/**
 * 全局 logger 的活引用。
 *
 * 必须用 Proxy 而非 `export const logger = globalLogger`：
 * `export const` 在模块求值时固定绑定到当时的实例，之后 configureGlobalLogger()
 * 替换了 globalLogger，导出的 logger 仍指向旧的（纯控制台）实例，
 * 导致所有 `logger.info(...)` 写不进运行日志文件。
 * Proxy 把所有属性访问转发到"当前" globalLogger，保证配置后即时生效。
 */
export const logger = new Proxy({}, {
  get(_target, prop) {
    return globalLogger[prop];
  },
  has(_target, prop) {
    return prop in globalLogger;
  },
});
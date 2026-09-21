/**
 * index.js — 程序主入口，把各模块串起来
 */
import { loadConfig, saveConfig, configPath } from './config.js';
import { execFileSync } from 'node:child_process';
import { WallpaperEngine } from './wallpaper.js';
import { UiServer } from './server.js';
import { resolveExecutable } from './proc.js';
import { findMpv } from './renderer.js';
import { CamToBgError, ErrorCodes } from './errors.js';
import { writeState, clearState, readState, isAlive } from './state.js';
import { probeDesktop } from './win32.js';
import { configureGlobalLogger, logger } from './logger.js';
import { startRun, endRun, cleanupOldRuns, logsDir, summarizeError } from './runs.js';

export { loadConfig, saveConfig, configPath };

/** 检查平台与外部依赖。 */
export function checkEnvironment() {
  const problems = [];

  if (process.platform !== 'win32') {
    throw new CamToBgError(`当前仅支持 Windows，检测到平台: ${process.platform}`, {
      code: ErrorCodes.NOT_WINDOWS,
      hint: '本工具依赖 Windows 的 WorkerW 桌面窗口机制。',
    });
  }

  const ffmpegPath = process.env.CAM_TO_BG_FFMPEG || resolveExecutable('ffmpeg');
  if (!ffmpegPath) {
    problems.push('未找到 ffmpeg。请安装并加入 PATH（推荐 winget install Gyan.FFmpeg）。');
  }

  const mpvPath = findMpv();
  if (!mpvPath) {
    problems.push('未找到 mpv。请安装（推荐 winget install mpv.net 或从 mpv.io 下载），'
      + '或用环境变量 CAM_TO_BG_MPV 指定路径。');
  }

  return { ffmpegPath, mpvPath, problems };
}

/**
 * 收集环境快照（写入 manifest，便于事后复现）。
 * 注意：这里只做轻量、不会启动长进程的探测。
 */
async function collectEnvSnapshot(ffmpegPath, mpvPath) {
  const env = {
    ffmpegPath: ffmpegPath || null,
    mpvPath: mpvPath || null,
    camToBgHome: process.env.CAM_TO_BG_HOME || null,
  };
  // ffmpeg 版本（运行捕获，快速）
  try {
    const { runCaptured } = await import('./proc.js');
    const r = await runCaptured(ffmpegPath, ['-hide_banner', '-version'], { timeout: 8000 });
    env.ffmpegVersion = (r.stdout || '').split(/\r?\n/)[0] || null;
  } catch { env.ffmpegVersion = null; }
  // mpv 版本
  try {
    const { runCaptured } = await import('./proc.js');
    const r = await runCaptured(mpvPath, ['--version'], { timeout: 8000 });
    env.mpvVersion = (r.stdout || '').split(/\r?\n/)[0] || null;
  } catch { env.mpvVersion = null; }
  // 桌面探测结果（尽力而为）
  try {
    const d = await probeDesktop();
    env.desktop = {
      progman: d.progman,
      workerWCount: d.workerWCount,
      screen: d.screen,
      host: d.host,
      monitors: d.monitors.length,
    };
  } catch { env.desktop = null; }
  return env;
}

/**
 * 注册进程级错误钩子，全部落盘到当前运行日志。
 * 只在 `start`（长驻服务）时注册；一次性命令（stop/status/logs）不注册。
 */
export function registerCrashHooks(runId, { onFatal } = {}) {
  process.on('uncaughtException', (err) => {
    try {
      logger.error('未捕获异常', summarizeError(err));
    } catch { /* 忽略 */ }
    try { endRun(runId, { exitCode: 1, error: err }); } catch { /* 忽略 */ }
    try { logger.close(); } catch { /* 忽略 */ }
    if (typeof onFatal === 'function') onFatal(err);
  });

  process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    try {
      logger.error('未处理的 Promise 拒绝', summarizeError(err));
    } catch { /* 忽略 */ }
  });

  process.on('exit', (code) => {
    try { endRun(runId, { exitCode: code }); } catch { /* 忽略 */ }
    try { logger.close(); } catch { /* 忽略 */ }
  });

  process.on('SIGINT', () => {
    try { logger.info('收到 SIGINT，准备退出'); } catch { /* 忽略 */ }
  });
  process.on('SIGTERM', () => {
    try { logger.info('收到 SIGTERM，准备退出'); } catch { /* 忽略 */ }
  });
}

/**
 * 创建并启动整套服务。
 * @param {object} [options]
 * @param {boolean} [options.openUi=false] 是否启动设置界面服务
 * @param {boolean} [options.verbose=false] 是否把日志镜像到控制台
 */
export async function createApp(options = {}) {
  const { openUi = false, verbose = false } = options;

  const env = checkEnvironment();
  if (env.problems.length) {
    throw new CamToBgError('运行环境不满足要求', {
      code: ErrorCodes.BINARY_MISSING,
      hint: env.problems.join('\n      '),
    });
  }

  const { config, warnings } = loadConfig();

  // ── 运行会话：创建目录、配置全局 logger、写启动快照 ──
  const envSnapshot = await collectEnvSnapshot(env.ffmpegPath, env.mpvPath);
  const run = startRun({ config, env: envSnapshot });
  configureGlobalLogger({
    logPath: `${run.dir}/run.jsonl`,
    level: config.logLevel || 'info',
    console: verbose,
    module: 'app',
  });
  // 长驻服务才注册进程级崩溃钩子（一次性命令 stop/status/logs 不注册）
  registerCrashHooks(run.runId);
  for (const w of warnings) logger.warn(`配置告警: ${w}`);
  logger.info(`运行开始 runId=${run.runId} 目录=${run.dir}`);
  logger.info(`环境: node=${process.version} platform=${process.platform} ffmpeg=${envSnapshot.ffmpegVersion || '?'} mpv=${envSnapshot.mpvVersion || '?'}`);

  // 清理旧运行（保留策略）
  const retain = Math.max(1, Number(config.logRetainRuns) || 10);
  const removed = cleanupOldRuns(retain);
  if (removed.length) logger.debug(`清理旧运行日志: ${removed.join(', ')}`);

  const engine = new WallpaperEngine({
    ffmpegPath: env.ffmpegPath,
    mpvPath: env.mpvPath,
    config,
    runDir: run.dir,
  });

  // 引擎日志 → logger（落盘）+ UI
  engine.on('log', (m) => {
    logger.info(m);
  });

  let currentConfig = config;
  let ui = null;

  const getConfig = () => currentConfig;
  const onConfigChange = async (next) => {
    // 记录配置变更（旧值 → 新值），便于回溯
    const changedKeys = Object.keys(next).filter((k) => currentConfig[k] !== next[k]);
    if (changedKeys.length) {
      const diff = {};
      for (const k of changedKeys) diff[k] = { from: currentConfig[k], to: next[k] };
      logger.info('配置变更', { diff });
    }
    const mode = engine.state === 'running'
      ? await engine.applyConfig(next)
      : { mode: 'none' };
    currentConfig = next;
    saveConfig(next);
    return mode;
  };

  if (openUi) {
    ui = new UiServer({
      engine,
      getConfig,
      onConfigChange,
      port: config.uiPort,
      run,
    });
    engine.on('log', (m) => ui.pushLog(m));
  }

  return {
    engine,
    getConfig,
    get ui() { return ui; },
    get run() { return run; },

    /** 启动壁纸；如启用界面则一并启动 HTTP 服务。 */
    async start() {
      let uiInfo = null;
      if (ui) {
        uiInfo = await ui.listen();
        logger.info(`设置界面: ${uiInfo.url}`);
      }

      const status = await engine.start();

      // 供 status / stop 命令在别的进程中读取。
      const writeCurrentState = () => {
        const ffmpegPid = engine.pipeline?.child?.pid;
        const mpvPid = engine.renderer?.child?.pid;
        writeState({
          pid: process.pid,
          uiPort: uiInfo?.port ?? null,
          uiUrl: uiInfo?.url ?? null,
          device: status.device,
          encoder: status.encoder?.name ?? null,
          startedAt: Date.now(),
          runId: run.runId,
          children: {
            ffmpeg: Number.isInteger(ffmpegPid) ? ffmpegPid : null,
            mpv: Number.isInteger(mpvPid) ? mpvPid : null,
          },
        });
      };

      writeCurrentState();

      engine.on('pipeline-exit', writeCurrentState);
      engine.on('renderer-exit', writeCurrentState);
      engine.on('started', writeCurrentState);

      return { status, ui: uiInfo };
    },

    async stop() {
      await engine.stop();
      if (ui) await ui.close();
      clearState();
      try { endRun(run.runId, { exitCode: 0 }); } catch { /* 忽略 */ }
      try { logger.close(); } catch { /* 忽略 */ }
    },

    /**
     * 同步强杀所有子进程（含录制进程）。
     * 供 CLI 的 SIGTERM/exit 兜底路径使用。
     */
    killChildrenSync() {
      try { engine.killChildrenSync(); } catch { /* 忽略 */ }
      try {
        const rec = ui?.recorder;
        if (rec?.child?.pid) {
          execFileSync('taskkill', ['/PID', String(rec.child.pid), '/T', '/F'], {
            stdio: 'ignore', windowsHide: true, timeout: 5000,
          });
        }
      } catch { /* 忽略 */ }
    },

    /** 保持进程存活直到收到退出信号。 */
    async waitForever() {
      await new Promise((resolve) => {
        const done = () => resolve();
        process.once('SIGINT', done);
        process.once('SIGTERM', done);
      });
    },
  };
}

/** 查询是否有实例在运行。 */
export function lookupRunningInstance() {
  const st = readState();
  if (!st) return null;
  if (!isAlive(st.pid)) return null;
  return st;
}

export { probeDesktop, logsDir };

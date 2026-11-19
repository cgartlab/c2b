/**
 * index.js — 程序主入口，把各模块串起来
 */
import { loadConfig, saveConfig, configPath } from './config.js';
import { execFileSync } from 'node:child_process';
import net from 'node:net';
import { WallpaperEngine } from './wallpaper.js';
import { UiServer } from './server.js';
import { resolveExecutable } from './proc.js';
import { findMpv } from './renderer.js';
import { CamToBgError, ErrorCodes } from './errors.js';
import { writeState, clearState, readState, isAlive, verifyStateProcess } from './state.js';
import { probeDesktop } from './win32.js';
import { configureGlobalLogger, logger, getLogger } from './logger.js';
import { startRun, endRun, cleanupOldRuns, logsDir, summarizeError } from './runs.js';

export { loadConfig, saveConfig, configPath };

/**
 * 把副作用型事件回调包成不冒泡的处理器。
 *
 * 背景：`writeState`（mkdir/write/rename，无内部兜底）在磁盘满/权限拒时会抛错。
 * 作为 `engine.on('pipeline-exit')` 这类处理器，抛错会沿 emit 链
 * （child.on('exit')→_classifyExit→emit→_onPipelineCrash→emit→本处理器）
 * 一路冒到顶层 → uncaughtException → CLI 兜底 `app.stop()+exit` ——
 * **崩溃恢复路径本身把应用打挂**。状态刷新是副作用：失败只影响外部
 * `c2b status/stop` 的可见性，绝不应关停核心。
 *
 * @template {(...a:any[])=>any} F
 * @param {F} fn
 * @returns {(...a:Parameters<F>)=>ReturnType<F>|undefined}
 */
export function safeEventHandler(fn) {
  // 普通函数（非箭头）以持有自己的 this，并 fn.apply(this) 透传 —— 作为
  // EventEmitter 处理器必须完全透明（参数 / 返回值 / this=emitter）。
  return function (...args) {
    try { return fn.apply(this, args); } catch { return undefined; }
  };
}

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
    // onFatal 是调用方注入的回调：即便当前无人传入（死参数），也按最后一道
    // 防线的标准兜底 —— 它若抛错会连累 uncaughtException 处理器自身，
    // 让 Node 打出"处理器运行中再抛"的二次异常。
    if (typeof onFatal === 'function') { try { onFatal(err); } catch { /* 忽略 */ } }
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

    // uiPort 热切换（历史缺陷：改端口只提示"需重启"、重启也不换端口 = 假选项）。
    //
    // ⚠️ 必须**在本次响应发出之后**再真正 relisten：onConfigChange 在
    // _updateConfig 内被 await，若此处同步关闭旧监听，**进行中的这次响应
    // socket 会被销毁** → 界面看到"保存失败"（其实已成功），并触发
    // "保留编辑→重试"逻辑对已死端口无限重试刷 toast（第 27 轮真机实证的故障链）。
    //
    // 因此两段式：
    //   1) 同步预检新端口（占用 → 立即回退并如实报告；此刻旧监听未动、响应完好）
    //   2) 600ms 后（响应已写出）执行真正 relisten；失败属预检-实占的极小竞争窗口，
    //      回退配置保证"配置值与实际监听一致"（界面探测不到新端口会留在旧页自动恢复）
    let portError = null;
    const oldPort = currentConfig.uiPort;
    const wantPort = Number(next.uiPort);
    if (ui && wantPort !== Number(oldPort)) {
      const probeSrv = net.createServer();
      try {
        await new Promise((resolve, reject) => {
          probeSrv.once('error', reject);
          probeSrv.listen(wantPort, '127.0.0.1', resolve);
        });
        probeSrv.close();
      } catch (err) {
        try { probeSrv.close(); } catch { /* ignore */ }
        portError = `端口 ${wantPort} 不可用（${err?.code || err?.message || err}）`;
        logger.warn('切换设置界面端口失败（预检未通过），已回退', { error: portError });
        next = { ...next, uiPort: oldPort };
      }
      if (!portError) {
        // 立即通告已打开的界面：**CLI 发起的**端口切换（c2b set uiPort=X）不会给
        // 某个界面页 save 响应 —— 若不广播，界面页的 WS 被 relisten 掐断后会
        // 永久重连已关闭的旧端口（"连接断开、重连中…"搁浅，界面无周期 HTTP 可发现端口已变）。
        // 必须在 relisten（600ms 后）之前发：此刻旧端口 WS 仍存活。
        try { ui.broadcast({ type: 'port-switch', port: wantPort }); } catch { /* 忽略 */ }
        setTimeout(() => {
          ui.relisten(wantPort)
            .then((info) => logger.info('设置界面已切换端口（响应送达后执行）', { url: info.url }))
            .catch((err) => {
              logger.warn('延迟切换端口失败，配置已回退', { error: err.message });
              currentConfig.uiPort = oldPort;
              try { saveConfig(currentConfig); } catch { /* ignore */ }
            });
        }, 600);
      }
    }

    // 即时生效类配置：变更时直接应用，不再假装"需重启"。
    // 历史缺陷：logLevel/logRetainRuns 标着 restart:true，却既不在 applyConfig
    // 分类里（不弹提示）、重启按钮又不会重建 logger / 执行清理 —— 永久静默失效。
    //
    // ⚠️ 顺序：确认日志必须在 setLevel **之前**发出 —— 否则把级别切到
    // error/warn 时，"日志级别即将切换"这条确认消息会被新级别自己吞掉
    //（第 10 轮接线的自吞缺陷，第 11 轮修正并由真机冒烟固化）。
    if (Number(next.logRetainRuns) !== Number(currentConfig.logRetainRuns)) {
      try {
        const retainNow = Math.max(1, Number(next.logRetainRuns) || 10);
        const removedNow = cleanupOldRuns(retainNow);
        logger.info('保留运行数已即时生效', { retain: retainNow, removed: removedNow.length });
      } catch (err) {
        logger.warn('按新保留数清理失败', { error: err.message });
      }
    }
    if (next.logLevel !== currentConfig.logLevel) {
      logger.info('日志级别即将切换', { from: currentConfig.logLevel, to: next.logLevel });
      try { getLogger().setLevel?.(next.logLevel); } catch { /* 忽略 */ }
    }

    const mode = engine.state === 'running'
      ? await engine.applyConfig(next)
      : { mode: 'none' };
    currentConfig = next;
    saveConfig(next);

    // 同步最终配置给已开界面：**CLI 发起的**变更（c2b set）没有某个界面页的
    // save 响应可依据 —— 不广播则界面表单停留在旧值，用户被误导"改了没生效"。
    //（数据层无害：flush 只发 pending 键、服务端 merge；但显示必须准确。）
    // 广播最终 config（含端口回退等此前的修正），由界面自行 diff 出变化键。
    try { ui?.broadcast({ type: 'config', config: currentConfig }); } catch { /* 忽略 */ }

    if (portError) {
      // 覆盖 mode 但保留引擎侧信息（如 pendingKeys），界面两者都展示
      return { ...mode, mode: 'ui-port-failed', error: portError };
    }
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

  /**
   * 完整优雅停止（UI 按钮、HTTP action 与外部 cam-to-bg stop 共用同一路径）。
   */
  const doStop = async () => {
    await engine.stop();
    if (ui) await ui.close();
    clearState();
    try { endRun(run.runId, { exitCode: 0 }); } catch { /* 忽略 */ }
    try { logger.close(); } catch { /* 忽略 */ }
  };

  // HTTP 优雅关停（供外部 cam-to-bg stop 使用）。
  // Windows 上跨进程 kill('SIGTERM') 是**无条件 TerminateProcess**——目标进程
  // 注册的信号处理器根本不会执行，进程内优雅路径（桌面还原 / 录制 stdin-q 封尾 /
  // 清单收尾 / 日志 close 落盘）永远不会被触发。让进程自己走 doStop 再退出是唯一正解。
  if (ui) {
    ui.onShutdown = async () => {
      const watchdog = setTimeout(() => { try { process.exit(0); } catch { /* 忽略 */ } }, 8000);
      try { await doStop(); } catch { /* 尽力而为，看门狗兜底 */ }
      clearTimeout(watchdog);
      // 给已写出的响应与日志一点落地时间，再结束进程
      setTimeout(() => { try { process.exit(0); } catch { /* 忽略 */ } }, 60);
    };
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

      writeCurrentState(); // 初次写入：失败让 start 如实报错（不写状态 → c2b stop 找不到 → 孤儿）

      // 事件驱动的状态刷新：包 safeEventHandler —— writeState 磁盘满抛错不得沿
      // emit 链冒到顶层打挂应用（详见 safeEventHandler 注释）。
      engine.on('pipeline-exit', safeEventHandler(writeCurrentState));
      engine.on('renderer-exit', safeEventHandler(writeCurrentState));
      engine.on('started', safeEventHandler(writeCurrentState));

      return { status, ui: uiInfo };
    },

    stop: doStop,

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
/**
 * 查询正在运行的实例。
 * 用 verifyStateProcess 而非裸 isAlive：pid 可能被系统复用给无关进程，
 * 误判会让 `c2b start` 拒绝启动、`c2b stop` 误杀无辜（见 state.js 注释）。
 */
export async function lookupRunningInstance() {
  const st = readState();
  if (!st) return null;
  if (!(await verifyStateProcess(st))) return null;
  return st;
}

export { probeDesktop, logsDir };

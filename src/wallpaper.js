/**
 * wallpaper.js — 把视频窗口变成桌面壁纸的总控
 *
 * 流程：
 *   1. 探测桌面（Progman / WorkerW / 显示器尺寸）
 *   2. 启动 mpv，让它把画面渲染进一个由我们指定的窗口
 *   3. 用 SetParent 把该窗口挂到桌面「壁纸层」WorkerW 之下
 *   4. 退出时把窗口摘下来，避免留下孤儿窗口
 *
 * 这里的每一步都已在本机实测（见 README 的验证记录）。
 */
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { probeDesktop, attachToDesktop } from './win32.js';
import { Pipeline } from './pipeline.js';
import { Renderer } from './renderer.js';
import { selectEncoder } from './encoder-probe.js';
import { requireVideoDevice } from './devices.js';
import { buildFilterChain } from './filters.js';
import { CamToBgError, ErrorCodes } from './errors.js';

/**
 * 清扫历史崩溃遗留的 sendcmd 命令文件。
 *
 * 进程崩溃时 _teardown 不会执行，%TEMP% 里的 cam-to-bg-cmd-*.txt
 * 会永久残留（每次崩溃漏一个，长期膨胀）。CLI start 会拒绝第二实例，
 * 因此启动时见到的同前缀文件（含 .tmp）必属历史遗留，可安全删除。
 *
 * @param {string} [dir] 目标目录（默认系统临时目录）
 * @returns {string[]} 被删除的文件名
 */
export function sweepStaleCmdFiles(dir) {
  const base = dir || os.tmpdir();
  const removed = [];
  try {
    for (const name of fs.readdirSync(base)) {
      if (!name.startsWith('cam-to-bg-cmd-')) continue;
      try {
        fs.unlinkSync(path.join(base, name));
        removed.push(name);
      } catch { /* 被占用等：跳过，下次再清 */ }
    }
  } catch { /* 目录不可读：忽略 */ }
  return removed;
}

/**
 * applyConfig 的参数分类 —— **单一事实源**。
 *
 * schema 的 `restart` 标记必须与这里严格等价（test/wallpaper.test.js 有双向
 * 等价性测试强制），否则会出现两类"说谎"：
 *   · 标了 restart 却不在分类里 → UI 显示"需重启"、既不弹提示、点了重启也不生效（静默失效）
 *   · 在分类里却 restart:false → 弹了重启提示、字段却不带"需重启"标记（提示无来源）
 */
export const COLOR_KEYS = ['brightness', 'contrast', 'saturation', 'gamma', 'exposure', 'temperature', 'hue'];
export const GEOMETRY_KEYS = ['flipHorizontal', 'flipVertical', 'rotate', 'scaleMode'];
export const STRUCTURE_KEYS = [
  'width', 'height', 'fps', 'device', 'monitor', 'encoder', 'latencyMode',
  'bitrate', 'quality',
];

/**
 * 由桌面探测结果 + monitor 配置解析**编码器实际输入**的输出目标分辨率。
 *
 * 关键工况事实：滤镜链无条件 `scale→target`（屏幕分辨率），编码器处理的是
 * 缩放**后**的帧，而非摄像头采集分辨率（cfg.width/height）。因此编码器探测
 * 必须按 target 工况——否则摄像头 < 屏幕时"按采集分辨率探测通过、
 * 实际按屏幕分辨率启动失败"（与录制路径同源的工况脱节）。
 *
 * 壁纸启动与 `c2b probe` 必须共用本函数，否则 probe 结论 ≠ 启动所用
 * （显示器选择逻辑漂移 → 缓存签名也不同）。
 *
 * @param {{monitors?:Array<{width:number,height:number,primary?:boolean}>}} desktop probeDesktop 结果
 * @param {number|string} monitorIdx cfg.monitor（显示器序号）
 * @param {{width:number,height:number}} fallback 探测失败时的回退尺寸
 * @returns {{width:number,height:number,monitor:object|null}}
 */
export function resolveOutputTarget(desktop, monitorIdx, fallback) {
  const raw = desktop?.monitors || [];
  // 主屏必须固定在下标 0：SCHEMA 契约 "monitor 0=主显示器"，而
  // EnumDisplayMonitors 的枚举顺序**不保证主屏在首位**也不稳定。
  // 不排序则默认 monitor:0 会落到"枚举到的第一个"（可能是副屏）→ 输出画幅
  // 用副屏分辨率缩放、壁纸却固定挂主屏 → 尺寸/比例不匹配。
  // Array.sort 稳定：副屏组保持原有枚举相对顺序。
  const monitors = raw.slice().sort((a, b) => (a.primary ? 0 : 1) - (b.primary ? 0 : 1));
  const idx = Number(monitorIdx) || 0;
  const mon = monitors[idx] || monitors.find((m) => m.primary) || monitors[0];
  if (mon) return { width: mon.width, height: mon.height, monitor: mon };
  return { width: fallback.width, height: fallback.height, monitor: null };
}

export class WallpaperEngine extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.ffmpegPath
   * @param {string} opts.mpvPath
   * @param {object} opts.config
   * @param {string|null} [opts.runDir] 本次运行的日志目录（子进程日志归拢到这里）
   */
  constructor({ ffmpegPath, mpvPath, config, runDir = null }) {
    super();
    this.ffmpegPath = ffmpegPath;
    this.mpvPath = mpvPath;
    this.config = config;
    this.runDir = runDir;
    /**
     * 用户"请求"的配置（原样保存）。
     *
     * 为什么需要它：启动时会与摄像头协商采集分辨率，
     * 协商结果会改写 this.config（例如用户要 1920x1080，设备只支持 2560x1440）。
     * 若用 this.config 作为比较基准，之后任何界面改动都会被误判成
     * "分辨率变了"而触发整条管线重启。
     * 因此判断是否需要重启时，一律与这份未被改写的基准比较。
     */
    this.requestedConfig = { ...config };

    /** 与摄像头协商后实际生效的采集格式（可能与用户请求不同）。 */
    this.effectiveCapture = null;

    /**
     * 上一次下发给 ffmpeg 的**用户原始采集意图**（raw，非协商结果）。
     * 重启时判断"用户到底改没改采集参数"必须拿它当基准：
     * 协商过的设备 effectiveCapture 与 requested 天然不等，
     * 拿 effective 比会把每次重启都误判成"用户改了"→ 回退到设备不支持的
     * 原始值 → 重启永远失败（真实缺陷，见 restart() 注释）。
     */
    this._lastRequestedCapture = null;

    /**
     * sendcmd 命令文件。
     *
     * ffmpeg 启动时用 sendcmd=f=<文件名> 从这个文件读取色彩参数，
     * 运行期改色彩/曝光/色温/色相时只写这个文件，ffmpeg 下一帧自动应用，
     * 不需要重启——这是避免"停旧起新 ffmpeg 冲突导致死机"的核心设计。
     *
     * 三个字段的分工：
     *   cmdFilePath —— 完整路径，Node 读写文件用
     *   cmdFileName —— 纯文件名，传给 ffmpeg（绝对路径的冒号会破坏滤镜解析）
     *   cmdDir      —— 文件所在目录，作为 ffmpeg 的工作目录
     */
    this.cmdFilePath = null;
    this.cmdFileName = null;
    this.cmdDir = null;

    this.pipeline = null;
    this.renderer = null;
    this.encoder = null;
    this.device = null;
    this.desktop = null;
    this.mpvHwnd = 0;
    this.attached = false;
    this.startedAt = null;
    this.state = 'idle'; // idle | starting | running | stopped | error

    // 退出时务必还原桌面，避免留下挂着的孤儿窗口
    this._cleanupBound = false;
  }

  _log(msg) {
    this.emit('log', msg);
  }

  /** 计算目标输出分辨率（取选中显示器的分辨率）。 */
  _resolveTarget() {
    return resolveOutputTarget(this.desktop, this.config.monitor, {
      width: this.config.width, height: this.config.height,
    });
  }

  /**
   * 拉起一条完整的管线（ffmpeg + mpv + 桌面挂载）。
   *
   * 这是 start() 与 restart() 共用的核心。把它抽出来，
   * restart() 才能实现"先建新、再拆旧"——起新实例时旧的可能还挂着。
   *
   * @param {object} [overrides] 可选的临时配置覆盖（用于重启时传入新参数）
   * @returns {Promise<object>} status 快照
   */
  async _bringUp() {
    // 1) 桌面环境
    this._log('探测桌面环境…');
    this.desktop = await probeDesktop();
    this._log(`Progman=${this.desktop.progman} WorkerW数量=${this.desktop.workerWCount} 屏幕=${this.desktop.screen.width}x${this.desktop.screen.height}`);

    if (!this.desktop.hasWorkerW && !this.desktop.progman) {
      throw new CamToBgError('无法定位桌面窗口（Progman/WorkerW 均不可用）', {
        code: ErrorCodes.DESKTOP_ATTACH_FAILED,
        hint: '请确认 explorer.exe 正在运行，且当前处于正常的交互式桌面会话（非服务会话）。',
      });
    }

    const target = this._resolveTarget();
    this._log(`输出分辨率 ${target.width}x${target.height}`);

    // 2) 摄像头
    this._log('查找摄像头…');
    this.device = await requireVideoDevice(this.ffmpegPath, this.config.device);
    if (this.device.fallbackFrom) {
      this._log(`注意：未找到指定摄像头「${this.device.fallbackFrom}」，改用「${this.device.name}」`);
    }
    this._log(`使用摄像头: ${this.device.name}`);

    // 2.5) 协商采集分辨率
    // 摄像头往往只支持固定的几种分辨率/帧率。若直接使用用户设定的值，
    // dshow 会报 "Could not set video options" 而整个管线启动失败。
    // 因此这里先问设备支持什么，再挑一个最接近的。
    await this._negotiateCaptureFormat();
    // 记录本轮的原始采集意图（重启判断"用户是否改参数"的基准）
    this._lastRequestedCapture = {
      width: this.config.width, height: this.config.height, fps: this.config.fps,
    };

    // 3) 编码器（已探测过则复用，避免每次重启都重新实测）
    if (!this.encoder) {
      this._log('探测硬件编码器…');
      const prefer = this.config.encoder && this.config.encoder !== 'auto'
        ? this.config.encoder
        : undefined;
      // 关键：**用户指定的编码器也要真实测试**（历史缺陷：直接 find 后使用、
      // 跳过实测，坏了只能整条管线报错，也没有回退）。
      // 工况按 **target（滤镜链缩放后的屏幕分辨率）**——编码器实际输入的是
      // scale 后的帧，非摄像头采集分辨率；按采集分辨率探测会"小尺寸通过、
      // 实际屏幕分辨率启动失败"（同录制路径的工况脱节）。
      const r = await selectEncoder(this.ffmpegPath, {
        prefer,
        onLog: (m) => this._log(m),
        width: target.width,
        height: target.height,
        bitrate: this.config.bitrate,
      });
      this.encoder = r.encoder;
    }
    this._log(`编码器: ${this.encoder.name} (${this.encoder.label})`);

    // 3.5) 创建 sendcmd 命令文件，写入当前色彩参数
    //      ffmpeg 启动时通过 sendcmd=f=<路径> 读取此文件，
    //      运行期改色彩参数只更新这个文件，不重启 ffmpeg
    //      （先清扫历史崩溃遗留的旧文件，见 sweepStaleCmdFiles）
    const swept = sweepStaleCmdFiles();
    if (swept.length) this._log(`清理遗留 sendcmd 文件 ${swept.length} 个`);
    this.cmdFilePath = await this._writeCmdFile();

    // 4) 先起 ffmpeg（它负责监听端口），再起 mpv 去连
    this.pipeline = new Pipeline({
      ffmpegPath: this.ffmpegPath,
      config: this._pipelineConfig(),
      encoder: this.encoder,
      deviceName: this.device.openAs || this.device.name,
      deviceLabel: this.device.name,
      target,
      cmdFileName: this.cmdFileName,
      cmdDir: this.cmdDir,
      runDir: this.runDir,
    });
    this.pipeline.on('log', (m) => this._log(m));
    this.pipeline.on('exit', (info) => this._onPipelineCrash(info));

    this._log('启动 ffmpeg 采集与编码…');
    const { url } = await this.pipeline.start();
    this._log(`视频流地址: ${url}`);
    // 5) mpv 渲染并嵌入桌面（不与 ffmpeg 自检窗并行：就绪探测三难实测
    //    见 pipeline.start 注释——连接即死/只读探测不可靠/mpv 无重试）
    await this._startRenderer(url);

    // 取 mpv 的窗口句柄：mpv 用 --wid=0 时会创建自己的窗口，
    // 需要由 PowerShell 按窗口标题找到它。
    this._log('定位 mpv 窗口…');
    this.mpvHwnd = await this._findMpvWindow();

    if (this.mpvHwnd) {
      this._log(`挂载到桌面 (hwnd=${this.mpvHwnd})…`);
      const res = await attachToDesktop(this.mpvHwnd);
      this.attached = true;
      this._log(`挂载完成，模式=${res.mode}`);
      this._warnAttachMode(res.mode);
    } else {
      // 定位失败绝不能继续：未挂载的 mpv 是一个裸浮在桌面前面的顶层窗口，
      // 用户只能手动去关。宁可启动失败，也不留浮窗。
      throw new CamToBgError('未能定位 mpv 窗口，放弃挂载', {
        code: ErrorCodes.RENDER_FAILED,
        hint: 'mpv 可能未成功创建窗口，详情见 mpv 日志。',
      });
    }

    // 存活终检：找窗口/挂载的秒级窗口里任一侧死掉都不能宣布成功，
    // 否则 state=running 说谎（崩溃已在 _onXxxCrash 记录，但状态需一致）
    this._assertBringUpAlive();

    this.startedAt = Date.now();
    return this.status();
  }

  async start() {
    if (this.state === 'running') return this.status();
    // 并发守卫：启动/重启流程进行中禁止再次 start。
    // 摄像头是排他资源，并发 bring-up 会互相抢设备、堆积僵死 ffmpeg
    //（与 restart 的 409 守卫同族；历史上 start 无守卫，可从状态机绕过）。
    if (this.state === 'starting' || this.state === 'restarting') {
      throw new CamToBgError(
        `引擎正在${this.state === 'starting' ? '启动' : '重启'}，不能并发启动`,
        { code: ErrorCodes.BUSY, hint: '请等待当前流程结束后再操作。' },
      );
    }
    this.state = 'starting';
    this._bindCleanup();

    // 异常残留清理：error 态下旧 mpv/管线可能还活着（崩溃留下的现场），
    // 若不先清，_bringUp 会直接覆盖引用把它变成孤儿浮窗
    // ——正是"重启遗留 mpv"的同族缺陷，这里统一收敛。
    if (this.renderer || this.pipeline || this.attached) {
      this._log('清理上一轮残留进程…');
      await this._teardown();
    }

    try {
      const st = await this._bringUp();
      this.state = 'running';
      this.emit('started', st);
      return st;
    } catch (err) {
      this.state = 'error';
      await this._teardown();
      throw err;
    }
  }

  /**
   * 挂载结果的用户可见告警。
   *
   * 历史缺陷：旧代码检查 `progman-fallback` —— win32.ps1 的 attach **从不返回**
   * 该模式（实际返回 workerw / progman / workerw-small），是永不触发的死分支；
   * 而真正危险的 `workerw-small`（把视频挂到 136×39 的 helper 窗口 →
   * 被裁成近乎不可见的一小块，README"踩坑记录1"明确记载）反而没有任何告警，
   * 用户只看到"挂载完成"却找不到画面。
   *
   * - `workerw-small`：必须警告并给出处置建议
   * - `progman`：Win11 实测的标准路径，正常无需告警
   * - `workerw`：Win10 经典路径，正常
   *
   * @param {string} mode win32.ps1 attach 返回的模式
   */
  _warnAttachMode(mode) {
    if (mode === 'workerw-small') {
      this._log('警告：只找到小尺寸 WorkerW 宿主，壁纸会被裁成一小块（近乎不可见）。'
        + '请重启 explorer.exe 后再点「重启」重试。');
    }
  }

  /**
   * 与摄像头协商采集格式。
   *
   * dshow 对不支持的 video_size/framerate 组合会直接报错，
   * 因此先读取设备支持的格式列表，挑选最接近用户设定的一组。
   * 若设备不支持查询（如被占用），则保持用户设定不变，让后续流程报出更明确的错误。
   */
  async _negotiateCaptureFormat() {
    const { probeDeviceFormats, pickBestFormat } = await import('./devices.js');
    const wanted = {
      width: Number(this.config.width) || 1920,
      height: Number(this.config.height) || 1080,
      fps: Number(this.config.fps) || 30,
    };

    let formats = [];
    try {
      // 用 openAs（重名设备为备用名）查询：按显示名查询会命中歧义的第一个
      formats = await probeDeviceFormats(this.ffmpegPath, this.device.openAs || this.device.name);
    } catch {
      formats = [];
    }

    if (!formats.length) {
      this._log('无法读取摄像头支持的格式（设备可能被占用），按配置值尝试。');
      return { negotiated: false };
    }

    // 完全匹配就无需改动（帧率可能是 29.97 这类非整数，用容差比较）
    const exact = formats.find(
      (f) => f.width === wanted.width
        && f.height === wanted.height
        && Math.abs(f.fps - wanted.fps) < 0.5,
    );
    if (exact) {
      // 必须记录 effectiveCapture：精确命中也可能与请求值有微差
      //（设备报 29.97、用户请求 30）——不记的话 ffmpeg 会按请求值 30 去
      // dshow 匹配模式，匹配不到直接启动失败；记下则按设备原生值下发。
      this.effectiveCapture = { width: exact.width, height: exact.height, fps: exact.fps };
      this._log(`采集格式 ${exact.width}x${exact.height}@${exact.fps}（设备原生支持）`);
      return { negotiated: true, format: exact };
    }

    const best = pickBestFormat(formats, wanted);
    if (!best) return { negotiated: false };

    this._log(
      `摄像头不支持 ${wanted.width}x${wanted.height}@${wanted.fps}，`
      + `自动改用 ${best.width}x${best.height}@${best.fps}`,
    );

    // 只记录"实际生效的采集格式"，不改写 this.config。
    // this.config 保持用户的原始意图，便于界面回显与后续比较。
    this.effectiveCapture = { width: best.width, height: best.height, fps: best.fps };
    return { negotiated: true, format: best, changed: true };
  }

  /**
   * 等待摄像头设备释放。
   *
   * 重启时旧 ffmpeg 被杀后，DirectShow 设备句柄不会瞬间释放。
   * 若立即起新 ffmpeg，会报 -10054（连接被重置）或 BindToObject 失败。
   *
   * 曾经尝试用 probeDeviceFormats（再开一个 ffmpeg 查格式）来检测，
   * 但这会导致多个 ffmpeg 实例争抢设备，最终把 mpv 卡死在 D3D11 驱动层，
   * 连 taskkill /F 都杀不掉——这是之前"死机"的根因。
   *
   * 因此改为最简单可靠的方式：固定等待。dshow 设备在旧句柄关闭后
   * 通常 300–500ms 内释放，给 800ms 余量足够。
   */
  async _waitForCameraReady(waitMs = 800) {
    if (!this.device?.name) return;
    this._log(`等待摄像头释放 (${waitMs}ms)…`);
    await new Promise((r) => setTimeout(r, waitMs));
    this._log('摄像头等待完成');
  }

  /**
   * 创建并启动 mpv 渲染器（初始启动与并行钩子共用的单元）。
   * @param {string} url 视频流地址
   */
  async _startRenderer(url) {
    this.renderer = new Renderer({
      mpvPath: this.mpvPath,
      streamUrl: url,
      config: this.config,
      runDir: this.runDir,
    });
    this.renderer.on('exit', (info) => this._onRendererCrash(info));
    this._log('启动 mpv 渲染…');
    await this.renderer.start({ hwnd: 0 });
  }

  /**
   * 管线**异常**退出（Pipeline 只在非主动停止时才 emit 'exit'）。
   *
   * 状态机必须诚实：ffmpeg 死了就不能继续报告 running——历史实现不改状态，
   * 界面显示"运行中"而壁纸早已冻住，用户无从知道该重启（商用级不可接受）。
   * 转入 error 后，界面点「重启」走 start 路径（会先清理本崩溃现场）。
   * 启动/重启过程中（starting/restarting）的崩溃交给该流程自身的
   * 失败路径收敛，此处不越权改状态。
   */
  _onPipelineCrash(info) {
    this._log(`ffmpeg 异常退出 (code=${info.code})，壁纸已停止更新`);
    if (this.state === 'running') {
      this.state = 'error';
      this.startedAt = null;
    }
    this.emit('pipeline-exit', info);
  }

  /** mpv 异常退出：同 _onPipelineCrash 的状态诚实原则。 */
  _onRendererCrash(info) {
    this._log(`mpv 异常退出 (code=${info.code})`);
    if (this.state === 'running') {
      this.state = 'error';
      this.startedAt = null;
    }
    this.emit('renderer-exit', info);
  }

  /**
   * bring-up/restart 收尾前的存活终检。
   *
   * Pipeline/Renderer 各自只在启动瞬间自检（+700ms/+900ms）；此后到
   * "宣布成功"之间还有找窗口、挂载等秒级窗口，任一侧在此期间死掉都
   * 不能宣布 running——否则产生 state=running 但管线已亡的"僵尸运行中"。
   * 抛错后由调用方的失败路径统一转入 error 并清理。
   */
  _assertBringUpAlive() {
    if (!this.pipeline?.running) {
      throw new CamToBgError('ffmpeg 在启动完成前退出', {
        code: ErrorCodes.PIPELINE_FAILED,
        hint: this.pipeline?.recentLog?.(600) || '详情见 ffmpeg 日志',
      });
    }
    if (!this.renderer?.running) {
      throw new CamToBgError('mpv 在启动完成前退出', {
        code: ErrorCodes.RENDER_FAILED,
        hint: this.renderer?.recentLog?.(600) || '详情见 mpv 日志',
      });
    }
  }

  /**
   * 交给 ffmpeg 的配置：在用户配置基础上套用协商后的采集格式。
   * 这样滤镜与编码参数仍来自用户设置，只有采集尺寸用设备真正支持的值。
   */
  _pipelineConfig() {
    if (!this.effectiveCapture) return this.config;
    return {
      ...this.config,
      width: this.effectiveCapture.width,
      height: this.effectiveCapture.height,
      fps: this.effectiveCapture.fps,
    };
  }

  /**
   * 通过窗口标题找到 mpv 的窗口。
   *
   * 为什么需要它：mpv 的 --wid 需要「已存在」的父窗口句柄，
   * 而我们要挂载的正是 mpv 自己的窗口。因此让 mpv 正常创建窗口，
   * 再按我们设置的 --title=cam-to-bg 找到它，最后 SetParent 到 WorkerW。
   */
  async _findMpvWindow() {
    const { findWindowByTitle } = await import('./win32.js');
    // mpv 建窗需要一点时间，做几次重试
    for (let i = 0; i < 20; i += 1) {
      const hwnd = await findWindowByTitle('cam-to-bg');
      if (hwnd) return hwnd;
      await new Promise((r) => setTimeout(r, 250));
    }
    return 0;
  }

  /**
   * 写 sendcmd 命令文件。
   *
   * 把当前配置里的色彩参数（亮度/对比度/饱和度/Gamma/曝光/色温/色相）
   * 转成 ffmpeg sendcmd 格式写入文件。
   * ffmpeg 的 sendcmd 滤镜每帧重新读这个文件，所以改了就即时生效。
   *
   * 记录两个值：
   *   cmdFilePath —— 完整路径（Node 读写用）
   *   cmdFileName —— 纯文件名（传给 ffmpeg 用，见下方说明）
   *
   * 为什么 ffmpeg 只收文件名：ffmpeg 滤镜参数以 `:` 分隔，
   * Windows 绝对路径里的 `C:` 会被当成选项分隔符，导致滤镜解析失败。
   * 因此把 ffmpeg 的工作目录设为该文件所在目录，参数里只给文件名。
   */
  async _writeCmdFile() {
    const { buildSendcmdContent } = await import('./filters.js');
    const os = await import('node:os');
    const path = await import('node:path');
    const fs = await import('node:fs');
    const crypto = await import('node:crypto');

    const name = `cam-to-bg-cmd-${process.pid}-${crypto.randomBytes(4).toString('hex')}.txt`;
    const dir = os.tmpdir();
    const filePath = path.join(dir, name);
    const content = buildSendcmdContent(this.config);
    fs.writeFileSync(filePath, content, 'utf8');

    this.cmdFilePath = filePath;
    this.cmdFileName = name;
    this.cmdDir = dir;
    this._log(`sendcmd 文件: ${filePath}`);
    return filePath;
  }

  /**
   * 只更新 sendcmd 命令文件（不重启 ffmpeg）。
   *
   * 这是色彩/曝光/色温/色相参数变更时的处理路径：
   * 直接重写命令文件内容，ffmpeg 下一帧就会读取新参数并应用。
   * 不停 ffmpeg、不碰摄像头、不重启 mpv——完全零风险。
   *
   * 采用"先写临时文件再原子改名"：
   * ffmpeg 每帧都在读这个文件，若就地覆盖，它可能读到写了一半的内容，
   * 导致某一帧参数异常（画面闪烁）。rename 在同一分区上是原子的，
   * 读者要么看到旧内容、要么看到新内容。
   */
  async _updateCmdFile() {
    if (!this.cmdFilePath) return { ok: false, reason: '命令文件未初始化' };
    const { buildSendcmdContent } = await import('./filters.js');
    const fs = await import('node:fs');
    const content = buildSendcmdContent(this.config);
    const tmp = `${this.cmdFilePath}.tmp`;
    try {
      fs.writeFileSync(tmp, content, 'utf8');
      fs.renameSync(tmp, this.cmdFilePath);
      return { ok: true };
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch { /* 忽略 */ }
      this._log(`色彩参数写入失败: ${err.message}`);
      return { ok: false, reason: err.message };
    }
  }

  /**
   * 运行期更新配置。
   *
   * 色彩类参数（亮度/对比度/饱和度/Gamma/曝光/色温/色相）：
   *   → 只写 sendcmd 命令文件，ffmpeg 下一帧自动应用，零重启零风险
   *
   * 几何类参数（翻转/旋转/缩放模式）：
   *   → 无法通过 sendcmd 动态修改（会改变画面尺寸），需手动重启
   *
   * 结构类参数（帧率/分辨率/编码器/延迟模式等）：
   *   → 只保存，提示用户手动点「重启」按钮
   */
  async applyConfig(nextConfig) {
    const prev = this.requestedConfig;

    // 色彩类参数：可以通过 sendcmd 实时调整
    const colorKeys = COLOR_KEYS; // 分类常量在模块顶部导出（schema 等价性测试强制一致）

    // 几何类参数：无法动态修改，需要手动重启
    const geometryKeys = GEOMETRY_KEYS;

    // 结构类参数：需要整条重启。
    //
    // 注意 bitrate 与 quality 也在其中：它们是 ffmpeg 的命令行参数，
    // 无法通过 sendcmd 动态修改。早期版本漏了这两项，导致用户改码率/画质时
    // 既不生效也不提示，属于静默失效，必须归入"需重启"。
    //
    // uiPort **不在**这里：HTTP 服务由 index.js 在配置变更时
    // 直接 relisten（新端口占用失败会自动回退），与 ffmpeg/mpv 管线无关，
    // 把它算进"需重启"会让用户白点一次重启。
    const structureKeys = STRUCTURE_KEYS;

    const colorChanged = colorKeys.some((k) => prev[k] !== nextConfig[k]);
    const geomChanged = geometryKeys.some((k) => prev[k] !== nextConfig[k]);
    const structChanged = structureKeys.some((k) => prev[k] !== nextConfig[k]);

    this.config = nextConfig;
    this.requestedConfig = { ...nextConfig };

    if (!this.pipeline || this.state !== 'running') return { mode: 'none' };

    // 1) 色彩参数变了 → 写命令文件，即时生效
    let cmdWriteFailed = null;
    if (colorChanged) {
      const r = await this._updateCmdFile();
      if (r.ok) {
        this._log('色彩参数已通过 sendcmd 即时生效');
      } else {
        cmdWriteFailed = r.reason;
      }
    }

    // 2) 几何或结构参数变了 → 需要手动重启
    if (geomChanged || structChanged) {
      const changed = [...geometryKeys, ...structureKeys].filter((k) => prev[k] !== nextConfig[k]);
      this._log(`以下参数已保存，需手动点击「重启」生效：${changed.join(', ')}`);
      return { mode: 'pending-restart', pendingKeys: changed, cmdWriteFailed };
    }

    // 色彩参数写入失败时，如实告知而不是谎报"已生效"
    if (colorChanged && cmdWriteFailed) {
      return { mode: 'sendcmd-failed', error: cmdWriteFailed };
    }

    // 只有色彩参数变了（或什么都没变）
    return { mode: colorChanged ? 'sendcmd' : 'none' };
  }

  /**
   * 手动重启：在摄像头排他约束下的最优无缝策略。
   *
   * 摄像头是排他资源——新旧 ffmpeg 不能同时打开同一设备。
   * 因此"先建新再拆旧"在这里行不通（新管线在协商格式时会被旧 ffmpeg 占用阻塞）。
   *
   * 实际采用的最优策略：
   *   1) 停掉旧的 ffmpeg（释放摄像头）
   *      —— mpv 窗口和桌面挂载保持不动，画面停在最后一帧，不会黑屏
   *   2) 用最新配置重新协商格式、起新 ffmpeg（新端口）
   *   3) 停掉旧的 mpv（它的流源已断，且新 ffmpeg 用了新端口）
   *   4) 起新 mpv 连新流，找到新窗口，挂到桌面（替换旧的挂载位置）
   *
   * 这样用户看到的是：画面停顿约 1–2 秒（旧画面冻结）→ 新画面无缝衔接，
   * 而不是黑屏。
   *
   * 失败回滚：若新管线起不来，尽力恢复，让用户至少有可操作的状态。
   */
  async restart() {
    if (this.state !== 'running') {
      this.state = 'idle';
      return this.start();
    }

    this.state = 'restarting';
    this._log('重启：暂停采集（画面保持显示）…');

    // 1) 停旧 ffmpeg，释放摄像头。mpv 与桌面挂载不动
    const oldRenderer = this.renderer;
    const oldPipeline = this.pipeline;

    // 关键：从"停旧"开始的全部阶段都必须收敛到 state='error'。
    // 早期实现把停旧/等待摄像头放在 try 之外，一旦 _waitForCameraReady 抛错，
    // 引擎会永远卡在 'restarting'，面板上表现为"重启中"再也不动。
    try {
      if (oldPipeline) {
        try { await oldPipeline.stop(); } catch { /* 忽略 */ }
        this.pipeline = null;
      }

      // 关键：摄像头是排他资源，旧 ffmpeg 被杀后设备不会立即释放。
      // 若立即起新 ffmpeg 会报 -10054（连接被重置）或 BindToObject 失败。
      // 这里等待设备真正可用后再继续。
      this._log('等待摄像头释放…');
      await this._waitForCameraReady();
    } catch (err) {
      this._log(`重启失败: ${err.message}`);
      if (this.pipeline) {
        try { await this.pipeline.stop(); } catch { /* 忽略 */ }
        this.pipeline = null;
      }
      if (this.renderer && this.renderer !== oldRenderer) {
        try { await this.renderer.stop(); } catch { /* 忽略 */ }
        this.renderer = null;
      }
      this.state = 'error';
      throw err;
    }

    // 2) 起新 ffmpeg
    //
    // 安全点：不调用 _negotiateCaptureFormat()。
    // 原因：_negotiateCaptureFormat 会调用 probeDeviceFormats，
    // 后者会启动一个 ffmpeg 进程去查设备格式——
    // 在旧 ffmpeg 刚停、设备尚未释放的窗口期，这个 probe 进程会和
    // 设备争抢，堆积僵死进程，最终把 mpv 拖死在 D3D11 驱动层
    // （这是之前死机的直接原因）。
    // restart 时复用已有的 effectiveCapture（首次启动时已协商好），
    // 如果用户改了 fps/分辨率，会在 effectiveCapture 基础上用新值尝试，
    // 设备不支持的话 ffmpeg 会报错，但不会卡死系统。
    const savedEffective = this.effectiveCapture;
    const prev = this._lastRequestedCapture; // 上一轮的用户原始采集意图
    this.effectiveCapture = null;
    try {
      // 判断"用户是否改了采集参数"必须拿 **requestedConfig vs 上轮原始意图** 比。
      // 历史缺陷：拿 effectiveCapture 比——协商过的设备两者天然不等，
      // 每次重启都被误判成"用户改了参数"，清掉协商结果、回退到设备并不
      // 支持的原始值 → 这类设备的重启**永远失败**。
      const userChanged = !!prev && (
        this.requestedConfig.width !== prev.width
        || this.requestedConfig.height !== prev.height
        || Number(this.requestedConfig.fps) !== Number(prev.fps)
      );
      if (userChanged) {
        // 用户真改了：effectiveCapture 已清空，
        // _pipelineConfig() 会回退到 config 里的用户设定值
        this._log('采集参数已变更，用新值尝试启动');
      } else {
        // 参数没变，恢复已协商的格式
        this.effectiveCapture = savedEffective;
      }
      // 无论走哪条分支，本轮意图成为下一次比较的基准
      this._lastRequestedCapture = {
        width: this.requestedConfig.width,
        height: this.requestedConfig.height,
        fps: this.requestedConfig.fps,
      };

      const target = this._resolveTarget();
      this.pipeline = new Pipeline({
        ffmpegPath: this.ffmpegPath,
        config: this._pipelineConfig(),
        encoder: this.encoder,
        // 打开用 openAs（重名设备=备用名），错误提示用显示名 deviceLabel
        deviceName: this.device.openAs || this.device.name,
        deviceLabel: this.device.name,
        target,
        // 必须传入 cmdFile：否则新 ffmpeg 的滤镜链里没有 sendcmd，
        // 重启之后所有色彩调整都会失效（写文件但 ffmpeg 不读）。
        cmdFileName: this.cmdFileName,
        cmdDir: this.cmdDir,
        runDir: this.runDir,
      });
      this.pipeline.on('log', (m) => this._log(m));
      this.pipeline.on('exit', (info) => this._onPipelineCrash(info));
      this._log('启动新 ffmpeg…');
      const { url } = await this.pipeline.start();
      this._log(`新视频流: ${url}`);

      // 3) 停旧 mpv（流已断）。
      //
      // 刻意**不**先 detachFromDesktop：SetParent(0) 会把窗口变回顶层窗口，
      // 若随后的杀进程只杀掉启动器（mpv.com），孤儿窗口就会以顶层形态
      // 浮在桌面最前面——正是"重启后遗留一个暂停的 mpv 挡在前面"的成因。
      // 窗口随进程退出自动销毁；即使进程成为孤儿，Renderer.stop 内部
      // 还会按窗口标题清扫，孤儿也活不下来。
      if (oldRenderer) {
        try { await oldRenderer.stop(); } catch { /* 忽略 */ }
        this.renderer = null;
        this.mpvHwnd = 0;
        this.attached = false;
      }

      // 4) 起新 mpv，挂到桌面
      this.renderer = new Renderer({
        mpvPath: this.mpvPath,
        streamUrl: url,
        config: this.config,
        runDir: this.runDir,
      });
      this.renderer.on('exit', (info) => this._onRendererCrash(info));
      this._log('启动新 mpv…');
      await this.renderer.start({ hwnd: 0 });
      this._log('定位新 mpv 窗口…');
      this.mpvHwnd = await this._findMpvWindow();
      if (!this.mpvHwnd) {
        // 找不到窗口就绝不能继续：否则 mpv 会以未挂载的顶层窗口
        // 裸浮在桌面前面（不可控、无法交互），用户只能手动去关。
        throw new CamToBgError('重启后未能定位 mpv 窗口', {
          code: ErrorCodes.RENDER_FAILED,
          hint: 'mpv 可能启动异常，详情见 mpv 日志。已停止新 mpv，不会留下浮窗。',
        });
      }
      {
        const res = await attachToDesktop(this.mpvHwnd);
        this.attached = true;
        this._log(`挂载完成，模式=${res.mode}`);
        this._warnAttachMode(res.mode);
      }

      // 存活终检：找窗口/挂载的秒级窗口里任一侧死掉都不能宣布成功
      this._assertBringUpAlive();

      this.state = 'running';
      this.startedAt = Date.now();
      this._log('重启完成');
      const st = this.status();
      this.emit('started', st);
      return st;
    } catch (err) {
      this._log(`重启失败: ${err.message}`);
      // 清理可能残留的新进程，防止僵死
      if (this.pipeline) {
        try { await this.pipeline.stop(); } catch { /* 忽略 */ }
        this.pipeline = null;
      }
      if (this.renderer) {
        try { await this.renderer.stop(); } catch { /* 忽略 */ }
        this.renderer = null;
      }
      this.state = 'error';
      throw err;
    }
  }

  /** 停止并还原桌面。 */
  async stop() {
    await this._teardown();
    this.state = 'stopped';
    return { stopped: true };
  }

  /**
   * 内部清理：**先停 ffmpeg，再停 mpv**。
   *
   * 顺序依据（真机日志实证）：若先杀 mpv，它断开 TCP 会让 ffmpeg 的
   * mpegts 写入收到 -10054（连接重置=致命错误）→ ffmpeg 停止消费 →
   * dshow 实时缓冲堆积刷屏 "too full → frame dropped" → trailer 再报
   * -10054 的三级级联。先停 ffmpeg 则 muxer 在客户端仍在时立即终止
   *（TerminateProcess 瞬时，无刷窗窗口），mpv 随后停止看到 EOF，全程干净。
   * 也不再需要 detach：窗口随进程退出销毁，Renderer.stop 内部还会按
   * 标题清扫孤儿（见其注释）。
   */
  async _teardown() {
    this.attached = false;
    this.mpvHwnd = 0;

    if (this.pipeline) {
      try { await this.pipeline.stop(); } catch { /* 忽略 */ }
      this.pipeline = null;
    }
    if (this.renderer) {
      try { await this.renderer.stop(); } catch { /* 忽略 */ }
      this.renderer = null;
    }

    // 清理 sendcmd 命令文件，避免临时目录长期积累
    this._removeCmdFile();
  }

  /** 删除 sendcmd 命令文件（及其可能残留的临时文件）。 */
  _removeCmdFile() {
    if (!this.cmdFilePath) return;
    try {
      for (const f of [this.cmdFilePath, `${this.cmdFilePath}.tmp`]) {
        try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch { /* 忽略 */ }
      }
    } catch { /* 忽略 */ }
    this.cmdFilePath = null;
  }

  /**
   * 同步强杀子进程。
   *
   * 用于 'exit' 钩子这类无法 await 的场景。
   * 必须在 process.exit() 之前同步执行完 —— 否则父进程先退出，
   * ffmpeg/mpv 会变成孤儿进程继续占用摄像头与桌面窗口。
   */
  killChildrenSync() {
    for (const proc of [this.renderer?.child, this.pipeline?.child]) {
      if (!proc) continue;
      try {
        proc.kill();
      } catch { /* 已退出 */ }
      // 兜底：Windows 上再用 taskkill 连同子进程树一起结束
      try {
        if (proc.pid) {
          execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true,
          });
        }
      } catch { /* 进程可能已退出，忽略 */ }
    }
  }

  /**
   * 注册进程退出钩子，确保不留下孤儿窗口。
   *
   * 只在 'exit' 上做最后一搏的同步清理；
   * SIGINT/SIGTERM 不在这里处理 —— CLI 有自己的优雅退出流程
   * （先 await app.stop() 还原桌面再退出）。
   */
  _bindCleanup() {
    if (this._cleanupBound) return;
    this._cleanupBound = true;

    process.once('exit', () => {
      // 'exit' 阶段无法执行异步操作，只能同步杀掉子进程。
      // 子进程消失后，挂在桌面上的窗口随之销毁，不会留下孤儿窗口。
      this.killChildrenSync();
    });
  }

  /** 当前状态快照，供界面展示。 */
  status() {
    const target = this.desktop ? this._resolveTarget() : null;
    return {
      state: this.state,
      running: this.state === 'running',
      attached: this.attached,
      uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0,
      device: this.device?.name || null,
      // 用 requestedConfig：它保存用户原始请求，不会被采集格式协商改写
      deviceRequested: this.requestedConfig?.device || '',
      deviceFallbackFrom: this.device?.fallbackFrom || null,
      encoder: this.encoder ? { name: this.encoder.name, label: this.encoder.label, hardware: this.encoder.hardware } : null,
      output: target ? { width: target.width, height: target.height } : null,
      // 实际采集尺寸：可能与用户请求不同（由摄像头支持能力决定）
      capture: this.effectiveCapture || { width: this.config.width, height: this.config.height, fps: this.config.fps },
      captureNegotiated: !!this.effectiveCapture,
      // 传入 cmdFile，使界面显示的滤镜链与 ffmpeg 实际使用的一致（含 sendcmd 段）
      filterChain: target ? buildFilterChain(this._pipelineConfig(), target, this.cmdFileName) : null,
      streamUrl: this.pipeline?.streamUrl || null,
      mpvHwnd: this.mpvHwnd,
      pids: {
        ffmpeg: this.pipeline?.child?.pid ?? null,
        mpv: this.renderer?.child?.pid ?? null,
      },
      logTail: this.pipeline?.recentLog(1200) || '',
    };
  }
}
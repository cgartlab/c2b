/**
 * renderer.js — mpv 渲染进程管理
 *
 * 职责：
 *  1. 启动 mpv 并让它创建一个窗口（标题固定为 cam-to-bg）
 *  2. 由 wallpaper.js 找到该窗口并挂到桌面宿主下，成为动态壁纸
 *  3. 按延迟模式配置 mpv 的缓冲策略
 *
 * 注意：本模块**不做**运行期调参。
 * 色彩参数由 ffmpeg 侧的 sendcmd 滤镜负责（见 filters.js），
 * mpv 只负责解码与渲染，启动后参数不变。
 *
 * 硬件加速：--vo=gpu-next --gpu-api=d3d11 --hwdec=auto-safe
 *（本机实测 mpv 0.41.0 + libplacebo 7.360 支持这些选项）
 */
import { spawnLongRunning, makeLogPath, readLogTail } from './proc.js';
import { CamToBgError, ErrorCodes } from './errors.js';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * 构造 mpv 参数。
 *
 * 关键选项说明：
 *  - --wid : 嵌入指定窗口句柄，这是成为壁纸的基础
 *  - --vo=gpu-next + --gpu-api=d3d11 : 走 D3D11 的 GPU 渲染管线
 *  - --hwdec=auto-safe : 优先硬件解码，失败自动回落软解
 *  - --no-config : 忽略用户 mpv 配置，保证行为可预测
 *
 * 延迟相关的取舍（这几项对"看起来卡半秒"影响最大）：
 *  - --video-sync=desync : 不做时钟同步，收到帧就尽快显示。
 *      默认值是 audio，但我们是 --no-audio 的纯视频流，
 *      让画面去追一个不存在的音频时钟会让 mpv 持续缓冲、越积越慢。
 *  - --demuxer-max-bytes / --max-back-bytes : 默认 150MiB / 50MiB 缓冲，
 *      对实时摄像头毫无意义，压到 2MiB 以内可显著降低堆积延迟。
 *  - --vd-queue-enable=no : 关闭解码队列，避免多帧排队。
 *  - --demuxer-readahead-secs=0 : 不预先读入，来一帧解一帧。
 */
/**
 * 按延迟模式返回对应的 mpv 缓冲/同步参数。
 *
 * 三种模式的差别只在"愿意缓冲多少"：
 *  · ultra-low : 几乎不缓冲，来帧就渲染，落后就丢帧。画面最快，但网络/解码抖动会表现为偶发跳帧。
 *  · balanced  : 留少量缓冲吸收抖动，延迟略高但更稳。
 *  · smooth    : 优先不丢帧，允许缓冲到约 0.5 秒。适合追求画面连续、能接受延迟的场景。
 *
 * @param {string} mode
 * @returns {string[]}
 */
export function latencyArgs(mode) {
  switch (mode) {
    case 'smooth':
      return [
        '--video-sync=audio',
        '--untimed=no',
        '--cache=yes',
        '--cache-secs=0.5',
        '--demuxer-readahead-secs=0.5',
        '--demuxer-max-bytes=16MiB',
        '--demuxer-max-back-bytes=4MiB',
        '--framedrop=no',
        '--video-latency-hacks=no',
      ];
    case 'balanced':
      return [
        '--video-sync=desync',
        '--untimed=yes',
        '--cache=no',
        '--demuxer-readahead-secs=0',
        '--demuxer-max-bytes=6MiB',
        '--demuxer-max-back-bytes=2MiB',
        '--framedrop=vo',
        '--video-latency-hacks=yes',
      ];
    case 'ultra-low':
    default:
      return [
        '--video-sync=desync',
        '--untimed=yes',
        '--cache=no',
        '--demuxer-readahead-secs=0',
        '--demuxer-max-bytes=1MiB',
        '--demuxer-max-back-bytes=512KiB',
        '--vd-queue-enable=no',
        '--ad-queue-enable=no',
        '--framedrop=decoder+vo',
        '--video-latency-hacks=yes',
      ];
  }
}

export function buildMpvArgs({ hwnd, streamUrl, ipcPath, config }) {
  const args = [
    '--no-config',
    '--no-input-default-bindings',
    '--no-osc',
    '--no-osd-bar',
    '--osd-level=0',
    '--no-audio',
    '--no-terminal',
    '--idle=yes',
    '--force-window=yes',
    '--keep-open=yes',
    '--loop-file=inf',
    '--vo=gpu-next',
    '--gpu-api=d3d11',
    '--gpu-context=d3d11',
    '--hwdec=auto-safe',
    '--profile=low-latency',

    // 延迟模式对应的参数必须放在 profile 之后才能覆盖它
    ...latencyArgs(config?.latencyMode),

    '--interpolation=no',
    '--osc=no',
    '--border=no',
    '--title=cam-to-bg',
  ];

  if (hwnd) args.push(`--wid=${hwnd}`);
  if (ipcPath) args.push(`--input-ipc-server=${ipcPath}`);

  // 让画面铺满窗口，不留黑边
  args.push('--panscan=1.0');

  args.push(streamUrl);
  return args;
}

export class Renderer extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.mpvPath
   * @param {string} opts.streamUrl
   * @param {object} opts.config
   * @param {string|null} [opts.runDir] 本次运行的日志目录
   */
  constructor({ mpvPath, streamUrl, config, runDir = null }) {
    super();
    this.mpvPath = mpvPath;
    this.streamUrl = streamUrl;
    this.config = config;
    this.child = null;
    this.logPath = makeLogPath('mpv', runDir);
    this.ipcPath = null;
    this._stopping = false;
  }

  get running() {
    return this.child !== null && this.child.exitCode === null && !this.child.killed;
  }

  /**
   * 启动 mpv。若给了 hwnd，则嵌入该窗口。
   */
  async start({ hwnd = 0 } = {}) {
    if (this.running) return;

    // 不启用 --input-ipc-server：沙箱下 Node 无法访问命名管道，
    // 该选项只会让 mpv 多创建一个用不上的管道（详见下方 stop() 前的设计说明）。
    this.ipcPath = null;

    const args = buildMpvArgs({
      hwnd,
      streamUrl: this.streamUrl,
      ipcPath: null,
      config: this.config,
    });

    const { child } = spawnLongRunning(this.mpvPath, args, { logPath: this.logPath });
    this.child = child;

    child.on('error', (err) => {
      this.emit('error', new CamToBgError(`mpv 启动失败: ${err.message}`, {
        code: ErrorCodes.RENDER_FAILED,
        hint: '请确认 mpv 已安装。本项目实测使用 C:\\Program Files\\MPV Player\\mpv.com。',
      }));
    });

    child.on('exit', (code) => {
      const wasStopping = this._stopping;
      this.child = null;
      if (!wasStopping) {
        this.emit('exit', { code, logTail: readLogTail(this.logPath, 1500) });
      }
    });

    // 给 mpv 时间窗口化并连上流
    await new Promise((r) => setTimeout(r, 900));

    if (!this.running) {
      const tail = readLogTail(this.logPath, 2000);
      throw new CamToBgError('mpv 未能保持运行', {
        code: ErrorCodes.RENDER_FAILED,
        hint: `mpv 日志：${tail || '(空)'}｜完整日志：${this.logPath}`,
      });
    }

    return { hwnd };
  }

  recentLog(maxBytes = 2500) {
    return readLogTail(this.logPath, maxBytes);
  }

  /*
   * 为什么这里没有运行期调参接口
   * ─────────────────────────────────────────────────────────────
   * mpv 官方提供的运行期控制方式是 --input-ipc-server，即命名管道。
   * 但本机实测：受限沙箱下 Node 既不能用 net.connect 连命名管道，
   * 也不能用 fs.openSync 打开命名管道，两者都返回 EPERM。
   * 而该选项在 Windows 上只支持命名管道（标注 [file]），不支持 TCP。
   *
   * 因此本工具完全不依赖 mpv IPC，调参职责划分如下：
   *   · 色彩/曝光/色温/色相 → 由 ffmpeg 的 sendcmd 滤镜处理（见 filters.js），
   *     ffmpeg 与 mpv 都不需要重启，画面不闪断。
   *   · 几何/结构参数（翻转、旋转、帧率、码率等）→ 保存后由用户手动点「重启」。
   *
   * 也就是说：mpv 启动后参数不再变化，本模块无需暴露调参方法。
   */

  /**
   * 渐进式停止 mpv：先 SIGTERM 等待退出，不响应再用 taskkill /T /F。
   *
   * 之前发生过 mpv 卡死在 D3D11 驱动层、连 taskkill /F 都杀不掉的情况，
   * 导致系统音频驱动崩溃。因此这里分两步：
   *   1) SIGTERM，等 3 秒让它自己清理 GPU 资源后退出
   *   2) 如果还在，用 taskkill /T /F 连子进程树一起强杀
   * 如果强杀也失败，不再重试——记录日志，让外层 cleanup 处理。
   */
  async stop() {
    if (!this.child) return;
    this._stopping = true;
    const child = this.child;
    this.child = null;

    // 第一步：SIGTERM，等待自己退出
    let exited = false;
    try { child.kill('SIGTERM'); } catch { /* 已退出 */ exited = true; }
    if (!exited) {
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 3000);
        child.once('exit', () => { clearTimeout(t); exited = true; resolve(); });
      });
    }

    // 第二步：如果 3 秒后还在，用 taskkill /T /F 强杀
    if (!exited && child.pid) {
      try {
        const { execFileSync } = await import('node:child_process');
        execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          stdio: 'ignore', windowsHide: true, timeout: 5000,
        });
      } catch { /* 可能已退出，或无法杀——记录但不重试 */ }
    }

    this._stopping = false;
  }
}

/** 查找 mpv 可执行文件。 */
export function findMpv() {
  const candidates = [
    process.env.CAM_TO_BG_MPV,
    'C:\\Program Files\\MPV Player\\mpv.com',
    'C:\\Program Files\\MPV Player\\mpv.exe',
    'C:\\Program Files (x86)\\MPV Player\\mpv.com',
    'mpv.com',
    'mpv.exe',
    'mpv',
  ].filter(Boolean);

  for (const c of candidates) {
    if (path.isAbsolute(c)) {
      try { if (fs.statSync(c).isFile()) return c; } catch { /* 继续 */ }
    } else {
      // 交给 spawn 按 PATH 解析
      return c;
    }
  }
  return null;
}
/**
 * pipeline.js — ffmpeg 采集+编码管线的生命周期管理
 *
 * 管线：摄像头 (dshow) → 滤镜(色彩/曝光/缩放) → 硬件编码(AMF/MF/x264) → 本地回环 TCP
 * mpv 作为客户端从该 TCP 端口拉流并渲染。
 */
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { spawnLongRunning, makeLogPath, readLogTail } from './proc.js';
import { buildFfmpegArgs } from './filters.js';
import { CamToBgError, ErrorCodes } from './errors.js';

/**
 * 当前进程是否以管理员身份运行。
 *
 * 这直接影响能否访问某些摄像头：实测某 USB 摄像头在非管理员进程下
 * dshow 会报 BindToObject 失败，提权后立刻正常。
 * 因此排查相机问题时需要知道当前权限状态。
 *
 * 用 `net session` 探测：该命令需要管理员权限，能跑通即说明已提权。
 */
export function isElevated() {
  if (process.platform !== 'win32') return true;
  try {
    execFileSync('net', ['session'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * 找一个空闲的本地端口（绑定到 127.0.0.1）。
 *
 * 交给系统分配（port 0），拿到后立刻关闭监听并返回端口号。
 * 注意这里存在极小的竞态窗口：关闭到 ffmpeg 真正监听之间，
 * 端口理论上可能被别的进程抢走 —— 但绑定在回环地址且系统按序分配，
 * 实际发生概率可忽略，且 ffmpeg 启动失败会由 start() 明确报错。
 *
 * @param {number} [preferred] 期望端口；0 或省略表示由系统分配
 */
export function findFreePort(preferred = 0) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', (err) => {
      // 指定端口被占用时回退到系统分配，不再递归，避免潜在死循环
      if (err.code === 'EADDRINUSE' && preferred !== 0) {
        findFreePort(0).then(resolve, reject);
        return;
      }
      reject(err);
    });
    srv.once('listening', () => {
      const actual = srv.address().port;
      srv.close(() => resolve(actual));
    });
    srv.listen(preferred, '127.0.0.1');
  });
}

export class Pipeline extends EventEmitter {
  constructor({ ffmpegPath, config, encoder, deviceName, target, cmdFileName, cmdDir, runDir = null }) {
    super();
    this.ffmpegPath = ffmpegPath;
    this.config = config;
    this.encoder = encoder;
    this.deviceName = deviceName;
    this.target = target;
    /**
     * sendcmd 命令文件的文件名（不含目录）与所在目录。
     *
     * 为什么分开传：ffmpeg 滤镜参数以 `:` 分隔，
     * Windows 绝对路径的 `C:` 会被当成选项分隔符导致滤镜解析失败
     *（实测报 "No option name near '/Users/...'"）。
     * 因此把 cwd 设为该目录，参数里只给纯文件名。
     */
    this.cmdFileName = cmdFileName || null;
    this.cmdDir = cmdDir || null;

    this.child = null;
    this.port = null;
    this.logPath = makeLogPath('ffmpeg', runDir);
    this.startedAt = null;
    this.lastError = null;
    this._stopping = false;
  }

  get running() {
    return this.child !== null && this.child.exitCode === null && !this.child.killed;
  }

  /** 当前使用的流地址。 */
  get streamUrl() {
    return this.port ? `tcp://127.0.0.1:${this.port}` : null;
  }

  /**
   * 启动管线。会先绑定端口，确保 mpv 能连上。
   */
  async start() {
    if (this.running) return { port: this.port };

    // 让系统分配一个空闲端口。
    // 不写死端口号：默认端口在反复重启时可能还处于 TIME_WAIT，
    // 或与用户其他程序冲突；交给系统分配最稳妥。
    this.port = await findFreePort(0);

    const args = buildFfmpegArgs(this.config, {
      deviceName: this.deviceName,
      encoder: this.encoder,
      target: this.target,
      port: this.port,
      cmdFileName: this.cmdFileName,
    });

    this.emit('log', `启动 ffmpeg: ${this.encoder.name} @ ${this.target.width}x${this.target.height} ${this.config.fps}fps ${this.config.bitrate}Mbps`);

    // cwd 必须设为 cmd 文件所在目录：滤镜参数里只写了纯文件名，
    // ffmpeg 需要在该目录下才能找到 sendcmd 的命令文件。
    const { child } = spawnLongRunning(this.ffmpegPath, args, {
      logPath: this.logPath,
      cwd: this.cmdDir || undefined,
    });
    this.child = child;
    this.startedAt = Date.now();
    this.lastError = null;

    child.on('error', (err) => {
      this.lastError = err.message;
      this.emit('error', new CamToBgError(`ffmpeg 启动失败: ${err.message}`, {
        code: ErrorCodes.PIPELINE_FAILED,
        hint: '请确认 ffmpeg 路径正确且可执行。',
      }));
    });

    child.on('exit', (code) => {
      const wasStopping = this._stopping;
      this.child = null;
      if (!wasStopping) {
        const tail = readLogTail(this.logPath, 1500);
        this.lastError = `ffmpeg 异常退出 (code=${code})`;
        this.emit('exit', { code, logTail: tail });
      }
    });

    // 给 ffmpeg 一点时间建立 TCP 监听
    await new Promise((r) => setTimeout(r, 700));

    if (!this.running) {
      const tail = readLogTail(this.logPath, 2000);
      throw new CamToBgError('ffmpeg 未能保持运行，管线启动失败', {
        code: ErrorCodes.PIPELINE_FAILED,
        hint: this._explain(tail),
      });
    }

    return { port: this.port, url: this.streamUrl };
  }

  /**
   * 根据 ffmpeg 日志尾部给出人话解释。
   *
   * 这里区分了两种很容易混淆的失败：
   *  · "设备被占用" —— 有别的程序正持有摄像头
   *  · "权限不足"   —— 设备正常，但当前进程权限不够直接访问
   *
   * 实测案例：某 USB 摄像头在非管理员进程下 dshow 报
   * "Unable to BindToObject / Could not find video device"，
   * 但同一命令提权后立即成功，且系统相机 App 一直能正常使用。
   * 这种情形下提示用户"关闭占用程序"是误导，必须明确指向权限。
   */
  _explain(logTail) {
    const t = logTail || '';

    // BindToObject 失败：既可能是被占用，也可能是权限不足，需要进一步区分
    if (/BindToObject|Could not find video device|I\/O error/i.test(t)) {
      if (/Device or resource busy|in use/i.test(t)) {
        return `摄像头「${this.deviceName}」正被其他程序独占。请关闭可能在使用摄像头的程序（浏览器、会议软件、直播工具等）后重试。`;
      }
      return `摄像头「${this.deviceName}」无法打开。系统能枚举到该设备，但当前进程无法绑定它。常见原因有两种：\n`
        + '        1) 权限不足 —— 某些摄像头需要管理员权限才能访问。'
        + '可尝试以管理员身份重新启动本工具；也可先在「相机」App 里确认设备本身正常。\n'
        + '        2) 设备被占用 —— 关闭可能正在使用摄像头的程序后重试。\n'
        + '        若两种都不奏效，可改用 OBS 虚拟摄像头中转（UGREEN → OBS → 虚拟摄像头）。';
    }
    if (/Device or resource busy|in use/i.test(t)) {
      return `摄像头「${this.deviceName}」正被其他程序独占，请关闭后重试。`;
    }
    if (/Cannot load|Unknown encoder|error initializing/i.test(t) && /amf|nvenc|qsv|mf/i.test(t)) {
      return `硬件编码器 ${this.encoder.name} 初始化失败，可能是显卡驱动问题。可改用 libx264（软件编码）。`;
    }
    if (/No such file|not found/i.test(t)) {
      return '找不到 ffmpeg，请确认已安装并加入 PATH。';
    }
    return `ffmpeg 报错详情见日志：${this.logPath}`;
  }

  /** 读取最近的日志，用于界面展示。 */
  recentLog(maxBytes = 3000) {
    return readLogTail(this.logPath, maxBytes);
  }

  /**
   * 停止管线（渐进式，与 Renderer.stop 保持一致）。
   *
   * 之前只有 SIGTERM + 等 2 秒，没有强杀兜底：
   * 若 ffmpeg 卡在 dshow 采集上不响应 SIGTERM，进程会成为孤儿，
   * 继续占用摄像头，导致后续启动全部失败（BindToObject）。
   * 因此这里补上 taskkill /T /F 兜底。
   */
  async stop() {
    if (!this.child) return;
    this._stopping = true;
    const child = this.child;
    this.child = null;

    // 第一步：SIGTERM，等待自行退出
    let exited = false;
    try { child.kill('SIGTERM'); } catch { exited = true; }
    if (!exited) {
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 3000);
        child.once('exit', () => { clearTimeout(t); exited = true; resolve(); });
      });
    }

    // 第二步：仍未退出则连子进程树一起强杀
    if (!exited && child.pid) {
      try {
        execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          stdio: 'ignore', windowsHide: true, timeout: 5000,
        });
      } catch { /* 可能已退出 */ }
    }

    this._stopping = false;
    this.port = null;
  }
}

/** 探测某端口是否已有 ffmpeg 在监听（供 mpv 连接前确认）。 */
export function waitForPort(port, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = () => {
      const sock = net.connect({ port, host: '127.0.0.1' });
      sock.once('connect', () => { sock.destroy(); resolve(true); });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() > deadline) resolve(false);
        else setTimeout(attempt, 150);
      });
    };
    attempt();
  });
}
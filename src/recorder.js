/**
 * recorder.js — 屏幕录制（画面 + 系统音频 + 麦克风）
 *
 * 独立于壁纸管线的一条 ffmpeg 进程：
 *   gdigrab（屏幕画面） + dshow（麦克风音频） → 硬件编码 → MP4 文件
 *
 * 复用 encoder-probe.js 已探测的编码器，优先用 H.264 硬件编码。
 * 音频编码固定用 AAC（mp4 容器标准搭配）。
 *
 * ── 为什么输出是「分片 MP4」而不是普通 MP4 ──
 * 普通 MP4 的元数据（moov）只在文件正常收尾时写入。Windows 上 Node 的
 * child.kill 是 TerminateProcess 硬杀，ffmpeg 来不及收尾 → moov 缺失 →
 * 录出来的文件无法播放（真实缺陷）。分片 MP4（empty_moov）在开头就写
 * 元数据、每到关键帧落一个分片，进程被强杀也只损失最后一小段，
 * 文件始终可播。停止时仍会先尝试向 stdin 写 'q' 走优雅收尾（更快更完整），
 * 写不通再 taskkill 兜底。
 */
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnLongRunning, makeLogPath, readLogTail, runCaptured } from './proc.js';
import { CamToBgError, ErrorCodes } from './errors.js';
import { isAlive } from './state.js';

/**
 * 录制互斥锁文件（与配置同目录，CLI `c2b record` 与界面进程共享）。
 * 内容 = 持有者（Node 进程）pid。
 */
export function recordLockPath() {
  const dir = process.env.CAM_TO_BG_HOME || path.join(os.homedir(), '.cam-to-bg');
  return path.join(dir, 'rec.lock');
}

/**
 * 尝试获取**跨进程**录制锁（原子 wx 创建）。
 *
 * 背景（第47轮）：HTTP `_recordStart` 只守进程内 `this.recorder`，而 CLI
 * `c2b record` 是独立进程 —— 二者可并发录屏 → 两个 gdigrab+编码器抢 GPU、
 * 产出两份文件、界面还显示"未录制"。此锁保证同一时刻机器上（同一配置域）
 * 只有一个录制。
 *
 * @returns {boolean} true=获得锁；false=已有**存活**持有者（真的在录）
 */
export function acquireRecordLock(file = recordLockPath()) {
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch { /* 已存在 */ }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') return false;
      let owner = NaN;
      try { owner = Number(fs.readFileSync(file, 'utf8')); } catch { /* 并发删除中 */ }
      if (Number.isInteger(owner) && owner > 0 && isAlive(owner)) return false; // 存活 = 在录
      try { fs.unlinkSync(file); } catch { /* 陈旧锁：持有者已死，抢占 */ }
    }
  }
  return false;
}

/** 释放自己持有的录制锁（仅持有者是自己才删，防误删他人锁）。 */
export function releaseRecordLock(file = recordLockPath()) {
  try {
    const owner = Number(fs.readFileSync(file, 'utf8'));
    if (owner === process.pid) fs.unlinkSync(file);
  } catch { /* 不存在/已释放/被抢占：忽略 */ }
}

/**
 * 解析「视频」文件夹的**真实位置**（Windows Known Folder）。
 *
 * 历史缺陷：默认直接用 `os.homedir()/Videos`——OneDrive「已知文件夹」
 * 重定向过的机器上真实位置是 `OneDrive\Videos`，写旧路径要么报
 * Permission denied（录制 600ms 后崩）、要么文件落到用户看不见的地方。
 *
 * 用 .NET SpecialFolder 查询（注意枚举成员名是 **MyVideos**：
 * 传 'Videos' 会因枚举不存在报 MethodException，本机实测）。
 * 环境异常时回退 homedir()/Videos。
 *
 * @returns {Promise<string>} 绝对目录路径
 */
export async function resolveVideosDir() {
  try {
    const { powershellPath } = await import('./win32.js');
    const r = await runCaptured(powershellPath, [
      '-NoProfile', '-NonInteractive', '-Command',
      '[Environment]::GetFolderPath("MyVideos")',
    ], { timeout: 8000 });
    const out = String(r.stdout || '').trim();
    if (r.code === 0 && /^[a-zA-Z]:[\\/]/.test(out)) return out;
  } catch { /* 回退 */ }
  return path.join(os.homedir(), 'Videos');
}

/**
 * 把录制区域钳制到屏幕范围内。
 *
 * gdigrab 的硬约束：`offset + video_size` 必须落在桌面内，越界会直接
 * 报错退出（录制开始即失败）。历史实现只做了"坐标非负 + 宽高取偶"，
 * 完全没对屏幕边界做校验——API 传一块越界区域，录制 600ms 后就崩。
 *
 * 另注：gdigrab 抓取的是桌面窗口（Desktop Window DC），其边界为**主屏**，
 * 因此这里用主屏尺寸钳制，而不是用户配置的显示器序号。
 *
 * @param {object|null} region {x,y,w,h}
 * @param {{width:number,height:number}|null} screen 主屏尺寸；null 时只做原有规范化
 * @returns {{x:number,y:number,w:number,h:number}|null}
 */
export function clampRegion(region, screen) {
  const normalized = normalizeRegion(region);
  if (!normalized) return null;
  if (!screen) return normalized;

  const evenClamp = (v, max) => {
    let x = Math.min(Math.max(2, Math.round(v)), Math.round(max));
    if (x % 2 !== 0) x -= 1;      // 保持偶数且**不超出**上界
    return Math.max(2, x);
  };

  const sw = Math.round(Number(screen.width) || 0);
  const sh = Math.round(Number(screen.height) || 0);
  if (sw < 4 || sh < 4) return normalized; // 屏幕尺寸未知时不乱钳

  const w = evenClamp(normalized.w, sw);
  const h = evenClamp(normalized.h, sh);
  const x = Math.min(normalized.x, sw - w);
  const y = Math.min(normalized.y, sh - h);
  return { x: Math.max(0, x), y: Math.max(0, y), w, h };
}

/**
 * 校验并规范化录制区域（坐标非负、宽高至少 2 且取偶）。
 * 屏幕边界钳制请用 clampRegion——gdigrab 越界会直接报错退出。
 */
export function normalizeRegion(region) {
  if (!region || typeof region !== 'object') return null;
  const even = (n) => {
    const v = Math.max(2, Math.round(Number(n) || 0));
    return v % 2 === 0 ? v : v + 1;
  };
  const x = Math.max(0, Math.round(Number(region.x) || 0));
  const y = Math.max(0, Math.round(Number(region.y) || 0));
  const w = even(region.w);
  const h = even(region.h);
  return { x, y, w, h };
}

export function buildRecorderArgs({ encoder, outputPath, audioDevice, region, fps, bitrate, quality, maxDuration }) {
  const rate = Math.max(1, Math.round(fps) || 30);
  const mbNum = Math.max(0.5, Number(bitrate) || 8);
  const vbr = `${mbNum}M`;
  // quality 允许为 0（最高画质），不能用 || 兜底——那会把 0 吞成 23
  const q = (quality === null || quality === undefined || !Number.isFinite(Number(quality)))
    ? 23 : Math.min(51, Math.max(0, Math.round(Number(quality))));
  const area = normalizeRegion(region);

  const videoInput = [];
  // thread_queue_size：官方通用输入选项（demuxer 包队列上限），实时源调大
  // 以吸收调度抖动、避免溢出丢帧；稳态队列近空，不增加延迟。
  if (area) {
    videoInput.push('-f', 'gdigrab', '-thread_queue_size', '512',
      '-offset_x', String(area.x), '-offset_y', String(area.y),
      '-video_size', `${area.w}x${area.h}`,
      '-framerate', String(rate), '-i', 'desktop');
  } else {
    videoInput.push('-f', 'gdigrab', '-thread_queue_size', '512',
      '-framerate', String(rate), '-i', 'desktop');
  }

  const audioInput = [];
  if (audioDevice) {
    // 官方 dshow 文档：-audio_buffer_size 单位是**毫秒**（缓冲延迟），
    // 默认 0 = 设备默认。历史值 32ms 过小，小缓冲在录制场景毫无收益、
    // 却会带来音频欠载爆音（录制不追求低延迟）→ 移除，用设备默认值。
    audioInput.push('-f', 'dshow', '-thread_queue_size', '512',
      '-i', `audio=${audioDevice}`);
  }

  /**
   * ── 文件场景的画质/率控（与壁管的低延迟调优刻意不同） ──
   * 官方选项表来源：`ffmpeg -h encoder=<name>`（ffmpeg 9.0.1）。
   * 录制不需要零延迟：不禁用 B 帧（历史 -bf 0 白损压缩率）、
   * 不用 zerolatency tune；画质滑块必须真实生效（历史缺陷见 filters.js 同款注释）。
   */
  const videoEncode = [...encoder.args,
    // GOP = 1 秒：分片 MP4 按关键帧落片，GOP 越短，强杀时损失的画面越少、拖动定位越准
    '-g', String(Math.max(1, rate)), '-pix_fmt', 'yuv420p'];

  if (encoder.name === 'libx264' || encoder.name === 'libx265') {
    // 实测：-crf 与 -b:v 同给时 -b:v 被忽略 → 不发 -b:v，
    // 码率滑块以 -maxrate/-bufsize 作为 VBV 上限参与。
    videoEncode.push('-crf', String(q), '-maxrate', vbr, '-bufsize', `${mbNum * 2}M`,
      '-preset', 'ultrafast');
  } else if (encoder.name === 'h264_amf' || encoder.name === 'hevc_amf') {
    // 实测：CBR 下 qp_i/qp_p 无效（画质滑杆空操作）→ CQP 才生效。
    // transcoding(0) 是 h264/hevc_amf 官方 usage 枚举里的文件场景值，
    // 会覆盖候选/上游可能带的 lowlatency（AVOptions 后者生效）。
    videoEncode.push('-usage', 'transcoding', '-rc', 'cqp',
      '-qp_i', String(q), '-qp_p', String(q));
  } else if (encoder.name === 'av1_amf') {
    // av1_amf 无 cqp 枚举、也无 transcoding usage：用 qvbr 质量模式
    //（qvbr_quality_level 0–51 与滑杆同向）+ high_quality usage。
    videoEncode.push('-usage', 'high_quality', '-rc', 'qvbr',
      '-qvbr_quality_level', String(q), '-b:v', vbr, '-maxrate', vbr, '-bufsize', `${mbNum * 2}M`);
  } else if (encoder.name === 'h264_nvenc' || encoder.name === 'hevc_nvenc'
    || encoder.name === 'av1_nvenc') {
    // 官方：-cq 属 VBR 的质量参数（配 cbr 会被忽略）→ vbr + cq + 码率目标。
    // 文件场景用 p4/hq（壁管才用 p1/ull），允许 B 帧（不发 -zerolatency）。
    videoEncode.push('-preset', 'p4', '-tune', 'hq',
      '-rc', 'vbr', '-cq', String(q),
      '-b:v', vbr, '-maxrate', vbr, '-bufsize', `${mbNum * 2}M`);
  } else if (encoder.name === 'h264_qsv' || encoder.name === 'hevc_qsv') {
    // ICQ 质量模式（码率不参与，与壁管一致）
    videoEncode.push('-global_quality', String(q), '-preset', 'veryfast');
  } else if (encoder.name === 'h264_mf') {
    // 录制优先保证文件体积可预期 → 官方 -rate_control g_vbr(5) + -b:v 目标码率
    //（画质滑块此路径不参与；壁管的 MF 走 quality 模式，见 filters.js）
    videoEncode.push('-rate_control', 'g_vbr', '-b:v', vbr, '-maxrate', vbr, '-bufsize', `${mbNum * 2}M`);
  } else {
    videoEncode.push('-b:v', vbr, '-maxrate', vbr, '-bufsize', `${mbNum * 2}M`);
  }

  const audioEncode = audioDevice ? ['-c:a', 'aac', '-b:a', '192k', '-ac', '2'] : ['-an'];

  // 录制时长安全阀：-t 由 ffmpeg 原生限制输出时长，到点自动结束
  //（防长录制吃满磁盘；用户仍可提前 Ctrl+C 停止）
  const durArg = (Number.isFinite(Number(maxDuration)) && Number(maxDuration) > 0)
    ? ['-t', String(Math.round(Number(maxDuration)))] : [];

  return ['-hide_banner', '-loglevel', 'warning',
    // 注意：不带 -nostdin —— stdin 是管道，停止时写 'q' 让 ffmpeg 优雅收尾
    ...videoInput, ...audioInput, ...videoEncode, ...audioEncode,
    // 关键：文件输出的 avio 默认带 32KB 用户态缓冲。静态桌面下总码量很小，
    // 已编码的数据会一直滞留在缓冲里不落盘——硬杀后文件只剩 28 字节的头
    // （实测：frame=109 时文件仍28B）。flush_packets 让每个分片立即写入，
    // 强杀最多丢最后一个分片。
    '-flush_packets', '1',
    // 分片 MP4：强杀也可播放（见文件头说明）。+faststart 与分片互斥且无意义（moov 本就在头部）。
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    ...durArg,
    '-y', outputPath];
}

/** 上一次输出路径的时间戳（毫秒），用于保证连续两次调用不产生同名文件。 */
let _lastPathTime = 0;

/**
 * 生成录制输出路径：`cam-to-bg_rec_YYYYMMDD_HHMMSS_mmm.mp4`。
 *
 * 历史缺陷：只精确到秒，同一秒内连录两次 → 同名文件被 `-y` 静默覆盖、
 * 上一段录像直接丢失。现在加毫秒并做单调递增兜底，保证严格不重复。
 */
export function defaultOutputPath(folder) {
  let t = Date.now();
  if (t <= _lastPathTime) t = _lastPathTime + 1;
  _lastPathTime = t;

  const now = new Date(t);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    + `_${pad(now.getMilliseconds(), 3)}`;
  const dir = folder || path.join(os.homedir(), 'Videos');
  // 确保输出目录存在：recFolder 可能指向尚未创建的路径，
  // 目录缺失时 ffmpeg 打开输出会直接 Permission denied / No such file。
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 由 ffmpeg 报错兜底 */ }
  return path.join(dir, `cam-to-bg_rec_${stamp}.mp4`);
}

export class Recorder extends EventEmitter {
  constructor({ ffmpegPath, encoder, outputPath, audioDevice, region, fps, bitrate, quality, maxDuration, runDir = null, lockPath = null }) {
    super();
    this.ffmpegPath = ffmpegPath;
    this.encoder = encoder;
    this.outputPath = outputPath;
    this.audioDevice = audioDevice || null;
    this.region = region || null;
    this.fps = fps || 30;
    this.bitrate = bitrate || 8;
    // quality=0 合法（最高画质），不能用 || 兜底
    this.quality = (quality === null || quality === undefined || !Number.isFinite(Number(quality)))
      ? 23 : Number(quality);
    this.maxDuration = (Number.isFinite(Number(maxDuration)) && Number(maxDuration) > 0)
      ? Math.round(Number(maxDuration)) : null;
    this.child = null;
    this.logPath = makeLogPath('recorder', runDir);
    this.startedAt = null;
    this._stopping = false;   // 收尾**在途**（供服务端守卫/状态展示）
    this._stopRequested = false; // 已请求停止（闩锁至退出分类完成，不可复位）
    // 测试注入（同 selectEncoder 的 cacheFile 先例）：隔离互斥锁到指定路径，
    // 避免单测把锁写进真实 ~/.cam-to-bg（若用户此时正在录制会莫名拒绝测试）
    this.lockPathOpt = lockPath;
    this._lockFile = null;
  }

  get running() { return this.child !== null && this.child.exitCode === null && !this.child.killed; }

  async start() {
    if (this.running) return;
    // 跨进程录制互斥：CLI `c2b record` 与界面 record 分属不同进程，
    // 进程内 this.recorder 守卫拦不住 —— 原子锁保证同一时刻只有一个录制。
    this._lockFile = this.lockPathOpt || recordLockPath();
    if (!acquireRecordLock(this._lockFile)) {
      throw new CamToBgError('已有录制正在进行中（CLI 或界面其一），请先停止当前录制', {
        code: ErrorCodes.BUSY,
        hint: '界面可在「录制」区停止；CLI 可对上一次 c2b record 按 Ctrl+C。若确无录制在进行，可能上次异常遗留了锁，稍候重试即可（陈旧锁会被自动抢占）。',
      });
    }
    try {
      const args = buildRecorderArgs({
        encoder: this.encoder, outputPath: this.outputPath,
        audioDevice: this.audioDevice, region: this.region,
        fps: this.fps, bitrate: this.bitrate, quality: this.quality,
        maxDuration: this.maxDuration,
      });
      this._log(`开始录制: ${this.outputPath}`);
      this._log(`编码器: ${this.encoder.name} | 音频: ${this.audioDevice ? 'AAC' : '无'}`);
      // stdin 走管道：停止时写 'q' 让 ffmpeg 优雅收尾（配合分片 MP4 双保险）
      const { child } = spawnLongRunning(this.ffmpegPath, args, { logPath: this.logPath, stdinPipe: true });
      this.child = child;
      this.startedAt = Date.now();
      child.on('error', (err) => { this.emit('error', new CamToBgError(`录制进程启动失败: ${err.message}`, { code: ErrorCodes.PIPELINE_FAILED })); });
      child.on('exit', (code) => {
        // 录制结束即释放跨进程锁（正常/崩溃/taskkill 全路径都经过这里）
        releaseRecordLock(this._lockFile);
        // 分类用**闩锁**而非 _stopping：无 stdin 环境（EPERM 回退）下 taskkill
        // 全程同步，_stopping 在 exit 事件到达前就已复位 → 手动停止会被误判成
        // "异常退出"（CLI 打错误文案、manifest 错误标 note）——状态诚实回归
        const wasStopping = this._stopRequested;
        this.child = null;
        // code=0 是正常结束（包括 -t 到点自动退出、q 优雅收尾）→ 'finished'
        // 非 0 才是异常退出 → 'exit'
        if (wasStopping || code === 0) { this._log(`录制结束 (code=${code})`); this.emit('finished', { code, outputPath: this.outputPath }); }
        else { this.emit('exit', { code, logTail: readLogTail(this.logPath, 1500) }); }
      });
      await new Promise((r) => setTimeout(r, 600));
      if (!this.running) {
        throw new CamToBgError('录制未能保持运行', { code: ErrorCodes.PIPELINE_FAILED, hint: `ffmpeg 日志：${readLogTail(this.logPath, 2000) || '(空)'}` });
      }
      this._log('录制中…');
      return { outputPath: this.outputPath, pid: this.child?.pid };
    } catch (err) {
      releaseRecordLock(this._lockFile); // spawn 同步失败等尚未进入 child.exit 路径的情况
      throw err;
    }
  }

  _log(msg) { this.emit('log', msg); }
  recentLog(maxBytes = 2000) { return readLogTail(this.logPath, maxBytes); }

  /**
   * 停止录制：先优雅（stdin 写 q），后强杀（taskkill /T /F）。
   *
   * 之前这里发 SIGINT —— Windows 上 Node 的信号一律是 TerminateProcess 硬杀，
   * 加上参数里带 -nostdin，ffmpeg 永远没机会写 MP4 尾部，文件不可播放。
   * 现在：1) stdin 写 'q' 让 ffmpeg 自己收尾（毫秒级）；
   *       2) 3 秒没退就 taskkill 连进程树强杀；
   *       3) 即便走到强杀，分片 MP4 也保证文件可播。
   */
  /**
   * 停止录制（幂等）。
   * 必须是**非 async** 方法：async 函数每次调用都会包一层新 promise，
   * `p1 === p2` 恒不成立，破坏"并发 stop 共享同一收尾"的可观察契约。
   * @returns {Promise<void>} 并发调用共享同一收尾 promise
   */
  stop() {
    if (this._stopPromise) return this._stopPromise;
    if (!this.child) return Promise.resolve();
    this._stopPromise = this._stopCore();
    return this._stopPromise;
  }

  /** 是否正在收尾（child 已摘除但进程退出尚未完成）。 */
  get stopping() { return this._stopping === true; }

  async _stopCore() {
    this._stopRequested = true; // 闩锁：此后任何退出都归类为"停止引发"
    this._stopping = true;
    const child = this.child;
    this.child = null;

    let exited = child.exitCode !== null;

    // 1) 优雅退出：ffmpeg 从 stdin 读到 q 后会正常收尾。
    //    受限沙箱下 spawn 拿不到 stdin 管道（见 spawnLongRunning 的回退说明），
    //    此时 child.stdin 不存在，直接走兜底，不做无意义的等待。
    const hasStdin = !!(child.stdin && child.stdin.writable);
    if (!exited && hasStdin) {
      try {
        child.stdin.write('q\n');
        child.stdin.end();
      } catch { /* 管道已断，直接走兜底 */ }

      await new Promise((resolve) => {
        if (child.exitCode !== null) { exited = true; resolve(); return; }
        const t = setTimeout(resolve, 3000);
        child.once('exit', () => { clearTimeout(t); exited = true; resolve(); });
      });
    }

    // 2) 兜底：taskkill 连子进程树一起强杀
    if (!exited && child.pid) {
      try {
        execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          stdio: 'ignore', windowsHide: true, timeout: 5000,
        });
        if (child.exitCode !== null) exited = true;
      } catch { /* 受限环境/已退出：走下一层 */ }
    }

    // 3) 最终兜底：直接 TerminateProcess（受限沙箱里 taskkill 可能不可用）
    if (!exited && child.pid) {
      try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
    }

    this._stopping = false;
  }
}

/**
 * 列出麦克风（与视频设备同构的 {value,label} 条目）。
 *
 * 返回形状经 disambiguateDevices：重名麦克风的第二个用备用名作 value
 *（实测 `audio=<备用名>` 可完整采集，本机两台麦克风均 exit=0）、label 加序号。
 * 消费方（CLI record / /api/audio-devices / 设置界面下拉）统一按 value 打开。
 */
export async function listAudioDevices(ffmpegPath) {
  const { runCaptured } = await import('./proc.js');
  const { parseDshowDevices, disambiguateDevices } = await import('./devices.js');
  const res = await runCaptured(ffmpegPath, ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], { timeout: 15000 });
  const all = parseDshowDevices(res.stderr + '\n' + res.stdout);
  return disambiguateDevices(all.filter((d) => d.type === 'audio'));
}
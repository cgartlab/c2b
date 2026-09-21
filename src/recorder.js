/**
 * recorder.js — 屏幕录制（画面 + 系统音频 + 麦克风）
 *
 * 独立于壁纸管线的一条 ffmpeg 进程：
 *   gdigrab（屏幕画面） + dshow（麦克风音频） → 硬件编码 → MP4 文件
 *
 * 复用 encoder-probe.js 已探测的编码器，优先用 H.264 硬件编码。
 * 音频编码固定用 AAC（mp4 容器标准搭配）。
 */
import { EventEmitter } from 'node:events';
import path from 'node:path';
import os from 'node:os';
import { spawnLongRunning, makeLogPath, readLogTail } from './proc.js';
import { CamToBgError, ErrorCodes } from './errors.js';

/**
 * 校验并规范化录制区域。
 *
 * gdigrab 对非法的 offset/video_size 会直接报错退出，
 * 因此这里先把参数夹到合法范围（宽高至少 2 且为偶数，坐标非负）。
 *
 * @param {object|null} region {x,y,w,h}
 * @returns {{x:number,y:number,w:number,h:number}|null}
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

export function buildRecorderArgs({ encoder, outputPath, audioDevice, region, fps, bitrate, quality }) {
  const rate = Math.max(1, Math.round(fps) || 30);
  const vbr = `${Math.max(0.5, Number(bitrate) || 8)}M`;
  const q = Math.round(Number(quality) || 23);
  const area = normalizeRegion(region);

  const videoInput = [];
  if (area) {
    videoInput.push('-f', 'gdigrab',
      '-offset_x', String(area.x), '-offset_y', String(area.y),
      '-video_size', `${area.w}x${area.h}`,
      '-framerate', String(rate), '-i', 'desktop');
  } else {
    videoInput.push('-f', 'gdigrab', '-framerate', String(rate), '-i', 'desktop');
  }

  const audioInput = [];
  if (audioDevice) {
    audioInput.push('-f', 'dshow', '-audio_buffer_size', '32', '-i', `audio=${audioDevice}`);
  }

  const videoEncode = [...encoder.args,
    '-b:v', vbr, '-maxrate', vbr,
    '-bufsize', `${Math.max(0.5, Number(bitrate) || 8) * 2}M`,
    '-g', String(Math.max(1, rate * 2)), '-bf', '0', '-pix_fmt', 'yuv420p'];

  if (Number.isFinite(q)) {
    if (encoder.name === 'libx264') videoEncode.push('-crf', String(q));
    else if (encoder.name.includes('amf')) videoEncode.push('-rc', 'cbr', '-qp_i', String(q), '-qp_p', String(q));
    else if (encoder.name.includes('nvenc')) videoEncode.push('-rc', 'cbr', '-cq', String(q));
    else if (encoder.name.includes('qsv')) videoEncode.push('-global_quality', String(q));
    else if (encoder.name === 'libx265') videoEncode.push('-crf', String(q));
  }

  const audioEncode = audioDevice ? ['-c:a', 'aac', '-b:a', '192k', '-ac', '2'] : ['-an'];

  return ['-hide_banner', '-loglevel', 'warning', '-nostdin',
    ...videoInput, ...audioInput, ...videoEncode, ...audioEncode,
    '-movflags', '+faststart', '-y', outputPath];
}

export function defaultOutputPath(folder) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return path.join(folder || path.join(os.homedir(), 'Videos'), `cam-to-bg_rec_${stamp}.mp4`);
}

export class Recorder extends EventEmitter {
  constructor({ ffmpegPath, encoder, outputPath, audioDevice, region, fps, bitrate, quality, runDir = null }) {
    super();
    this.ffmpegPath = ffmpegPath;
    this.encoder = encoder;
    this.outputPath = outputPath;
    this.audioDevice = audioDevice || null;
    this.region = region || null;
    this.fps = fps || 30;
    this.bitrate = bitrate || 8;
    this.quality = quality || 23;
    this.child = null;
    this.logPath = makeLogPath('recorder', runDir);
    this.startedAt = null;
    this._stopping = false;
  }

  get running() { return this.child !== null && this.child.exitCode === null && !this.child.killed; }

  async start() {
    if (this.running) return;
    const args = buildRecorderArgs({
      encoder: this.encoder, outputPath: this.outputPath,
      audioDevice: this.audioDevice, region: this.region,
      fps: this.fps, bitrate: this.bitrate, quality: this.quality,
    });
    this._log(`开始录制: ${this.outputPath}`);
    this._log(`编码器: ${this.encoder.name} | 音频: ${this.audioDevice ? 'AAC' : '无'}`);
    const { child } = spawnLongRunning(this.ffmpegPath, args, { logPath: this.logPath });
    this.child = child;
    this.startedAt = Date.now();
    child.on('error', (err) => { this.emit('error', new CamToBgError(`录制进程启动失败: ${err.message}`, { code: ErrorCodes.PIPELINE_FAILED })); });
    child.on('exit', (code) => {
      const wasStopping = this._stopping;
      this.child = null;
      if (wasStopping) { this._log(`录制结束 (code=${code})`); this.emit('finished', { code, outputPath: this.outputPath }); }
      else { this.emit('exit', { code, logTail: readLogTail(this.logPath, 1500) }); }
    });
    await new Promise((r) => setTimeout(r, 600));
    if (!this.running) {
      throw new CamToBgError('录制未能保持运行', { code: ErrorCodes.PIPELINE_FAILED, hint: `ffmpeg 日志：${readLogTail(this.logPath, 2000) || '(空)'}` });
    }
    this._log('录制中…');
    return { outputPath: this.outputPath, pid: this.child?.pid };
  }

  _log(msg) { this.emit('log', msg); }
  recentLog(maxBytes = 2000) { return readLogTail(this.logPath, maxBytes); }

  async stop() {
    if (!this.child) return;
    this._stopping = true;
    const child = this.child;
    this.child = null;
    let exited = false;
    try { child.kill('SIGINT'); } catch { exited = true; }
    if (!exited) {
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 5000);
        child.once('exit', () => { clearTimeout(t); exited = true; resolve(); });
      });
    }
    if (!exited && child.pid) { try { child.kill('SIGKILL'); } catch {} }
    this._stopping = false;
  }
}

export async function listAudioDevices(ffmpegPath) {
  const { runCaptured } = await import('./proc.js');
  const { parseDshowDevices } = await import('./devices.js');
  const res = await runCaptured(ffmpegPath, ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], { timeout: 15000 });
  const all = parseDshowDevices(res.stderr + '\n' + res.stdout);
  return all.filter((d) => d.type === 'audio').map((d) => d.name);
}
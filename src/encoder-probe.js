/**
 * encoder-probe.js — 探测可用的硬件/软件编码器
 *
 * 设计要点：不只看 `ffmpeg -encoders` 的列表，而是真的编码一段。
 * 原因：编码器可能"存在于列表中"但因驱动问题无法初始化
 *（例如 AMF 在部分驱动版本上会初始化失败）。实测编码最有说服力。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCaptured } from './proc.js';
import { CamToBgError, ErrorCodes } from './errors.js';

/**
 * 候选编码器，按「硬件优先」排序。
 *
 * args 只带 `-c:v <name>`，**不携带 preset / tune / 率控等调优参数**。
 * 调优是使用方的职责，三层各写各的，避免互相覆盖与重复下发
 *（历史上出现过 -tune ll 被 -tune ull 覆盖、preset 重复两次的问题）：
 *   · 探测（本文件）只验证"能否初始化并编码"，参数越裸越可移植；
 *   · 壁管管线的低延迟调优 → filters.js buildFfmpegArgs；
 *   · 录制的文件向调优   → recorder.js buildRecorderArgs。
 *
 * 选项与枚举值以官方文档为准（本机 ffmpeg 9.0.1 构建的
 * `ffmpeg -h encoder=<name>` 即该版本官方选项表）。特别注意：
 * 各编码器同名选项的枚举并不通用 —— 如 h264_amf 的 -usage 含 transcoding，
 * av1_amf 则没有；h264_amf 的 -quality 是 speed/quality 枚举，
 * av1_amf 的 -quality 打印值只有 high_quality/quality。
 * 因此候选表不放任何编码器专属选项。
 */
export const ENCODER_CANDIDATES = [
  // ── H.264 ──
  {
    name: 'h264_amf',
    label: 'AMD AMF H.264 (硬件)',
    hardware: true, vendor: 'amd', codec: 'h264',
    args: ['-c:v', 'h264_amf'],
  },
  {
    name: 'h264_nvenc',
    label: 'NVIDIA NVENC H.264 (硬件)',
    hardware: true, vendor: 'nvidia', codec: 'h264',
    args: ['-c:v', 'h264_nvenc'],
  },
  {
    name: 'h264_qsv',
    label: 'Intel QSV H.264 (硬件)',
    hardware: true, vendor: 'intel', codec: 'h264',
    args: ['-c:v', 'h264_qsv'],
  },
  {
    name: 'h264_mf',
    label: 'Media Foundation H.264',
    hardware: true, vendor: 'any', codec: 'h264',
    args: ['-c:v', 'h264_mf'],
  },
  // ── H.265 / HEVC ──
  {
    name: 'hevc_amf',
    label: 'AMD AMF H.265 (硬件)',
    hardware: true, vendor: 'amd', codec: 'hevc',
    args: ['-c:v', 'hevc_amf'],
  },
  {
    name: 'hevc_nvenc',
    label: 'NVIDIA NVENC H.265 (硬件)',
    hardware: true, vendor: 'nvidia', codec: 'hevc',
    args: ['-c:v', 'hevc_nvenc'],
  },
  {
    name: 'hevc_qsv',
    label: 'Intel QSV H.265 (硬件)',
    hardware: true, vendor: 'intel', codec: 'hevc',
    args: ['-c:v', 'hevc_qsv'],
  },
  // ── AV1 ──
  {
    name: 'av1_amf',
    label: 'AMD AMF AV1 (硬件)',
    hardware: true, vendor: 'amd', codec: 'av1',
    args: ['-c:v', 'av1_amf'],
  },
  {
    name: 'av1_nvenc',
    label: 'NVIDIA AV1 (硬件)',
    hardware: true, vendor: 'nvidia', codec: 'av1',
    args: ['-c:v', 'av1_nvenc'],
  },
  // ── 软件 ──
  {
    name: 'libx264',
    label: 'x264 H.264 (软件)',
    hardware: false, vendor: 'any', codec: 'h264',
    args: ['-c:v', 'libx264'],
  },
  {
    name: 'libx265',
    label: 'x265 H.265 (软件)',
    hardware: false, vendor: 'any', codec: 'hevc',
    args: ['-c:v', 'libx265'],
  },
];

/**
 * 用合成源真实编码一小段，验证该编码器是否可用。
 *
 * 尺寸/码率可由调用方传入（应传**真实工况**：采集分辨率与设定码率），
 * 默认 640x480 只用于快速冒烟——历史缺陷正是"640x480 探测通过、
 * 实际 4K 启动失败"。
 *
 * 超时 10s：lavfi 10 帧的健康编码通常 <3s；超时只用于兜底"驱动挂死"，
 * 若沿用历史 20s，多候选全挂时冷启动最坏要串行等数分钟。
 */
export async function testEncoder(ffmpegPath, encoder, opts = {}) {
  const { bitrate = '4M', width = 640, height = 480, timeout = 10000 } = opts;
  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-f', 'lavfi',
    '-i', `testsrc=size=${width}x${height}:rate=30`,
    '-frames:v', '10',
    ...encoder.args,
    '-b:v', bitrate,
    '-f', 'null',
    '-',
  ];
  const res = await runCaptured(ffmpegPath, args, { timeout });
  return { ok: res.code === 0, stderr: res.stderr, stdout: res.stdout, code: res.code };
}

/* ─────────────── 探测结果缓存（冷启动只付一次串行探测成本） ─────────────── */

const PROBE_CACHE_VERSION = 1;

/**
 * 缓存文件路径（系统临时目录，重启即失效也无妨——命中只是省时间，不是免验证）。
 *
 * 分域：录制工况（屏幕分辨率 + 录制码率）与壁纸工况（摄像头分辨率 + 壁纸码率）
 * 签名不同，共用**单条目**缓存会互相冲刷（每次探测都 miss、每次全量重探）。
 * 录制传 `scope='record'` 落到独立文件，两侧各自命中。
 *
 * @param {string} [scope] 'record' → 录制域；缺省/'wallpaper' → 壁纸域（文件名不变）
 */
export function probeCacheFile(scope) {
  const name = scope && scope !== 'wallpaper'
    ? `cam-to-bg-encoder-probe-${scope}.json`
    : 'cam-to-bg-encoder-probe.json';
  return path.join(os.tmpdir(), name);
}

/**
 * 缓存签名：任一影响探测结论的输入变化都必须失效。
 * 含 ffmpeg 路径 + 文件 mtime（升级/重装即失效）、探测工况、prefer 偏好。
 */
export function probeSig(ffmpegPath, opts = {}) {
  let mtime = '0';
  try { mtime = String(fs.statSync(ffmpegPath).mtimeMs); } catch { /* 不可读则仅按路径 */ }
  const w = opts.width ?? '';
  const h = opts.height ?? '';
  const b = opts.bitrate ?? '';
  return `${PROBE_CACHE_VERSION}|${ffmpegPath}|${mtime}|${w}x${h}@${b}|${opts.prefer || 'auto'}`;
}

function readProbeCache(file, sig) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (j && j.sig === sig && typeof j.encoder === 'string') return j;
    return null;
  } catch { return null; }
}

function writeProbeCache(file, sig, encoderName) {
  try {
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({
      sig, encoder: encoderName, ts: new Date().toISOString(),
    }, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch { /* 缓存写失败无所谓：下次照常完整探测 */ }
}

/**
 * 依次测试候选编码器，返回第一个可用的。
 *
 * **缓存策略**：命中时只对缓存结论做**一次复验**（testEncoder，1–3s），
 * 通过即返回——多候选串行的最坏成本只在冷启动付一次；复验不过则丢弃缓存、
 * 回落完整探测并重写缓存。因此缓存从不"免验证"，驱动变化/设备更换都会被
 * 复验拦截，不存在拿着过期结论硬跑的风险。
 *
 * @param {string} ffmpegPath
 * @param {object} [opts]
 * @param {string} [opts.prefer] 优先尝试的编码器名（仍会真实测试，失败自动落到下一候选）
 * @param {(msg:string)=>void} [opts.onLog]
 * @param {number} [opts.width] 探测用宽度（应传真实采集分辨率）
 * @param {number} [opts.height] 探测用高度
 * @param {string|number} [opts.bitrate] 探测用码率（Mbps 或 '4M' 形式）
 * @param {boolean} [opts.cache] 设为 false 禁用读写缓存
 * @param {string} [opts.cacheFile] 缓存文件路径（测试注入）
 */
export async function selectEncoder(ffmpegPath, opts = {}) {
  const { prefer, onLog = () => {}, width, height, bitrate } = opts;

  const ordered = [...ENCODER_CANDIDATES];
  if (prefer) {
    const idx = ordered.findIndex((e) => e.name === prefer);
    if (idx > 0) {
      const [picked] = ordered.splice(idx, 1);
      ordered.unshift(picked);
    } else if (idx === -1) {
      // 指定了不在候选表里的名字（配置陈旧/手改），如实告知而不是静默忽略
      onLog(`指定的编码器 ${prefer} 不在候选列表中，忽略该偏好`);
    }
  }

  const testOpts = {};
  if (Number.isFinite(Number(width)) && Number(width) > 0) testOpts.width = Math.round(Number(width));
  if (Number.isFinite(Number(height)) && Number(height) > 0) testOpts.height = Math.round(Number(height));
  if (bitrate !== undefined && bitrate !== null && bitrate !== '') {
    testOpts.bitrate = String(bitrate).includes('M') ? String(bitrate) : `${bitrate}M`;
  }

  // ── 缓存快路径：一次复验替代全量串行探测 ──
  const cacheFile = opts.cacheFile || probeCacheFile();
  const sig = probeSig(ffmpegPath, { width, height, bitrate, prefer });
  if (opts.cache !== false) {
    const hit = readProbeCache(cacheFile, sig);
    if (hit) {
      const cached = ENCODER_CANDIDATES.find((e) => e.name === hit.encoder);
      if (cached) {
        const r = await testEncoder(ffmpegPath, cached, testOpts);
        if (r.ok) {
          onLog(`编码器可用(缓存复验): ${cached.name} (${cached.label})`);
          return { encoder: cached, tested: true, failures: [], cached: true };
        }
        onLog(`缓存的编码器 ${cached.name} 复验失败，重新完整探测`);
        try { fs.unlinkSync(cacheFile); } catch { /* 忽略 */ }
      }
    }
  }

  const failures = [];
  for (const enc of ordered) {
    const r = await testEncoder(ffmpegPath, enc, testOpts);
    if (r.ok) {
      onLog(`编码器可用: ${enc.name} (${enc.label})`);
      if (opts.cache !== false) writeProbeCache(cacheFile, sig, enc.name);
      return { encoder: enc, tested: true, failures };
    }
    // 只保留最后一行错误，避免刷屏
    const lastErr = (r.stderr || '').trim().split(/\r?\n/).filter(Boolean).pop() || '未知错误';
    failures.push({ name: enc.name, reason: lastErr });
    onLog(`编码器不可用: ${enc.name} — ${lastErr}`);
  }

  throw new CamToBgError('找不到任何可用的视频编码器', {
    code: ErrorCodes.ENCODER_UNAVAILABLE,
    hint: '请确认 ffmpeg 安装完整（需含 libx264 或将显卡驱动更新至最新）。已尝试: '
      + failures.map((f) => f.name).join(', '),
  });
}

/** 只列出 ffmpeg 报告的编码器名称（不做实测，速度快）。 */
export async function listEncoders(ffmpegPath) {
  const res = await runCaptured(ffmpegPath, ['-hide_banner', '-encoders'], { timeout: 15000 });
  const names = new Set();
  for (const line of (res.stdout + '\n' + res.stderr).split(/\r?\n/)) {
    const m = line.match(/^\s*[VAS][\w.]{5}\s+(\S+)/);
    if (m) names.add(m[1]);
  }
  return names;
}

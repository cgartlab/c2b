/**
 * encoder-probe.js — 探测可用的硬件/软件编码器
 *
 * 设计要点：不只看 `ffmpeg -encoders` 的列表，而是真的编码一帧。
 * 原因：编码器可能"存在于列表中"但因驱动问题无法初始化
 *（例如 AMF 在部分驱动版本上会初始化失败）。实测编码最有说服力。
 */
import { runCaptured } from './proc.js';
import { CamToBgError, ErrorCodes } from './errors.js';

/**
 * 候选编码器，按「硬件优先」排序。
 * 本机实测环境为 AMD Radeon 集显，因此 AMF 优先，MediaFoundation 作为通用回退。
 */
export const ENCODER_CANDIDATES = [
  // ── H.264 ──
  {
    name: 'h264_amf',
    label: 'AMD AMF H.264 (硬件)',
    hardware: true, vendor: 'amd', codec: 'h264',
    args: ['-c:v', 'h264_amf', '-usage', 'lowlatency', '-quality', 'speed'],
  },
  {
    name: 'h264_nvenc',
    label: 'NVIDIA NVENC H.264 (硬件)',
    hardware: true, vendor: 'nvidia', codec: 'h264',
    args: ['-c:v', 'h264_nvenc', '-preset', 'p1', '-tune', 'll'],
  },
  {
    name: 'h264_qsv',
    label: 'Intel QSV H.264 (硬件)',
    hardware: true, vendor: 'intel', codec: 'h264',
    args: ['-c:v', 'h264_qsv', '-preset', 'veryfast'],
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
    args: ['-c:v', 'hevc_amf', '-usage', 'lowlatency', '-quality', 'speed'],
  },
  {
    name: 'hevc_nvenc',
    label: 'NVIDIA NVENC H.265 (硬件)',
    hardware: true, vendor: 'nvidia', codec: 'hevc',
    args: ['-c:v', 'hevc_nvenc', '-preset', 'p1', '-tune', 'll'],
  },
  {
    name: 'hevc_qsv',
    label: 'Intel QSV H.265 (硬件)',
    hardware: true, vendor: 'intel', codec: 'hevc',
    args: ['-c:v', 'hevc_qsv', '-preset', 'veryfast'],
  },
  // ── AV1 ──
  {
    name: 'av1_amf',
    label: 'AMD AMF AV1 (硬件)',
    hardware: true, vendor: 'amd', codec: 'av1',
    args: ['-c:v', 'av1_amf', '-usage', 'lowlatency', '-quality', 'speed'],
  },
  {
    name: 'av1_nvenc',
    label: 'NVIDIA NVENC AV1 (硬件)',
    hardware: true, vendor: 'nvidia', codec: 'av1',
    args: ['-c:v', 'av1_nvenc', '-preset', 'p1', '-tune', 'll'],
  },
  // ── 软件 ──
  {
    name: 'libx264',
    label: 'x264 H.264 (软件)',
    hardware: false, vendor: 'any', codec: 'h264',
    args: ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency'],
  },
  {
    name: 'libx265',
    label: 'x265 H.265 (软件)',
    hardware: false, vendor: 'any', codec: 'hevc',
    args: ['-c:v', 'libx265', '-preset', 'ultrafast', '-tune', 'zerolatency'],
  },
];

/** 用合成源真实编码一小段，验证该编码器是否可用。 */
export async function testEncoder(ffmpegPath, encoder, opts = {}) {
  const { bitrate = '4M', width = 640, height = 480, timeout = 20000 } = opts;
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

/**
 * 依次测试候选编码器，返回第一个可用的。
 * @param {string} ffmpegPath
 * @param {object} [opts]
 * @param {string} [opts.prefer] 优先尝试的编码器名
 * @param {(msg:string)=>void} [opts.onLog]
 */
export async function selectEncoder(ffmpegPath, opts = {}) {
  const { prefer, onLog = () => {} } = opts;

  const ordered = [...ENCODER_CANDIDATES];
  if (prefer) {
    const idx = ordered.findIndex((e) => e.name === prefer);
    if (idx > 0) {
      const [picked] = ordered.splice(idx, 1);
      ordered.unshift(picked);
    }
  }

  const failures = [];
  for (const enc of ordered) {
    const r = await testEncoder(ffmpegPath, enc);
    if (r.ok) {
      onLog(`编码器可用: ${enc.name} (${enc.label})`);
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
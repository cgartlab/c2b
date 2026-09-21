/**
 * devices.js — 通过 ffmpeg dshow 枚举摄像头
 */
import { runCaptured } from './proc.js';
import { CamToBgError, ErrorCodes } from './errors.js';

/**
 * 解析 `ffmpeg -list_devices true -f dshow -i dummy` 的输出。
 *
 * 真实输出形如：
 *   [in#0 @ 0x...] "UGREEN Camera" (none)
 *   [in#0 @ 0x...]   Alternative name "@device_pnp_\\?\usb#vid_0c45&pid_2283..."
 *   [in#0 @ 0x...] "麦克风 (UGREEN Camera)" (audio)
 *
 * 纯函数，便于用固定样例做单测。
 *
 * @param {string} text ffmpeg 的 stderr 文本
 * @returns {Array<{name:string, type:'video'|'audio'|'unknown', alternative:string|null}>}
 */
export function parseDshowDevices(text) {
  const devices = [];
  const lines = String(text || '').split(/\r?\n/);

  // 形如: "设备名" (video|audio|none)
  const deviceRe = /"([^"]+)"\s*\((video|audio|none)\)\s*$/i;
  const altRe = /Alternative name\s+"([^"]+)"/i;

  let current = null;
  for (const raw of lines) {
    const line = raw.replace(/^\[[^\]]*\]\s*/, '');

    const alt = line.match(altRe);
    if (alt && current) {
      current.alternative = alt[1];
      continue;
    }

    const m = line.match(deviceRe);
    if (m) {
      current = {
        name: m[1],
        type: m[2].toLowerCase() === 'none' ? 'unknown' : m[2].toLowerCase(),
        alternative: null,
      };
      devices.push(current);
    }
  }
  return devices;
}

/**
 * 解析某个 dshow 设备支持的分辨率/帧率组合。
 *
 * 输出形如：
 *   [dshow @ ...]   pin "Capture" (alternative pin name "Capture")
 * 实测输出形如（注意关键字是 pixel_format，不是 vcodec）：
 *   [in#0 @ ...]   pixel_format=nv12  min s=2560x1440 fps=30 max s=2560x1440 fps=30
 *   [in#0 @ ...]   pixel_format=yuyv422 min s=640x480 fps=30 max s=640x480 fps=30
 *
 * 部分设备/驱动会打印 vcodec=，因此两种关键字都接受。
 *
 * @param {string} text
 * @returns {Array<{width:number,height:number,fps:number,format:string|null}>}
 */
export function parseDshowOptions(text) {
  const out = [];
  const seen = new Set();
  const re = /(?:vcodec|pixel_format)=(\S+)\s+min s=(\d+)x(\d+) fps=([\d.]+)\s+max s=(\d+)x(\d+) fps=([\d.]+)/gi;

  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    const fmt = m[1];
    const minW = Number(m[2]); const minH = Number(m[3]); const minFps = Number(m[4]);
    const maxW = Number(m[5]); const maxH = Number(m[6]); const maxFps = Number(m[7]);
    // 同一格式下可能给出区间，这里取两端
    for (const [w, h, fps] of [[minW, minH, minFps], [maxW, maxH, maxFps]]) {
      const key = `${fmt}|${w}x${h}@${fps}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ format: fmt, width: w, height: h, fps });
    }
  }
  return out;
}

/**
 * 从可用格式里挑出最接近目标分辨率/帧率的组合。
 * @param {Array} formats parseDshowOptions 的结果
 * @param {{width:number,height:number,fps:number}} target
 */
export function pickBestFormat(formats, target = {}) {
  if (!formats || !formats.length) return null;
  const tw = target.width || 1920;
  const th = target.height || 1080;
  const tf = target.fps || 30;

  const scored = formats.map((f) => {
    // 分辨率差异按面积比衡量，帧率差异按相对差
    const areaPenalty = Math.abs((f.width * f.height) - (tw * th)) / (tw * th);
    const fpsPenalty = Math.abs(f.fps - tf) / Math.max(tf, 1);
    // 帧率低于目标会明显掉帧，给额外惩罚
    const fpsShortfall = f.fps < tf ? 0.5 : 0;
    return { f, score: areaPenalty + fpsPenalty + fpsShortfall };
  });

  scored.sort((a, b) => a.score - b.score);
  return scored[0].f;
}

/** 列出所有 dshow 设备（视频与音频）。 */
export async function listDevices(ffmpegPath) {
  const res = await runCaptured(
    ffmpegPath,
    ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'],
    { timeout: 15000 },
  );
  // 设备列表是打印在 stderr 上的，且 ffmpeg 会以非 0 退出（"dummy" 打不开）
  const devices = parseDshowDevices(res.stderr + '\n' + res.stdout);
  return devices;
}

/** 只列摄像头。 */
export async function listVideoDevices(ffmpegPath) {
  const all = await listDevices(ffmpegPath);
  return all.filter((d) => d.type === 'video' || d.type === 'unknown');
}

/** 查询指定摄像头的可用格式。 */
export async function probeDeviceFormats(ffmpegPath, deviceName) {
  const res = await runCaptured(
    ffmpegPath,
    ['-hide_banner', '-list_options', 'true', '-f', 'dshow', '-i', `video=${deviceName}`],
    { timeout: 15000 },
  );
  return parseDshowOptions(res.stderr + '\n' + res.stdout);
}

/** 选择一个默认摄像头：优先名字里不含 Virtual/OBS 的实体摄像头。 */
export function pickDefaultCamera(devices) {
  if (!devices.length) return null;
  const virtualRe = /virtual|obs|manycam|snap camera|droidcam/i;
  const physical = devices.filter((d) => !virtualRe.test(d.name));
  const pool = physical.length ? physical : devices;
  // 稳定排序，保证多次运行结果一致
  return pool.slice().sort((a, b) => a.name.localeCompare(b.name))[0];
}

/** 确保有可用摄像头，否则抛出带中文提示的错误。 */
export async function requireVideoDevice(ffmpegPath, preferredName) {
  const devices = await listVideoDevices(ffmpegPath);
  if (!devices.length) {
    throw new CamToBgError('未检测到任何摄像头设备', {
      code: ErrorCodes.NO_DEVICE,
      hint: '请确认摄像头已连接，且未被其他程序独占；可在 Windows 设置 > 隐私和安全性 > 相机 中检查权限。',
    });
  }
  if (preferredName) {
    const exact = devices.find((d) => d.name === preferredName);
    if (exact) return exact;
    const loose = devices.find((d) => d.name.toLowerCase().includes(preferredName.toLowerCase()));
    if (loose) return loose;
    // 指定的设备不在，回退到默认并让调用方感知
    return { ...pickDefaultCamera(devices), fallbackFrom: preferredName };
  }
  return pickDefaultCamera(devices);
}
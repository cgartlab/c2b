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
 * 输出形如（关键字是 pixel_format，不是 vcodec）：
 *   pixel_format=nv12  min s=2560x1440 fps=30 max s=2560x1440 fps=30
 *   pixel_format=yuyv422 min s=640x480 fps=30 max s=640x480 fps=30
 *
 * 两种关键字（pixel_format/vcodec）都接受。
 *
 * **帧率区间语义**：当 min/max 分辨率相同而 fps 不同（如 min fps=5 max fps=60），
 * 驱动报告的是该分辨率下的**连续帧率区间**——区间内任意值都受支持。
 * 历史实现只取两端点，用户要 30fps 会被协商成 5 或 60。这里把区间
 * 附着在条目上（fpsRange），由 pickBestFormat 在目标帧率落在区间内时采用目标值。
 * 分辨率的 min≠max 不做插值发明：dshow 分辨率通常是离散模式，
 * 编造一个驱动并不支持的分辨率会让整条管线启动失败（比取端点更糟）。
 *
 * @param {string} text
 * @returns {Array<{width:number,height:number,fps:number,format:string|null,
 *                  fpsRange?:{min:number,max:number}>}
 */
export function parseDshowOptions(text) {
  const out = [];
  const seen = new Map();
  const re = /(?:vcodec|pixel_format)=(\S+)\s+min s=(\d+)x(\d+) fps=([\d.]+)\s+max s=(\d+)x(\d+) fps=([\d.]+)/gi;

  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    const fmt = m[1];
    const minW = Number(m[2]); const minH = Number(m[3]); const minFps = Number(m[4]);
    const maxW = Number(m[5]); const maxH = Number(m[6]); const maxFps = Number(m[7]);

    // 同一分辨率 + fps 不同 → 连续帧率区间
    const range = (minW === maxW && minH === maxH && minFps < maxFps)
      ? { min: minFps, max: maxFps }
      : null;

    // 同一格式下可能给出区间，这里取两端
    for (const [w, h, fps] of [[minW, minH, minFps], [maxW, maxH, maxFps]]) {
      const key = `${fmt}|${w}x${h}@${fps}`;
      const existing = seen.get(key);
      if (existing) {
        if (range && !existing.fpsRange) existing.fpsRange = range;
        continue;
      }
      const entry = { format: fmt, width: w, height: h, fps };
      if (range) entry.fpsRange = range;
      seen.set(key, entry);
      out.push(entry);
    }
  }
  return out;
}

/**
 * 从可用格式里挑出最接近目标分辨率/帧率的组合。
 *
 * 若条目带 fpsRange 且目标帧率落在区间内，采用**目标帧率**（区间语义下
 * 该值受支持）并按 0 帧率罚分参与排序——修复"支持 5–60fps 的设备
 * 永远协商不到 30fps"的历史缺陷。
 *
 * @param {Array} formats parseDshowOptions 的结果
 * @param {{width:number,height:number,fps:number}} target
 */
export function pickBestFormat(formats, target = {}) {
  if (!formats || !formats.length) return null;
  const tw = target.width || 1920;
  const th = target.height || 1080;
  const tf = target.fps || 30;

  const scored = formats.map((f) => {
    // 区间内 → 采用目标帧率（驱动已声明支持）
    let fps = f.fps;
    const r = f.fpsRange;
    const effective = (r && tf >= r.min && tf <= r.max) ? tf : f.fps;
    // 分辨率差异按面积比衡量，帧率差异按相对差
    const areaPenalty = Math.abs((f.width * f.height) - (tw * th)) / (tw * th);
    const fpsPenalty = Math.abs(effective - tf) / Math.max(tf, 1);
    // 帧率低于目标会明显掉帧，给额外惩罚
    const fpsShortfall = effective < tf ? 0.5 : 0;
    return { f: { ...f, fps: effective }, score: areaPenalty + fpsPenalty + fpsShortfall };
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

/**
 * 为设备生成**打开用唯一标识**（value）与界面标签（label），处理重名。
 *
 * Windows 上两个同型号设备的显示名完全相同：dshow 按名打开只能命中其
 * 枚举到的第一个，第二个**永远选不中**，且枚举顺序不保证跨会话稳定。
 * 官方 DirectShow 备用名（@device_pnp_… / @device_sw_…）就是为唯一定位而生，
 * 本机实测 `video=<备用名>` 可完整打开设备并编码（OBS 虚拟摄像头 exit=0）。
 *
 * 策略：
 *   · 首个重名者仍用显示名作 value —— 兼容既有 plain-name 配置、且默认选择不变
 *   · 后续重名者 value=备用名、label="名称 (2)" —— 界面从此**选得中第二个**
 *   · 极端：无备用名的重名者保持按名（本质无法唯一定位），标签注明
 *
 * 非重名设备 value===name —— 与历史行为 100% 一致（真机路径零变化）。
 *
 * @param {Array<{name:string, alternative:string|null}>} devices
 */
export function disambiguateDevices(devices) {
  const seen = new Map();
  return (devices || []).map((d) => {
    const n = (seen.get(d.name) || 0) + 1;
    seen.set(d.name, n);
    if (n === 1) return { ...d, value: d.name, label: d.name, duplicated: false };
    if (d.alternative) return { ...d, value: d.alternative, label: `${d.name} (${n})`, duplicated: true };
    return { ...d, value: d.name, label: `${d.name} (${n}·无法唯一定位)`, duplicated: true };
  });
}

/**
 * 按用户选择解析设备（纯函数，便于测试）。
 *
 * 匹配顺序：
 *   1. value 精确（界面保存的重名项就是备用名）
 *   2. 显示名 / 备用名精确（兼容手写与历史配置）
 *   3. 显示名包含（模糊回退）
 *
 * @param {Array} devices disambiguateDevices 的结果
 * @param {string} preferred 用户选择（value 或历史 plain name）
 * @returns {object|null}
 */
export function resolvePreferred(devices, preferred) {
  if (!preferred) return null;
  const byValue = devices.find((d) => d.value === preferred);
  if (byValue) return byValue;
  const lower = String(preferred).toLowerCase();
  return devices.find((d) => d.name.toLowerCase() === lower)
    || devices.find((d) => (d.alternative || '').toLowerCase() === lower)
    || devices.find((d) => d.name.toLowerCase().includes(lower))
    || null;
}

/**
 * 确保有可用摄像头，否则抛出带中文提示的错误。
 * 返回值带 `openAs`（喂给 dshow 的打开标识）与 `name`（界面显示名）。
 */
export async function requireVideoDevice(ffmpegPath, preferredName) {
  const raw = await listVideoDevices(ffmpegPath);
  if (!raw.length) {
    throw new CamToBgError('未检测到任何摄像头设备', {
      code: ErrorCodes.NO_DEVICE,
      hint: '请确认摄像头已连接，且未被其他程序独占；可在 Windows 设置 > 隐私和安全性 > 相机 中检查权限。',
    });
  }
  const devices = disambiguateDevices(raw);
  if (preferredName) {
    const hit = resolvePreferred(devices, preferredName);
    if (hit) return { ...hit, openAs: hit.value };
    // 指定的设备不在，回退到默认并让调用方感知
    const fallback = pickDefaultCamera(devices);
    return { ...fallback, openAs: fallback.value, fallbackFrom: preferredName };
  }
  const picked = pickDefaultCamera(devices);
  return { ...picked, openAs: picked.value };
}
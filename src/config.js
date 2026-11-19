/**
 * config.js — 配置定义、校验与读写
 *
 * 所有可调项集中在这里定义（含范围与默认值），
 * 设置界面据此自动生成控件，避免前后端参数定义漂移。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { CamToBgError, ErrorCodes } from './errors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.join(__dirname, '..');

/** 配置文件的存放位置（用户目录，便于持久化）。 */
export function configPath() {
  const dir = process.env.CAM_TO_BG_HOME || path.join(os.homedir(), '.cam-to-bg');
  return path.join(dir, 'config.json');
}

/**
 * WHATWG/浏览器"禁止访问端口"（bad ports）—— fetch/浏览器对这些端口一律拒绝。
 * uiPort 若设成这类端口（如 6000、10080）：HTTP 服务**绑得上**，但浏览器打开、
 * fetch 请求、`c2b set` 的在线转发**全部被拒** → 设置界面永久打不开、还查不出原因。
 * 因此配置校验必须拦截（第42轮：范围校验 min1024/max65535 放行了 6000）。
 */
export const BROWSER_FORBIDDEN_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540,
  548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 1755,
  2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6679, 6697, 10080,
]);

/** 该端口是否为浏览器/fetch 拒绝访问的保留端口。 */
export function isBrowserForbiddenPort(p) {
  return BROWSER_FORBIDDEN_PORTS.has(Number(p));
}

/**
 * 参数定义表。
 * 每项含：type、默认值、取值范围、是否需要重启管线、界面分组与中文标签。
 */
export const SCHEMA = {
  // ── 设备 ──
  device: {
    type: 'string', default: '', restart: true, group: '设备', label: '摄像头',
    help: '留空则自动选择第一个物理摄像头',
  },
  width: {
    type: 'number', default: 1920, min: 160, max: 7680, step: 2, restart: true,
    group: '设备', label: '采集宽度',
  },
  height: {
    type: 'number', default: 1080, min: 120, max: 4320, step: 2, restart: true,
    group: '设备', label: '采集高度',
  },

  // ── 画面 ──
  fps: {
    type: 'number', default: 30, min: 1, max: 120, step: 1, restart: true,
    group: '画面', label: '帧率 (FPS)',
    help: '摄像头采集与输出帧率',
  },
  scaleMode: {
    type: 'enum', default: 'fill', values: ['fill', 'fit', 'stretch'], restart: true,
    group: '画面', label: '缩放模式',
    help: 'fill=裁切铺满(推荐) / fit=完整显示留黑边 / stretch=拉伸变形',
  },
  flipHorizontal: {
    type: 'boolean', default: false, restart: true,
    group: '画面', label: '水平翻转',
    help: '左右反转（镜像）。常用于摄像头画面与真人方向一致的场景',
  },
  flipVertical: {
    type: 'boolean', default: false, restart: true,
    group: '画面', label: '垂直翻转',
    help: '上下反转。摄像头倒装时使用',
  },
  rotate: {
    type: 'enum', default: '0', values: ['0', '90', '180', '270'], restart: true,
    group: '画面', label: '旋转',
  },

  // ── 色彩 ──
  brightness: {
    type: 'number', default: 0, min: -1, max: 1, step: 0.01, restart: false,
    group: '色彩', label: '亮度',
  },
  contrast: {
    type: 'number', default: 1, min: 0, max: 3, step: 0.01, restart: false,
    group: '色彩', label: '对比度',
  },
  saturation: {
    type: 'number', default: 1, min: 0, max: 3, step: 0.01, restart: false,
    group: '色彩', label: '饱和度',
  },
  gamma: {
    type: 'number', default: 1, min: 0.1, max: 4, step: 0.01, restart: false,
    group: '色彩', label: 'Gamma',
  },
  exposure: {
    type: 'number', default: 0, min: -3, max: 3, step: 0.01, restart: false,
    group: '色彩', label: '曝光',
  },
  temperature: {
    type: 'number', default: 0, min: -1, max: 1, step: 0.01, restart: false,
    group: '色彩', label: '色温',
    help: '负值偏冷(蓝)，正值偏暖(红)',
  },
  hue: {
    type: 'number', default: 0, min: -180, max: 180, step: 1, restart: false,
    group: '色彩', label: '色相',
  },

  // ── 编码 ──
  bitrate: {
    type: 'number', default: 8, min: 0.5, max: 100, step: 0.5, restart: true,
    group: '编码', label: '码率 (Mbps)',
    help: '码率目标/上限。AMF(H.264/265) 与 QSV 走画质优先模式，不使用码率',
  },
  encoder: {
    type: 'enum', default: 'auto',
    values: ['auto', 'h264_amf', 'h264_nvenc', 'h264_qsv', 'h264_mf', 'libx264',
             'hevc_amf', 'hevc_nvenc', 'hevc_qsv', 'libx265',
             'av1_amf', 'av1_nvenc'],
    restart: true, group: '编码', label: '编码器',
    help: 'auto=自动实测挑选可用的硬件编码器',
  },
  quality: {
    type: 'number', default: 23, min: 0, max: 51, step: 1, restart: true,
    group: '编码', label: '画质 (0 最好)',
    help: '映射：x264/x265=CRF、AMF=CQP、NVENC=CQ、QSV=ICQ、MF(壁管)=质量模式',
  },

  // ── 其他 ──
  monitor: {
    type: 'number', default: 0, min: 0, max: 15, step: 1, restart: true,
    group: '其他', label: '显示器序号',
    help: '0=主显示器。多屏下仅决定输出画幅；壁纸窗口固定挂载主屏（Windows 桌面宿主所限）',
  },
  uiPort: {
    type: 'number', default: 5757, min: 1024, max: 65535, step: 1, restart: false,
    group: '其他', label: '设置界面端口',
    help: '改后界面立即在新端口重新监听；若新端口被占用会自动回退并提示',
  },
  // ── 延迟 ──
  latencyMode: {
    type: 'enum', default: 'ultra-low', values: ['ultra-low', 'balanced', 'smooth'],
    restart: true, group: '延迟', label: '延迟模式',
    help: 'ultra-low=最低延迟(默认) / balanced=B帧+短前瞻折中 / smooth=前瞻+B帧优先流畅',
  },

  // ── 录制 ──
  recFps: {
    type: 'number', default: 30, min: 1, max: 60, step: 1, restart: false,
    group: '录制', label: '录制帧率',
  },
  recBitrate: {
    type: 'number', default: 10, min: 0.5, max: 100, step: 0.5, restart: false,
    group: '录制', label: '录制码率 (Mbps)',
    help: 'AMF/QSV 录制走画质优先模式，不使用码率',
  },
  recQuality: {
    type: 'number', default: 20, min: 0, max: 51, step: 1, restart: false,
    group: '录制', label: '录制画质 (0 最好)',
    help: '数值越小画质越好；MF 编码器的录制以码率为准、不使用该项',
  },
  recAudioDevice: {
    type: 'string', default: '', restart: false, group: '录制', label: '麦克风',
    help: '下拉选择要录制的麦克风；留空不录音频（重名麦克风以序号区分）',
  },
  recFolder: {
    type: 'string', default: '', restart: false, group: '录制', label: '输出文件夹',
    help: '留空=默认到 ~/Videos',
  },

  // ── 日志 ──
  logLevel: {
    type: 'enum', default: 'info', values: ['debug', 'info', 'warn', 'error'],
    // 即时生效（index.js 在配置变更时直接 setLevel）。历史缺陷：标 restart:true
    // 却既不在 applyConfig 分类里（不弹提示）、重启按钮也不重建 logger —— 双重谎言。
    restart: false, group: '日志', label: '日志级别',
    help: 'debug=最详细 / info=默认 / warn=仅警告与错误 / error=仅错误（改动立即生效）',
  },
  logRetainRuns: {
    type: 'number', default: 10, min: 1, max: 100, step: 1,
    // 即时生效（index.js 在配置变更时直接执行 cleanupOldRuns）
    restart: false, group: '日志', label: '保留运行数',
    help: '自动清理，只保留最近 N 次运行的日志（改动立即生效）',
  },

  // ── 其他 ──
  openUiOnStart: {
    type: 'boolean', default: true, restart: false, group: '其他', label: '启动时打开设置界面',
    help: '仅影响下次启动应用时是否自动打开（当前实例不受影响）',
  },
};

/** 生成一份默认配置。 */
export function defaultConfig() {
  const cfg = {};
  for (const [key, def] of Object.entries(SCHEMA)) cfg[key] = def.default;
  return cfg;
}

/** 把单个值强制转换并夹到合法范围。非法值回退到默认值。 */
export function coerceValue(key, raw) {
  const def = SCHEMA[key];
  if (!def) return undefined;

  switch (def.type) {
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number.parseFloat(String(raw));
      if (!Number.isFinite(n)) return def.default;
      // 对齐步进网格并消除浮点噪声：0.1+0.2 类噪声（0.30000000000000004）
      // 会原样写进 config.json 并向下游传播；toFixed 裁剪是关键
      //（30 * 0.01 在 IEEE 下本身就是 0.30000000000000004，仅靠乘除不够）。
      let v = n;
      if (def.step && def.step > 0) {
        v = Math.round(n / def.step) * def.step;
        v = Number(v.toFixed(6));
      }
      return Math.min(def.max, Math.max(def.min, v));
    }
    case 'boolean': {
      if (typeof raw === 'boolean') return raw;
      if (typeof raw === 'string') return raw === 'true' || raw === '1' || raw === 'on';
      if (typeof raw === 'number') return raw !== 0;
      return def.default;
    }
    case 'enum': {
      const s = String(raw);
      // rotate 的值是数字字符串，需要单独处理
      return def.values.includes(s) ? s : def.default;
    }
    case 'string':
    default:
      return raw === undefined || raw === null ? def.default : String(raw);
  }
}

/**
 * 校验并规范化一份配置。未知键会被丢弃，非法值会被修正。
 * @param {object} input
 * @returns {{config: object, warnings: string[]}}
 */
export function normalizeConfig(input) {
  const warnings = [];
  const config = defaultConfig();
  if (!input || typeof input !== 'object') return { config, warnings };

  // 向后兼容：早期版本用单个 mirror 表示水平镜像，现已拆分为
  // flipHorizontal / flipVertical 两个独立开关。
  const migrated = { ...input };
  if ('mirror' in migrated && !('flipHorizontal' in migrated)) {
    migrated.flipHorizontal = migrated.mirror;
    warnings.push('配置项 mirror 已更名为 flipHorizontal，已自动迁移');
  }

  for (const [key, raw] of Object.entries(migrated)) {
    if (key === 'mirror') continue; // 已迁移，丢弃旧键
    const def = SCHEMA[key];
    if (!def) {
      warnings.push(`忽略未知配置项: ${key}`);
      continue;
    }
    let value = coerceValue(key, raw);
    // uiPort 特例：范围内但属浏览器禁止端口（如 6000）→ 服务绑得上、
    // 浏览器/fetch/c2b set 在线转发**全被拒** → 界面永久打不开且难查。
    // 回退到默认端口并如实告警（回退后界面仍可访问，用户能从 c2b config 看到原因）。
    if (key === 'uiPort' && typeof value === 'number' && isBrowserForbiddenPort(value)) {
      warnings.push(`uiPort=${value} 是浏览器禁止访问的保留端口，已回退为 ${def.default}`);
      value = def.default;
    }
    if (def.type === 'number' && typeof raw !== 'undefined') {
      const asNum = typeof raw === 'number' ? raw : Number.parseFloat(String(raw));
      if (Number.isFinite(asNum) && (asNum < def.min || asNum > def.max)) {
        warnings.push(`${key}=${asNum} 超出范围 [${def.min}, ${def.max}]，已夹到 ${value}`);
      } else if (Number.isFinite(asNum) && typeof value === 'number'
        && Math.abs(asNum - value) > 1e-6) {
        // 范围内但真实偏离网格（如 fps 29.9→30）：如实告警，不静默改值。
        // 阈值 1e-6：纯 IEEE 浮点噪声（1e-17 量级）属不可见清理，静默处理，
        // 避免正常保存被噪音告警淹没。
        warnings.push(`${key}=${asNum} 已对齐步进 ${def.step} → ${value}`);
      }
    }
    if (def.type === 'enum' && !def.values.includes(String(raw))) {
      warnings.push(`${key}="${raw}" 不是合法取值，已回退为 "${def.default}"`);
    }
    config[key] = value;
  }
  return { config, warnings };
}

/** 读取配置；文件不存在时返回默认配置。 */
export function loadConfig() {
  const file = configPath();
  const { config, warnings } = normalizeConfig(readRaw(file));
  return { config, warnings, path: file };
}

function readRaw(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new CamToBgError(`配置文件解析失败: ${file}`, {
      code: ErrorCodes.CONFIG_INVALID,
      hint: `请检查该文件是否为合法 JSON，或直接删除它以恢复默认设置。原始错误: ${err.message}`,
    });
  }
}

/** 写入配置（原子写入：先写临时文件再改名）。 */
export function saveConfig(config) {
  const file = configPath();
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });

  const { config: clean } = normalizeConfig(config);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(clean, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return { path: file, config: clean };
}

/**
 * 合并部分更新：只覆盖提供的键，并返回规范化后的完整配置。
 */
export function mergeConfig(base, patch) {
  const merged = { ...base, ...patch };
  const { config, warnings } = normalizeConfig(merged);
  return { config, warnings };
}

/** 供设置界面使用的元数据（不含函数）。 */
export function schemaForUi() {
  const out = {};
  for (const [key, def] of Object.entries(SCHEMA)) {
    out[key] = {
      type: def.type,
      default: def.default,
      min: def.min,
      max: def.max,
      step: def.step,
      values: def.values,
      group: def.group,
      label: def.label,
      help: def.help,
      restart: def.restart,
    };
  }
  return out;
}
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
    type: 'enum', default: 'fill', values: ['fill', 'fit', 'stretch'], restart: false,
    group: '画面', label: '缩放模式',
    help: 'fill=裁切铺满(推荐) / fit=完整显示留黑边 / stretch=拉伸变形',
  },
  flipHorizontal: {
    type: 'boolean', default: false, restart: false,
    group: '画面', label: '水平翻转',
    help: '左右反转（镜像）。常用于摄像头画面与真人方向一致的场景',
  },
  flipVertical: {
    type: 'boolean', default: false, restart: false,
    group: '画面', label: '垂直翻转',
    help: '上下反转。摄像头倒装时使用',
  },
  rotate: {
    type: 'enum', default: '0', values: ['0', '90', '180', '270'], restart: false,
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
    help: '仅影响本地回环带宽与画质，越高越清晰',
  },
  encoder: {
    type: 'enum', default: 'auto',
    values: ['auto', 'h264_amf', 'h264_nvenc', 'h264_qsv', 'h264_mf', 'libx264',
             'hevc_amf', 'hevc_nvenc', 'hevc_qsv', 'libx265',
             'av1_amf', 'av1_nvenc'],
    restart: true, group: '编码', label: '编码器',
    help: 'auto=自动挑选可用的硬件编码器',
  },
  quality: {
    type: 'number', default: 23, min: 0, max: 51, step: 1, restart: true,
    group: '编码', label: '画质 (CRF/CQ)',
    help: '数值越小画质越好；硬件编码器下映射为 CQ',
  },

  // ── 其他 ──
  monitor: {
    type: 'number', default: 0, min: 0, max: 15, step: 1, restart: true,
    group: '其他', label: '显示器序号',
    help: '0=主显示器；多屏时按序号选择',
  },
  uiPort: {
    type: 'number', default: 5757, min: 1024, max: 65535, step: 1, restart: true,
    group: '其他', label: '设置界面端口',
  },
  // ── 延迟 ──
  latencyMode: {
    type: 'enum', default: 'ultra-low', values: ['ultra-low', 'balanced', 'smooth'],
    restart: true, group: '延迟', label: '延迟模式',
    help: 'ultra-low=最低延迟(默认) / balanced=折中 / smooth=优先流畅不丢帧',
  },

  // ── 录制 ──
  recFps: {
    type: 'number', default: 30, min: 1, max: 60, step: 1, restart: false,
    group: '录制', label: '录制帧率',
  },
  recBitrate: {
    type: 'number', default: 10, min: 0.5, max: 100, step: 0.5, restart: false,
    group: '录制', label: '录制码率 (Mbps)',
  },
  recQuality: {
    type: 'number', default: 20, min: 0, max: 51, step: 1, restart: false,
    group: '录制', label: '录制画质',
    help: '数值越小画质越好',
  },
  recAudioDevice: {
    type: 'string', default: '', restart: false, group: '录制', label: '麦克风',
    help: '留空=不录音频；填设备名=录制麦克风',
  },
  recFolder: {
    type: 'string', default: '', restart: false, group: '录制', label: '输出文件夹',
    help: '留空=默认到 ~/Videos',
  },

  // ── 日志 ──
  logLevel: {
    type: 'enum', default: 'info', values: ['debug', 'info', 'warn', 'error'],
    restart: true, group: '日志', label: '日志级别',
    help: 'debug=最详细 / info=默认 / warn=仅警告与错误 / error=仅错误',
  },
  logRetainRuns: {
    type: 'number', default: 10, min: 1, max: 100, step: 1, restart: true,
    group: '日志', label: '保留运行数',
    help: '自动清理，只保留最近 N 次运行的日志',
  },

  // ── 其他 ──
  openUiOnStart: {
    type: 'boolean', default: true, restart: false, group: '其他', label: '启动时打开设置界面',
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
      return Math.min(def.max, Math.max(def.min, n));
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
    const value = coerceValue(key, raw);
    if (def.type === 'number' && typeof raw !== 'undefined') {
      const asNum = typeof raw === 'number' ? raw : Number.parseFloat(String(raw));
      if (Number.isFinite(asNum) && (asNum < def.min || asNum > def.max)) {
        warnings.push(`${key}=${asNum} 超出范围 [${def.min}, ${def.max}]，已夹到 ${value}`);
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
/**
 * devices.test.js — dshow 输出解析测试
 *
 * 这里的样例文本都取自本机真实运行 ffmpeg 的输出，
 * 因此能真实反映解析器面对的实际格式（含中文设备名、多格式行等）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDshowDevices,
  parseDshowOptions,
  pickBestFormat,
  disambiguateDevices,
  resolvePreferred,
  requireVideoDevice,
} from '../src/devices.js';

// 真实输出片段（含视频、音频与 alternative name）
const LIST_DEVICES_OUTPUT = `
[in#0 @ 0000025e1621f940] "UGREEN Camera" (none)
[in#0 @ 0000025e1621f940]   Alternative name "@device_pnp_\\\\?\\usb#vid_0c45&pid_2283&mi_00#7&287ca144&0&0000#{65e8773d-8f56-11d0-a3b9-00a0c9223196}\\global"
[in#0 @ 0000025e1621f940] "OBS Virtual Camera" (video)
[in#0 @ 0000025e1621f940]   Alternative name "@device_sw_{860BB310-5D01-11D0-BD3B-00A0C911CE86}\\{A3FCE0F5-3493-419F-958A-ABA1250EC20B}"
[in#0 @ 0000025e1621f940] "麦克风 (UGREEN Camera)" (audio)
[in#0 @ 0000025e1621f940]   Alternative name "@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\\wave_{EF954349-454E-414E-A652-2E227F06EDCD}"
[in#0 @ 0000025e1621f940] "阵列麦克风 (AMD Audio Device)" (audio)
`;

// 真实 list_options 输出（关键字是 pixel_format）
const LIST_OPTIONS_OUTPUT = `
[in#0 @ 00000190679b2300] DirectShow video device options (from video devices)
[in#0 @ 00000190679b2300]  Pin "Video Output" (alternative pin name "Output Pin")
[in#0 @ 00000190679b2300]   pixel_format=nv12  min s=2560x1440 fps=30 max s=2560x1440 fps=30
[in#0 @ 00000190679b2300]   pixel_format=yuv420p  min s=2560x1440 fps=30 max s=2560x1440 fps=30
[in#0 @ 00000190679b2300]   pixel_format=yuyv422  min s=2560x1440 fps=30 max s=2560x1440 fps=30
`;

test('解析出视频与音频设备', () => {
  const devices = parseDshowDevices(LIST_DEVICES_OUTPUT);
  const names = devices.map((d) => d.name);
  assert.ok(names.includes('UGREEN Camera'));
  assert.ok(names.includes('OBS Virtual Camera'));
  assert.ok(names.includes('麦克风 (UGREEN Camera)'));
});

test('(none) 被归类为 unknown，而非误判为 video', () => {
  const devices = parseDshowDevices(LIST_DEVICES_OUTPUT);
  const ugreen = devices.find((d) => d.name === 'UGREEN Camera');
  assert.equal(ugreen.type, 'unknown');

  const obs = devices.find((d) => d.name === 'OBS Virtual Camera');
  assert.equal(obs.type, 'video');

  const mic = devices.find((d) => d.name === '麦克风 (UGREEN Camera)');
  assert.equal(mic.type, 'audio');
});

test('alternative name 归属到正确的设备', () => {
  const devices = parseDshowDevices(LIST_DEVICES_OUTPUT);
  const ugreen = devices.find((d) => d.name === 'UGREEN Camera');
  assert.ok(ugreen.alternative, '应解析出 alternative name');
  assert.match(ugreen.alternative, /vid_0c45/);

  const mic = devices.find((d) => d.name === '麦克风 (UGREEN Camera)');
  assert.match(mic.alternative, /device_cm_/);
});

test('解析 pixel_format 关键字（而非 vcodec）', () => {
  const formats = parseDshowOptions(LIST_OPTIONS_OUTPUT);
  assert.ok(formats.length >= 3, `应解析出至少 3 个格式，实际 ${formats.length}`);
  assert.ok(formats.some((f) => f.format === 'nv12'));
  assert.ok(formats.some((f) => f.format === 'yuyv422'));
});

test('解析出的分辨率与帧率数值正确', () => {
  const formats = parseDshowOptions(LIST_OPTIONS_OUTPUT);
  const nv12 = formats.find((f) => f.format === 'nv12');
  assert.equal(nv12.width, 2560);
  assert.equal(nv12.height, 1440);
  assert.equal(nv12.fps, 30);
});

test('vcodec 关键字同样被支持（部分驱动会这样输出）', () => {
  const text = '   vcodec=mjpeg min s=640x480 fps=30 max s=1280x720 fps=60';
  const formats = parseDshowOptions(text);
  assert.ok(formats.some((f) => f.format === 'mjpeg' && f.width === 640));
  assert.ok(formats.some((f) => f.format === 'mjpeg' && f.width === 1280 && f.fps === 60));
});

test('同一格式的重复行被去重', () => {
  const text = `
   pixel_format=nv12 min s=1920x1080 fps=30 max s=1920x1080 fps=30
   pixel_format=nv12 min s=1920x1080 fps=30 max s=1920x1080 fps=30
`;
  const formats = parseDshowOptions(text);
  assert.equal(formats.length, 1, '完全相同的格式应只保留一条');
});

test('空输入返回空结果而不抛错', () => {
  assert.deepEqual(parseDshowDevices(''), []);
  assert.deepEqual(parseDshowDevices(null), []);
  assert.deepEqual(parseDshowOptions(''), []);
  assert.deepEqual(parseDshowOptions(undefined), []);
});

/* ────── 帧率区间语义：同一分辨率 min≠max fps = 连续区间 ────── */

const RANGE_TEXT = '  pixel_format=yuyv422 min s=1920x1080 fps=5 max s=1920x1080 fps=60';

test('同分辨率 fps min≠max → 解析出 fpsRange 区间', () => {
  const formats = parseDshowOptions(RANGE_TEXT);
  assert.equal(formats.length, 2, '仍取两端点作为条目');
  for (const f of formats) {
    assert.deepEqual(f.fpsRange, { min: 5, max: 60 }, `${f.fps} 端点应附带区间`);
  }
});

test('pickBestFormat：目标 30fps 落在区间 [5,60] 内 → 协商出 30 而非端点', () => {
  const formats = parseDshowOptions(RANGE_TEXT);
  const best = pickBestFormat(formats, { width: 1920, height: 1080, fps: 30 });
  assert.equal(best.fps, 30, '历史缺陷：只取端点会得到 5 或 60');
  assert.equal(best.width, 1920);
});

test('pickBestFormat：目标超出区间 → 退回端点（不发明驱动未声明的值）', () => {
  const formats = parseDshowOptions(RANGE_TEXT);
  const best = pickBestFormat(formats, { width: 1920, height: 1080, fps: 120 });
  assert.equal(best.fps, 60, '120 > max(60)，应取最高的可用端点');
});

test('离散模式（min==max）不产生 fpsRange，行为与历史一致', () => {
  const formats = parseDshowOptions(' pixel_format=nv12 min s=640x480 fps=30 max s=640x480 fps=30');
  assert.ok(formats.every((f) => f.fpsRange === undefined));
});

test('pickBestFormat 挑选完全匹配的格式', () => {
  const formats = [
    { format: 'nv12', width: 640, height: 480, fps: 30 },
    { format: 'nv12', width: 1920, height: 1080, fps: 30 },
    { format: 'nv12', width: 2560, height: 1440, fps: 30 },
  ];
  const best = pickBestFormat(formats, { width: 1920, height: 1080, fps: 30 });
  assert.equal(best.width, 1920);
  assert.equal(best.height, 1080);
});

test('pickBestFormat 在无完全匹配时选最接近的', () => {
  const formats = [
    { format: 'nv12', width: 2560, height: 1440, fps: 30 },
    { format: 'nv12', width: 640, height: 480, fps: 30 },
  ];
  // 请求 1920x1080，2560x1440 的面积更接近
  const best = pickBestFormat(formats, { width: 1920, height: 1080, fps: 30 });
  assert.equal(best.width, 2560);
});

test('pickBestFormat 偏好不低于目标帧率的格式', () => {
  const formats = [
    { format: 'nv12', width: 1920, height: 1080, fps: 15 },
    { format: 'nv12', width: 1920, height: 1080, fps: 30 },
  ];
  const best = pickBestFormat(formats, { width: 1920, height: 1080, fps: 30 });
  assert.equal(best.fps, 30, '相同分辨率下应选满足帧率要求的');
});

test('pickBestFormat 对空数组返回 null', () => {
  assert.equal(pickBestFormat([], { width: 1920, height: 1080 }), null);
  assert.equal(pickBestFormat(null), null);
});

/* ────── 重名设备消歧（两个同型号摄像头此前第二个永远选不中） ────── */

const twinCams = () => [
  { name: 'USB Camera', type: 'video', alternative: '@device_pnp_A' },
  { name: 'USB Camera', type: 'video', alternative: '@device_pnp_B' },
  { name: 'Solo Cam', type: 'video', alternative: '@device_pnp_C' },
];

test('disambiguate：首个重名保留显示名（兼容既有配置），第二个用备用名', () => {
  const out = disambiguateDevices(twinCams());
  assert.equal(out[0].value, 'USB Camera', '首名者 value 必须保持显示名（历史配置 plain name 兼容）');
  assert.equal(out[0].label, 'USB Camera');
  assert.equal(out[0].duplicated, false);
  assert.equal(out[1].value, '@device_pnp_B', '第二个必须用备用名，否则 dshow 按名打开永远命中第一个');
  assert.equal(out[1].label, 'USB Camera (2)', '界面标签必须可区分');
  assert.equal(out[1].duplicated, true);
  assert.equal(out[2].value, 'Solo Cam', '非重名设备完全不受影响（value===name）');
});

test('disambiguate：无备用名的重名者如实标注"无法唯一定位"', () => {
  const out = disambiguateDevices([
    { name: 'X', type: 'video', alternative: null },
    { name: 'X', type: 'video', alternative: null },
  ]);
  assert.equal(out[1].value, 'X', '没有备用名时技术上无法唯一定位');
  assert.match(out[1].label, /无法唯一定位/, '不能假装选中了第二个');
});

test('resolvePreferred：value 精确（界面保存的备用名）优先', () => {
  const out = disambiguateDevices(twinCams());
  assert.equal(resolvePreferred(out, '@device_pnp_B').label, 'USB Camera (2)');
});

test('resolvePreferred：历史 plain name → 首个重名者', () => {
  const out = disambiguateDevices(twinCams());
  const hit = resolvePreferred(out, 'USB Camera');
  assert.equal(hit.alternative, '@device_pnp_A', '按 plain name 应命中第一个重名者（其备用名为 A）');
  assert.equal(hit.label, 'USB Camera', '首名者的 value/label 均为显示名');
});

test('resolvePreferred：备用名/模糊回退/未命中', () => {
  const out = disambiguateDevices(twinCams());
  assert.equal(resolvePreferred(out, '@device_pnp_C').name, 'Solo Cam', '按备用名直接命中');
  assert.equal(resolvePreferred(out, 'solo').name, 'Solo Cam', '模糊回退');
  assert.equal(resolvePreferred(out, '不存在的设备'), null);
  assert.equal(resolvePreferred(out, null), null);
});

test('requireVideoDevice（真机）：openAs 存在；唯一设备时 openAs===显示名', async () => {
  const { resolveExecutable, listVideoDevices } = await (async () => {
    const proc = await import('../src/proc.js');
    const dev = await import('../src/devices.js');
    return { resolveExecutable: proc.resolveExecutable, listVideoDevices: dev.listVideoDevices };
  })();
  const ff = resolveExecutable('ffmpeg');
  if (!ff) return; // 无 ffmpeg：静默跳过
  const cams = await listVideoDevices(ff);
  if (!cams.length) return; // 无摄像头：静默跳过

  const chosen = await requireVideoDevice(ff, undefined);
  assert.ok(chosen.openAs, '必须有打开标识');
  const sameName = cams.filter((c) => c.name === chosen.name).length;
  if (sameName === 1) {
    assert.equal(chosen.openAs, chosen.name, '唯一设备的 openAs 必须等于显示名（历史行为零变化）');
  }
});

test('listAudioDevices（真机）：返回 {value,label} 条目（麦克风下拉的数据源）', async () => {
  const { resolveExecutable } = await import('../src/proc.js');
  const { listAudioDevices } = await import('../src/recorder.js');
  const ff = resolveExecutable('ffmpeg');
  if (!ff) return;
  const audios = await listAudioDevices(ff);
  for (const a of audios) {
    assert.ok(typeof a.value === 'string' && a.value.length > 0, '每个麦克风必须有打开标识');
    assert.ok(typeof a.label === 'string' && a.label.length > 0, '每个麦克风必须有可读标签');
  }
});
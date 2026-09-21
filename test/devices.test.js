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
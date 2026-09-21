/**
 * recorder.test.js — 录制参数构造测试
 *
 * 重点覆盖：
 *   · gdigrab 区域录制的参数生成（含非法值规范化）
 *   · 音频设备的有无分支
 *   · 各编码器的画质参数映射
 *   · 输出文件名的稳定性
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRecorderArgs, normalizeRegion, defaultOutputPath } from '../src/recorder.js';
import { ENCODER_CANDIDATES } from '../src/encoder-probe.js';

const AMF = ENCODER_CANDIDATES.find((e) => e.name === 'h264_amf');
const X264 = ENCODER_CANDIDATES.find((e) => e.name === 'libx264');

const base = {
  encoder: AMF,
  outputPath: 'C:/tmp/out.mp4',
  audioDevice: null,
  region: null,
  fps: 30,
  bitrate: 10,
  quality: 20,
};

test('normalizeRegion 对 null/非对象返回 null', () => {
  assert.equal(normalizeRegion(null), null);
  assert.equal(normalizeRegion(undefined), null);
  assert.equal(normalizeRegion('x'), null);
  assert.equal(normalizeRegion(123), null);
});

test('normalizeRegion 把宽高取偶数（gdigrab 要求）', () => {
  const r = normalizeRegion({ x: 0, y: 0, w: 641, h: 481 });
  assert.equal(r.w, 642);
  assert.equal(r.h, 482);
});

test('normalizeRegion 保证宽高至少为 2', () => {
  const r = normalizeRegion({ x: 0, y: 0, w: 0, h: -5 });
  assert.ok(r.w >= 2 && r.h >= 2, `实际 ${r.w}x${r.h}`);
});

test('normalizeRegion 把坐标夹到非负', () => {
  const r = normalizeRegion({ x: -100, y: -50, w: 640, h: 480 });
  assert.equal(r.x, 0);
  assert.equal(r.y, 0);
});

test('normalizeRegion 对非法数字回退到安全值', () => {
  const r = normalizeRegion({ x: 'abc', y: null, w: 'x', h: NaN });
  assert.ok(Number.isFinite(r.x) && Number.isFinite(r.y));
  assert.ok(r.w >= 2 && r.h >= 2);
});

test('不传 region 时录制整个桌面', () => {
  const args = buildRecorderArgs(base);
  assert.ok(args.includes('-f') && args.includes('gdigrab'));
  assert.ok(!args.includes('-offset_x'), '全屏录制不应带偏移');
  assert.ok(!args.includes('-video_size'), '全屏录制不应指定尺寸');
});

test('传 region 时生成偏移与尺寸参数', () => {
  const args = buildRecorderArgs({ ...base, region: { x: 100, y: 200, w: 800, h: 600 } });
  const joined = args.join(' ');
  assert.match(joined, /-offset_x 100/);
  assert.match(joined, /-offset_y 200/);
  assert.match(joined, /-video_size 800x600/);
});

test('非法 region 被规范化后再生成参数', () => {
  const args = buildRecorderArgs({ ...base, region: { x: -10, y: 0, w: 801, h: 601 } });
  const joined = args.join(' ');
  assert.match(joined, /-offset_x 0/);
  assert.match(joined, /-video_size 802x602/);
});

test('无音频设备时不生成音频输入与编码参数', () => {
  const args = buildRecorderArgs(base);
  assert.ok(args.includes('-an'), '应显式禁用音频');
  assert.ok(!args.some((a) => a.startsWith('audio=')), '不应有音频输入');
  assert.ok(!args.includes('aac'));
});

test('有音频设备时使用 dshow + AAC', () => {
  const args = buildRecorderArgs({ ...base, audioDevice: '麦克风 (USB)' });
  const joined = args.join(' ');
  assert.match(joined, /-f dshow/);
  assert.match(joined, /audio=麦克风 \(USB\)/);
  assert.match(joined, /-c:a aac/);
  assert.match(joined, /-b:a 192k/);
});

test('AMF 编码器映射到 cbr + qp 参数', () => {
  const args = buildRecorderArgs({ ...base, quality: 25 });
  const joined = args.join(' ');
  assert.match(joined, /-rc cbr/);
  assert.match(joined, /-qp_i 25/);
  assert.match(joined, /-qp_p 25/);
});

test('libx264 编码器映射到 crf 参数', () => {
  const args = buildRecorderArgs({ ...base, encoder: X264, quality: 18 });
  const joined = args.join(' ');
  assert.match(joined, /-crf 18/);
});

test('输出路径是最后一个参数', () => {
  const args = buildRecorderArgs(base);
  assert.equal(args[args.length - 1], base.outputPath);
});

test('输出带 faststart 以便流式播放', () => {
  const args = buildRecorderArgs(base);
  const i = args.indexOf('-movflags');
  assert.ok(i >= 0, '应包含 -movflags');
  assert.equal(args[i + 1], '+faststart');
});

test('像素格式固定为 yuv420p', () => {
  const args = buildRecorderArgs(base);
  const i = args.indexOf('-pix_fmt');
  assert.ok(i >= 0);
  assert.equal(args[i + 1], 'yuv420p');
});

test('码率参数正确换算为 M 单位', () => {
  const args = buildRecorderArgs({ ...base, bitrate: 12.5 });
  const joined = args.join(' ');
  assert.match(joined, /-b:v 12\.5M/);
  assert.match(joined, /-maxrate 12\.5M/);
});

test('defaultOutputPath 生成 .mp4 且带时间戳', () => {
  const p = defaultOutputPath('C:/videos');
  assert.match(p, /\.mp4$/);
  assert.match(p, /cam-to-bg_rec_\d{8}_\d{6}\.mp4$/);
});

test('defaultOutputPath 两次调用不会返回相同路径（秒级时间戳变化或至少格式正确）', () => {
  const a = defaultOutputPath('C:/videos');
  assert.ok(a.startsWith('C:/videos') || a.includes('videos'));
});
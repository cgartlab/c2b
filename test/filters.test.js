/**
 * filters.test.js — 滤镜图生成的单元测试
 *
 * 新设计：色彩滤镜始终出现在链里（即使默认值），
 * 通过 sendcmd 命令文件运行期动态调整参数，不重启 ffmpeg。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildColorFilters,
  buildSendcmdContent,
  buildGeometryFilters,
  buildScaleFilter,
  buildFilterChain,
  buildFfmpegArgs,
} from '../src/filters.js';
import { ENCODER_CANDIDATES } from '../src/encoder-probe.js';

const TARGET = { width: 1920, height: 1080 };

test('色彩滤镜始终出现在链里（即使默认值）', () => {
  const parts = buildColorFilters({});
  assert.ok(parts.length >= 4, '应至少包含 eq/exposure/colorbalance/hue 四个滤镜');
  assert.ok(parts.some((p) => p.startsWith('eq=')), '应包含 eq');
  assert.ok(parts.some((p) => p.startsWith('exposure=')), '应包含 exposure');
  assert.ok(parts.some((p) => p.startsWith('colorbalance=')), '应包含 colorbalance');
  assert.ok(parts.some((p) => p.startsWith('hue=')), '应包含 hue');
});

test('eq 滤镜带 eval=frame 以支持逐帧求值', () => {
  const parts = buildColorFilters({});
  const eq = parts.find((p) => p.startsWith('eq='));
  assert.ok(eq.includes('eval=frame'), 'eq 需要 eval=frame 让 sendcmd 能动态修改参数');
});

test('sendcmd 命令文件包含所有色彩参数', () => {
  const content = buildSendcmdContent({ brightness: 0.2, contrast: 1.5, exposure: 0.5, hue: 30 });
  assert.match(content, /eq brightness 0\.2/);
  assert.match(content, /eq contrast 1\.5/);
  assert.match(content, /exposure exposure 0\.5/);
  assert.match(content, /hue h 30/);
});

test('sendcmd 命令格式正确（时间 滤镜 命令 值;）', () => {
  const content = buildSendcmdContent({ brightness: 0.1 });
  const lines = content.split('\n');
  assert.ok(lines.every((l) => /^\d+\.\d+\s+\w+\s+\w+\s+[\d.-]+;$/.test(l.trim())),
    '每行应为 "时间 滤镜 命令 值;" 格式');
});

test('sendcmd 色温正值加红减蓝', () => {
  const content = buildSendcmdContent({ temperature: 0.5 });
  assert.match(content, /colorbalance rs 0\.15/);
  assert.match(content, /colorbalance bs -0\.15/);
});

test('sendcmd 色温负值加蓝减红', () => {
  const content = buildSendcmdContent({ temperature: -0.5 });
  assert.match(content, /colorbalance rs -0\.15/);
  assert.match(content, /colorbalance bs 0\.15/);
});

test('sendcmd 曝光值被夹到 -3..3', () => {
  assert.match(buildSendcmdContent({ exposure: 99 }), /exposure exposure 3/);
  assert.match(buildSendcmdContent({ exposure: -99 }), /exposure exposure -3/);
});

test('buildFilterChain 在有 cmdFile 时插入 sendcmd', () => {
  const chain = buildFilterChain({}, TARGET, 'cmd.txt');
  assert.match(chain, /sendcmd=f=cmd\.txt/);
  assert.match(chain, /eq=/);
  assert.match(chain, /format=yuv420p/);
});

test('buildFilterChain 无 cmdFile 时不插入 sendcmd', () => {
  const chain = buildFilterChain({}, TARGET);
  assert.doesNotMatch(chain, /sendcmd/);
});

test('buildFilterChain 中 sendcmd 在色彩滤镜之前', () => {
  const chain = buildFilterChain({}, TARGET, 'cmd.txt');
  const scIdx = chain.indexOf('sendcmd');
  const eqIdx = chain.indexOf('eq=');
  assert.ok(scIdx < eqIdx, 'sendcmd 应在 eq 之前');
});

test('旋转角度映射到正确的 transpose', () => {
  assert.deepEqual(buildGeometryFilters({ rotate: '0' }), []);
  assert.deepEqual(buildGeometryFilters({ rotate: '90' }), ['transpose=1']);
  assert.deepEqual(buildGeometryFilters({ rotate: '180' }), ['transpose=1,transpose=1']);
  assert.deepEqual(buildGeometryFilters({ rotate: '270' }), ['transpose=2']);
});

test('水平翻转产生 hflip', () => {
  assert.deepEqual(buildGeometryFilters({ flipHorizontal: true }), ['hflip']);
});

test('垂直翻转产生 vflip', () => {
  assert.deepEqual(buildGeometryFilters({ flipVertical: true }), ['vflip']);
});

test('水平与垂直翻转可同时启用', () => {
  assert.deepEqual(buildGeometryFilters({ flipHorizontal: true, flipVertical: true }), ['hflip', 'vflip']);
});

test('旧的 mirror 字段仍被识别', () => {
  assert.deepEqual(buildGeometryFilters({ mirror: true }), ['hflip']);
});

test('fill 模式裁切铺满', () => {
  const s = buildScaleFilter({ scaleMode: 'fill' }, TARGET);
  assert.match(s, /force_original_aspect_ratio=increase/);
  assert.match(s, /crop=1920:1080/);
});

test('fit 模式等比缩放并补黑边', () => {
  const s = buildScaleFilter({ scaleMode: 'fit' }, TARGET);
  assert.match(s, /force_original_aspect_ratio=decrease/);
  assert.match(s, /pad=1920:1080/);
});

test('stretch 模式直接拉伸', () => {
  assert.equal(buildScaleFilter({ scaleMode: 'stretch' }, TARGET), 'scale=1920:1080');
});

test('输出尺寸强制为偶数', () => {
  const s = buildScaleFilter({ scaleMode: 'stretch' }, { width: 1921, height: 1081 });
  assert.match(s, /scale=1922:1082/);
});

test('完整滤镜链以 format=yuv420p 收尾', () => {
  const chain = buildFilterChain({}, TARGET, 'cmd.txt');
  assert.ok(chain.endsWith('format=yuv420p'));
});

test('buildFfmpegArgs 传入 cmdFile', () => {
  const amf = ENCODER_CANDIDATES.find((e) => e.name === 'h264_amf');
  const args = buildFfmpegArgs(
    { width: 1920, height: 1080, fps: 30, bitrate: 8, quality: 23 },
    { deviceName: 'cam', encoder: amf, target: TARGET, port: 12345, cmdFileName: 'cmd.txt' },
  );
  const vfIdx = args.indexOf('-vf');
  assert.ok(vfIdx >= 0);
  assert.match(args[vfIdx + 1], /sendcmd/);
  assert.match(args[vfIdx + 1], /eq=/);
});

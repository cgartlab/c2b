/**
 * wallpaper.test.js — 配置变更分类的回归测试
 *
 * 这些断言对应代码审查中发现并修复的真实缺陷：
 *   S1: bitrate/quality 曾漏出重启判定列表，导致改码率/画质静默失效
 *   M1: sendcmd 写入失败曾被静默吞掉，谎报"已生效"
 *
 * 用最小的假 engine 实例测试 applyConfig 的分类逻辑，
 * 不需要真实摄像头或 ffmpeg。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WallpaperEngine } from '../src/wallpaper.js';
import { defaultConfig } from '../src/config.js';

const BASE = defaultConfig();

/** 造一个"看起来正在运行"的引擎，避免真实启动进程。 */
function makeEngine({ cmdFilePath = null } = {}) {
  const e = new WallpaperEngine({
    ffmpegPath: 'ffmpeg',
    mpvPath: 'mpv',
    config: { ...BASE },
  });
  e.state = 'running';
  e.pipeline = {
    stop: async () => {},
    child: null,
    streamUrl: null,
    recentLog: () => '',
  };
  e.cmdFilePath = cmdFilePath;
  e.desktop = null;
  e.effectiveCapture = null;
  e.device = { name: 'fake' };
  e.encoder = { name: 'h264_amf', label: 'test', hardware: true };
  return e;
}

test('改码率必须提示重启（S1 回归）', async () => {
  const e = makeEngine();
  const r = await e.applyConfig({ ...BASE, bitrate: 16 });
  assert.equal(r.mode, 'pending-restart', '码率是 ffmpeg 命令行参数，无法动态生效');
  assert.ok(r.pendingKeys.includes('bitrate'));
});

test('改画质必须提示重启（S1 回归）', async () => {
  const e = makeEngine();
  const r = await e.applyConfig({ ...BASE, quality: 18 });
  assert.equal(r.mode, 'pending-restart');
  assert.ok(r.pendingKeys.includes('quality'));
});

test('改色彩走 sendcmd，不需要重启', async () => {
  const e = makeEngine();
  const r = await e.applyConfig({ ...BASE, brightness: 0.2 });
  // cmdFilePath 为 null 时会如实报告写入失败，而不是谎报成功
  assert.ok(['sendcmd', 'sendcmd-failed'].includes(r.mode), `实际 mode=${r.mode}`);
});

test('cmd 文件写入失败时如实报告（M1 回归）', async () => {
  const e = makeEngine({ cmdFilePath: null });
  const r = await e.applyConfig({ ...BASE, brightness: 0.2 });
  assert.equal(r.mode, 'sendcmd-failed', '不能把写入失败谎报成已生效');
  assert.ok(r.error, '应带上失败原因');
});

test('改几何参数提示重启', async () => {
  for (const patch of [{ flipHorizontal: true }, { flipVertical: true }, { rotate: '90' }, { scaleMode: 'fit' }]) {
    const e = makeEngine();
    const r = await e.applyConfig({ ...BASE, ...patch });
    assert.equal(r.mode, 'pending-restart', `${Object.keys(patch)[0]} 应提示重启`);
  }
});

test('改结构参数提示重启', async () => {
  for (const patch of [{ fps: 60 }, { width: 1280 }, { height: 720 }, { encoder: 'libx264' }, { latencyMode: 'smooth' }]) {
    const e = makeEngine();
    const r = await e.applyConfig({ ...BASE, ...patch });
    assert.equal(r.mode, 'pending-restart', `${Object.keys(patch)[0]} 应提示重启`);
  }
});

test('无改动返回 none', async () => {
  const e = makeEngine();
  const r = await e.applyConfig({ ...BASE });
  assert.equal(r.mode, 'none');
});

test('未运行时任何改动都不触发重启', async () => {
  const e = makeEngine();
  e.state = 'idle';
  const r = await e.applyConfig({ ...BASE, bitrate: 20 });
  assert.equal(r.mode, 'none', '未运行时应只保存配置');
});

test('色彩与结构同时变更时优先提示重启', async () => {
  const e = makeEngine();
  const r = await e.applyConfig({ ...BASE, brightness: 0.3, bitrate: 20 });
  assert.equal(r.mode, 'pending-restart');
  assert.ok(r.pendingKeys.includes('bitrate'));
});

test('pendingKeys 只包含真正变化的键', async () => {
  const e = makeEngine();
  const r = await e.applyConfig({ ...BASE, fps: 45, bitrate: 12 });
  assert.deepEqual(r.pendingKeys.sort(), ['bitrate', 'fps']);
});
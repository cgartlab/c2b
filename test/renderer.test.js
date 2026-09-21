/**
 * renderer.test.js — mpv 参数构造测试
 *
 * 重点是延迟模式：三种模式必须给出合法且互不相同的缓冲策略，
 * 且用户选择的模式必须真的出现在最终参数里
 *（曾经踩过坑：--profile=low-latency 写在后面会覆盖前面的自定义值）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMpvArgs, latencyArgs } from '../src/renderer.js';

const BASE = {
  hwnd: 0,
  streamUrl: 'tcp://127.0.0.1:1234',
  ipcPath: null,
  config: {},
};

test('三种延迟模式都返回非空参数', () => {
  for (const mode of ['ultra-low', 'balanced', 'smooth']) {
    const args = latencyArgs(mode);
    assert.ok(Array.isArray(args) && args.length > 0, `${mode} 应返回参数`);
  }
});

test('未知模式回退到 ultra-low', () => {
  assert.deepEqual(latencyArgs('nonsense'), latencyArgs('ultra-low'));
  assert.deepEqual(latencyArgs(undefined), latencyArgs('ultra-low'));
});

test('ultra-low 关闭所有队列并激进丢帧', () => {
  const args = latencyArgs('ultra-low');
  assert.ok(args.includes('--cache=no'), '应关闭缓存');
  assert.ok(args.includes('--vd-queue-enable=no'), '应关闭解码队列');
  assert.ok(args.includes('--framedrop=decoder+vo'), '应允许解码与渲染同时丢帧');
});

test('smooth 模式保留缓冲并禁止丢帧', () => {
  const args = latencyArgs('smooth');
  assert.ok(args.includes('--cache=yes'), '应启用缓存');
  assert.ok(args.includes('--framedrop=no'), '应禁止丢帧');
});

test('三种模式的缓冲上限逐级增大', () => {
  const size = (mode) => {
    const a = latencyArgs(mode).find((x) => x.startsWith('--demuxer-max-bytes='));
    return Number(a.split('=')[1].replace(/[^0-9.]/g, ''));
  };
  const ultra = size('ultra-low');
  const bal = size('balanced');
  const smooth = size('smooth');
  assert.ok(ultra < bal, `ultra-low(${ultra}) 应小于 balanced(${bal})`);
  assert.ok(bal < smooth, `balanced(${bal}) 应小于 smooth(${smooth})`);
});

test('用户选择的延迟模式出现在最终参数中', () => {
  for (const mode of ['ultra-low', 'balanced', 'smooth']) {
    const args = buildMpvArgs({ ...BASE, config: { latencyMode: mode } });
    for (const opt of latencyArgs(mode)) {
      assert.ok(args.includes(opt), `${mode} 缺少 ${opt}`);
    }
  }
});

test('延迟参数位于 --profile 之后（否则会被 profile 覆盖）', () => {
  const args = buildMpvArgs({ ...BASE, config: { latencyMode: 'ultra-low' } });
  const profileIdx = args.indexOf('--profile=low-latency');
  const syncIdx = args.indexOf('--video-sync=desync');
  assert.ok(profileIdx >= 0, '应包含 --profile=low-latency');
  assert.ok(syncIdx > profileIdx, '--video-sync 必须排在 profile 之后');
});

test('始终启用 GPU 渲染与硬件解码', () => {
  const args = buildMpvArgs(BASE);
  assert.ok(args.includes('--vo=gpu-next'));
  assert.ok(args.includes('--gpu-api=d3d11'));
  assert.ok(args.includes('--hwdec=auto-safe'));
});

test('流地址作为最后一个参数传入', () => {
  const args = buildMpvArgs(BASE);
  assert.equal(args[args.length - 1], BASE.streamUrl);
});

test('提供 hwnd 时注入 --wid', () => {
  const args = buildMpvArgs({ ...BASE, hwnd: 12345 });
  assert.ok(args.includes('--wid=12345'));
});

test('未提供 hwnd 时不注入 --wid', () => {
  const args = buildMpvArgs(BASE);
  assert.ok(!args.some((a) => a.startsWith('--wid=')));
});

test('提供 ipcPath 时注入 --input-ipc-server', () => {
  const args = buildMpvArgs({ ...BASE, ipcPath: '\\\\.\\pipe\\x' });
  assert.ok(args.some((a) => a.startsWith('--input-ipc-server=')));
});

test('忽略用户 mpv 配置以保证行为可预测', () => {
  assert.ok(buildMpvArgs(BASE).includes('--no-config'));
});
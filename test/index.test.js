/**
 * index.test.js — 应用组装层的副作用兜底
 *
 * 背景（第 39 轮）：`writeState`（磁盘满/权限拒抛错）作为引擎事件处理器时，
 * 抛错会沿 emit 链冒到顶层 → uncaughtException → 应用被兜底关停。
 * `safeEventHandler` 把副作用型回调包成不冒泡 —— 这里验证它的行为契约。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { safeEventHandler } from '../src/index.js';

const indexSrc = readFileSync(fileURLToPath(new URL('../src/index.js', import.meta.url)), 'utf8');

test('onConfigChange 把最终配置广播给已开界面（CLI 发起的变更界面才拿得到）', () => {
  // 锚定服务端广播：c2b set 走 /api/config → onConfigChange → 广播 'config'
  assert.ok(/broadcast\(\{\s*type:\s*'config'/.test(indexSrc),
    'onConfigChange 必须广播 type:config，否则 c2b set 后界面表单停留在旧值');
  assert.ok(indexSrc.includes('saveConfig(next)'), '广播应在保存之后（发的是最终配置）');
});

test('safeEventHandler 吞掉副作用抛错（writeState 磁盘满不打挂 emit 链）', () => {
  const boom = () => { throw new Error('ENOSPC: 磁盘已满'); };
  const guarded = safeEventHandler(boom);
  assert.doesNotThrow(() => guarded(), '直接调用抛错必须被吞');
});

test('safeEventHandler 作为 EventEmitter 处理器时 emit 不冒泡（顶层不 uncaught）', () => {
  const ee = new EventEmitter();
  ee.on('pipeline-exit', safeEventHandler(() => { throw new Error('状态写失败'); }));
  assert.doesNotThrow(() => ee.emit('pipeline-exit', { code: 1 }),
    'emit 必须安全 —— 否则沿 child.on(exit) 链冒到 uncaughtException');
  // 未被 guard 的对照：裸处理器抛错会冒泡
  ee.on('raw', () => { throw new Error('raw'); });
  assert.throws(() => ee.emit('raw'), /raw/, '对照：裸处理器确实会冒泡（guard 的价值）');
});

test('safeEventHandler 透传返回值与参数（供需要返回值/上下文的处理器）', () => {
  const add = safeEventHandler((a, b) => a + b);
  assert.equal(add(2, 3), 5, '正常时返回值透传');
  const ctx = {};
  safeEventHandler(function () { ctx.hit = this; }).call(ctx);
  assert.equal(ctx.hit, ctx, 'this 上下文透传');
  assert.equal(safeEventHandler(() => { throw new Error('x'); })(), undefined, '抛错时返回 undefined');
});

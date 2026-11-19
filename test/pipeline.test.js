/**
 * pipeline.test.js — 管线退出分类与 stop 幂等
 *
 * 背景（第 30/31 轮实证的同构缺陷家族）：
 *  1) 退出分类曾用**在途** `_stopping` —— stop 超时路径会先复位 `_stopping`
 *     再 taskkill，exit 晚到 → "手动停止"被误判成崩溃 → 干净停止/重启中
 *     打出"ffmpeg 异常退出"并写 lastError（状态诚实回归）；
 *  2) `async stop()` 每次包新 promise → 并发调用不共享收尾，
 *     第二个调用方（如 close）提前返回不等待 → 进程退出留孤儿。
 *
 * 全部用注入的假 child（EventEmitter），不依赖真实摄像头/ffmpeg。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Pipeline } from '../src/pipeline.js';

function makePipeline() {
  return new Pipeline({
    ffmpegPath: 'ffmpeg.exe',
    config: {},
    encoder: { name: 'libx264', label: 'x264', args: ['-c:v', 'libx264'] },
    deviceName: '虚拟设备',
    deviceLabel: '虚拟设备',
    target: { width: 640, height: 480 },
    cmdFileName: null,
    cmdDir: null,
  });
}

/** 注入一个"kill 后立刻退出"的假 child（绕过真实 spawn）。 */
function fakeChild(pl, { respondToSigterm = true } = {}) {
  const c = new EventEmitter();
  c.exitCode = null;
  c.killed = false;
  c.pid = 0; // pid=0：taskkill 分支不会被触发（避免杀到真实进程）
  c.kill = () => {
    c.killed = true;
    if (respondToSigterm) setTimeout(() => { c.exitCode = 0; c.emit('exit', 0); }, 5);
  };
  pl.child = c;
  return c;
}

test('意外退出：分类为崩溃——发 exit 事件并写 lastError（状态诚实）', () => {
  const pl = makePipeline();
  let got = null;
  pl.on('exit', (info) => { got = info; });
  pl._classifyExit(1);
  assert.ok(got, '未请求停止的退出必须外抛（否则引擎收不到崩溃信号）');
  assert.equal(got.code, 1);
  assert.equal(pl.lastError, 'ffmpeg 异常退出 (code=1)');
  assert.equal(pl.child, null, '退出后 child 必须摘除');
});

test('停止后晚到的退出：闩锁抑制崩溃误报（超时路径回归）', async () => {
  const pl = makePipeline();
  fakeChild(pl);
  let got = 0;
  pl.on('exit', () => { got += 1; });

  const p1 = pl.stop();
  const p2 = pl.stop();
  assert.strictEqual(p1, p2, '并发 stop 必须共享同一收尾 promise（非 async 方法）');
  await p1;

  // 模拟"exit 在 _stopping 复位之后才到达"（超时→taskkill 晚到的经典窗口）
  pl._classifyExit(1);
  assert.equal(got, 0, '已请求停止的退出绝不能再分类成崩溃（否则打出假"异常退出"）');
  assert.equal(pl.lastError, null, '干净停止不得污染 lastError');
});

test('stop() 幂等：child 已空时立即 resolve 且保持闩锁', async () => {
  const pl = makePipeline();
  const p1 = pl.stop();
  assert.ok(p1 instanceof Promise, '无 child 也必须返回 promise（调用方统一 await）');
  await p1;
  // 再次 stop：返回共享 promise（第一次创建的）或立即 resolve
  const p2 = pl.stop();
  await p2;
  assert.equal(pl._stopRequested, false, '从未启动过 → 不应误置闩锁');
});

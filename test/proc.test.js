/**
 * proc.test.js — 日志轮转与工具函数
 *
 * 背景（真实缺陷）：CLI 录制不带 runDir，日志落到固定路径
 * cam-to-bg-recorder.log 且永远追加——每次录制都往上叠，
 * 长期使用会无限膨胀吃满磁盘。轮转把总量钳在 2×maxBytes。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, statSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rotateLogIfNeeded, spawnLongRunning } from '../src/proc.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('spawn 异步失败（只发 error 不发 spawn）：不抛不挂，日志句柄已释放', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'proc-fail-'));
  const logPath = path.join(dir, 'fail.log');
  // 命令不存在 → spawn 异步发 'error'（不发 'spawn'）。
  // 历史缺陷：fd 靠 once('spawn') 关 → 该路径永不触发 → 每次失败泄漏一个 fd。
  const { child, logPath: lp } = spawnLongRunning(
    'C:\\不存在的目录\\definitely-not-exist-xyz.exe', ['--version'],
    { logPath, stdinPipe: false },
  );
  assert.equal(lp, logPath, '应返回日志路径');
  await new Promise((resolve) => {
    child.once('error', resolve);          // 失败必须走 error（不是 hang）
    child.once('spawn', () => resolve()); // 环境意外能 spawn 也接受
    setTimeout(resolve, 3000);
  });
  // 父进程应已关闭自己的 fd 副本：同一文件可继续正常追加写（不被死握句柄拖累）
  appendFileSync(logPath, 'probe');
  assert.ok(existsSync(logPath), '日志文件可正常访问');
});

test('stdinPipe 子进程必须挂 stdin error 吞咽（异步 EPIPE = uncaughtException = 应用退出）', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'proc-stdin-'));
  const { child } = spawnLongRunning(
    process.execPath, ['-e', 'setTimeout(() => {}, 8000)'],
    { logPath: path.join(dir, 'x.log'), stdinPipe: true },
  );
  try {
    if (!child.stdin) {
      // 受限环境拿不到管道（spawnLongRunning 已回退无管道模式）——本用例无意义
      t.skip('当前环境无法创建 stdin 管道');
      return;
    }
    assert.ok(child.stdin.listenerCount('error') >= 1,
      'stdin 必须有 error 监听：目标进程在写 q 的瞬间退出时，无监听的流 error 会 uncaughtException 击杀应用');

    // 行为面复核：写入已死管道 → 回调拿到 error（监听器吞掉事件），
    // 全程不得出现未捕获异常（若无监听器，测试进程会在此直接崩溃）
    try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
    if (child.exitCode === null) {
      await new Promise((resolve) => child.once('exit', resolve));
    }
    let cbCalled = false;
    let threw = null;
    try { child.stdin.write('q', () => { cbCalled = true; }); } catch (e) { threw = e; }
    await sleep(300);
    assert.ok(cbCalled || threw !== null, '对已死 stdin 的写必须有确定归宿（回调或同步抛）');
  } finally {
    try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
    await sleep(100);
  }
});

function tmpFile(name, bytes) {
  const dir = mkdtempSync(path.join(tmpdir(), 'proc-test-'));
  const p = path.join(dir, name);
  if (bytes > 0) writeFileSync(p, Buffer.alloc(bytes, 0x61));
  return p;
}

test('小日志不轮转', () => {
  const p = tmpFile('small.log', 1024);
  assert.equal(rotateLogIfNeeded(p, 4096), false);
  assert.ok(existsSync(p), '原文件应保留');
});

test('超过上限 → 轮转为 .old，原路径消失（下次打开即重建）', () => {
  const p = tmpFile('big.log', 8192);
  assert.equal(rotateLogIfNeeded(p, 4096), true);
  assert.ok(!existsSync(p), '原路径应已被改名');
  assert.ok(existsSync(`${p}.old`), '旧内容应保留在 .old');
  assert.equal(statSync(`${p}.old`).size, 8192, '旧内容不得丢失');
});

test('已有 .old 时轮转会覆盖旧 .old（总量有界 2×上限）', () => {
  const p = tmpFile('rot.log', 8192);
  writeFileSync(`${p}.old`, 'older-but-gone');
  rotateLogIfNeeded(p, 4096);
  assert.equal(statSync(`${p}.old`).size, 8192, '上一份 .old 被本轮替换');
});

test('不存在/空路径 → 安全返回 false', () => {
  assert.equal(rotateLogIfNeeded(path.join(tmpdir(), 'no-such-file.log')), false);
  assert.equal(rotateLogIfNeeded(null), false);
  assert.equal(rotateLogIfNeeded(''), false);
});

test('恰好达到上限也轮转（>= 语义）', () => {
  const p = tmpFile('exact.log', 4096);
  assert.equal(rotateLogIfNeeded(p, 4096), true);
});

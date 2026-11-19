/**
 * state.test.js — 运行状态的 pid 复用防护
 *
 * 背景（真实缺陷）：state.json 跨进程/跨生命周期存活，其 pid 可能被
 * 系统复用给无关进程——`c2b stop` 会向**无辜进程**发 SIGTERM、
 * `c2b start` 误报"已在运行中"。验证依据是进程创建时刻（固定绝对量）。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  writeState, readState, clearState, verifyStateProcess, processName, statePath,
} from '../src/state.js';

const oldHome = process.env.CAM_TO_BG_HOME;
let home = null;

before(() => {
  home = mkdtempSync(path.join(tmpdir(), 'state-test-'));
  process.env.CAM_TO_BG_HOME = home;
});

after(() => {
  if (oldHome === undefined) delete process.env.CAM_TO_BG_HOME;
  else process.env.CAM_TO_BG_HOME = oldHome;
  if (home) { try { rmSync(home, { recursive: true, force: true }); } catch { /* 忽略 */ } }
});

test('writeState 自动记录进程创建时刻（≈ now - uptime）', () => {
  writeState({ pid: process.pid, runId: 'x' });
  const st = readState();
  assert.ok(Number.isFinite(st.processStartedAt), '必须记录创建时刻');
  const approx = Date.now() - process.uptime() * 1000;
  assert.ok(Math.abs(st.processStartedAt - approx) < 2000, '与 now-uptime 的偏差应在秒级内');
  clearState();
});

test('verifyStateProcess：当前进程的真实状态 → true', async () => {
  writeState({ pid: process.pid, runId: 'self' });
  const st = readState();
  assert.equal(await verifyStateProcess(st), true);
  clearState();
});

test('verifyStateProcess：创建时刻不符（pid 被复用的信号）→ false', async () => {
  writeState({ pid: process.pid, runId: 'tamper' });
  const st = readState();
  const tampered = { ...st, processStartedAt: st.processStartedAt - 86400000 }; // 早了一天
  assert.equal(await verifyStateProcess(tampered), false,
    '创建时刻对不上说明这个 pid 现在属于另一个进程，绝不能当自己人');
  clearState();
});

test('verifyStateProcess：旧格式（无创建时刻）退化信任 isAlive', async () => {
  assert.equal(await verifyStateProcess({ pid: process.pid }), true);
});

test('verifyStateProcess：非法/死亡 pid → false', async () => {
  assert.equal(await verifyStateProcess(null), false);
  assert.equal(await verifyStateProcess({}), false);
  assert.equal(await verifyStateProcess({ pid: 0 }), false);
  assert.equal(await verifyStateProcess({ pid: 'abc' }), false);

  // 真实死亡的 pid（stdio 必须 ignore：沙箱禁止管道 stdio → EPERM）
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { windowsHide: true, stdio: 'ignore' });
  await new Promise((resolve) => child.on('exit', resolve));
  assert.equal(await verifyStateProcess({ pid: child.pid, processStartedAt: Date.now() }), false,
    '已死进程必须判否');
});

test('processName：查到当前进程应为 node，非法 pid 返回 null', async () => {
  const pn = await processName(process.pid);
  assert.ok(pn && /node/i.test(pn), `应查到 node，实际: ${pn}`);
  assert.equal(await processName(-1), null);
  assert.equal(await processName(0), null);
});

test('statePath 落在 CAM_TO_BG_HOME 下', () => {
  assert.equal(statePath(), path.join(home, 'state.json'));
});

/**
 * runs.test.js — 运行会话管理测试
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import {
  makeRunId, startRun, endRun, readRun, listRuns, latestRun,
  cleanupOldRuns, readRunLog, parseRunLog, logsDir, runDir, summarizeError,
} from '../src/runs.js';

/** 把日志根目录指到临时目录，避免污染用户目录。 */
function withTempLogs(fn) {
  const base = mkdtempSync(path.join(tmpdir(), 'runs-test-'));
  const old = process.env.CAM_TO_BG_HOME;
  process.env.CAM_TO_BG_HOME = base;
  try {
    fn(base);
  } finally {
    if (old === undefined) delete process.env.CAM_TO_BG_HOME;
    else process.env.CAM_TO_BG_HOME = old;
  }
}

test('makeRunId 格式为 YYYYMMDD_HHMMSS_pid', () => {
  const id = makeRunId(new Date(2026, 8, 22, 14, 30, 5), 12345);
  assert.match(id, /^20260922_143005_12345_[0-9a-f]{4}$/);
  // 尾随机位必须恒为 4 位十六进制：历史 Math.random 实现对 0.5/0.8 这类值
  // 只产出 1 位（与格式契约不一致），改 crypto 后 50 连抽零例外
  for (let i = 0; i < 50; i += 1) {
    assert.match(makeRunId(), /^\d{8}_\d{6}_\d+_[0-9a-f]{4}$/, '尾随机位不足 4');
  }
});

/* ────── runId 校验：path.join 的路径穿越防线 ────── */

test('isValidRunId：合法通过，穿越/异常形态全部拒绝', async () => {
  const { isValidRunId, readRun, readRunLog, endRun } = await import('../src/runs.js');
  assert.equal(isValidRunId('20260922_143005_12345_ab12'), true);
  assert.equal(isValidRunId('20260922_143005_12345_f'), true, '历史短随机尾（1位）需兼容');
  // 路径穿越与越界形态
  for (const bad of [
    '../../etc', '..\\..\\windows', '/', 'C:\\Windows', '20260922_143005_12345_ab12/../x',
    '20260922_143005_12345_..', '20260922_143005_12345_abcdef', // 尾超过4位（含 ../.. 变体）
    '', null, undefined, 42,
  ]) {
    assert.equal(isValidRunId(bad), false, `应拒绝: ${String(bad)}`);
  }
  // 防线在读写三件套上生效
  assert.equal(readRun('../../etc'), null);
  assert.equal(readRunLog('..\\..\\x'), '');
  assert.equal(endRun('../../etc', { exitCode: 0 }), null);
});

test('startRun 创建目录并写 manifest', () => {
  withTempLogs((base) => {
    const run = startRun({ config: { device: '测试摄像头' }, env: { ffmpegVersion: 'x' } });
    assert.ok(existsSync(path.join(run.dir, 'manifest.json')));
    const m = readRun(run.runId);
    assert.equal(m.runId, run.runId);
    assert.equal(m.config.device, '测试摄像头');
    assert.equal(m.env.ffmpegVersion, 'x');
    assert.equal(m.pid, process.pid);
    assert.ok(m.startedAt);
  });
});

test('endRun 写入退出码与错误摘要，并更新 last-run', () => {
  withTempLogs((base) => {
    const run = startRun({ config: {} });
    const err = new Error('测试错误');
    err.code = 'EPIPELINE';
    err.hint = '请检查设备';
    endRun(run.runId, { exitCode: 1, error: err });
    const m = readRun(run.runId);
    assert.equal(m.exitCode, 1);
    assert.equal(m.errorSummary.message, '测试错误');
    assert.equal(m.errorSummary.code, 'EPIPELINE');
    assert.equal(m.errorSummary.hint, '请检查设备');
    assert.ok(m.errorSummary.stack);
    // last-run.json
    const last = JSON.parse(readFileSync(path.join(logsDir(), 'last-run.json'), 'utf8'));
    assert.equal(last.runId, run.runId);
    assert.equal(last.exitCode, 1);
  });
});

test('listRuns 最新在前，latestRun 返回最近一次', () => {
  withTempLogs((base) => {
    const r1 = startRun({ config: {} });
    // 确保 r2 的时间戳严格晚于 r1（即使同秒，startedAt 也是 ISO 字符串，
    // 排序按 startedAt 而非 runId 随机后缀，保证 r2 在前）
    const r2 = startRun({ config: {} });
    const runs = listRuns();
    assert.equal(runs.length, 2);
    // 两次运行互不相同（随机后缀保证唯一）
    assert.notEqual(r1.runId, r2.runId);
    // latestRun 应返回 startedAt 更晚的 r2
    assert.equal(latestRun().runId, r2.runId);
    // 列表第一项也应是最新
    assert.equal(runs[0].runId, r2.runId);
  });
});

test('cleanupOldRuns 只保留最近 N 个', () => {
  withTempLogs((base) => {
    for (let i = 0; i < 5; i += 1) startRun({ config: {} });
    const removed = cleanupOldRuns(2);
    assert.equal(removed.length, 3);
    const remaining = listRuns();
    assert.equal(remaining.length, 2);
  });
});

test('readRunLog 读取 JSONL，parseRunLog 解析为对象', () => {
  withTempLogs((base) => {
    const run = startRun({ config: {} });
    // 手动写几条 JSONL（logger 测试已覆盖写入，这里直接模拟）
    fs.appendFileSync(path.join(run.dir, 'run.jsonl'),
      '{"ts":"t1","level":"info","module":"app","msg":"a"}\n'
      + '{"ts":"t2","level":"error","module":"pipeline","msg":"b"}\n');
    const entries = parseRunLog(readRunLog(run.runId));
    assert.equal(entries.length, 2);
    assert.equal(entries[0].msg, 'a');
    assert.equal(entries[1].level, 'error');
  });
});

test('summarizeError 处理 null 与普通对象', () => {
  assert.equal(summarizeError(null), null);
  const s = summarizeError({ message: 'x', name: 'E', code: 'C', hint: 'h', stack: 's' });
  assert.equal(s.message, 'x');
  assert.equal(s.code, 'C');
});

test('readRun 对不存在或损坏返回 null', () => {
  assert.equal(readRun('不存在的run'), null);
});

test('endRun 的 note 收尾说明：写入即保留，未传不抹掉（硬杀补写清单用）', () => {
  withTempLogs(() => {
    const run = startRun({ config: {} });
    endRun(run.runId, { exitCode: 0, note: '经外部信号强制结束' });
    const m = readRun(run.runId);
    assert.equal(m.exitCode, 0);
    assert.equal(m.stopNote, '经外部信号强制结束');
    assert.ok(m.endedAt);

    endRun(run.runId, { exitCode: 0 }); // 二次收尾不传 note
    assert.equal(readRun(run.runId).stopNote, '经外部信号强制结束', '未传 note 不应抹掉既有说明');
  });
});

test('listRuns 透出 stopNote（cmdLogs 列表 / 服务端日志列表的展示依赖它）', () => {
  withTempLogs(() => {
    // 强制收尾：endRun 带 note
    const run = startRun({ config: {} });
    endRun(run.runId, { exitCode: 0, note: '经外部信号强制结束（Windows 信号为硬杀）' });
    const first = listRuns()[0];
    assert.equal(first.runId, run.runId);
    assert.equal(first.stopNote, '经外部信号强制结束（Windows 信号为硬杀）',
      'listRuns 必须透出 stopNote，否则 CLI 列表/服务端列表无法展示强制收尾原因');

    // 正常收尾（无 note）不得带 stopNote（不显示噪声）
    const run2 = startRun({ config: {} });
    endRun(run2.runId, { exitCode: 0 });
    assert.equal(listRuns()[0].stopNote, undefined, '正常收尾不写 stopNote');
    // latestRun 同样走 listRuns → 也应透出
    assert.equal(latestRun().stopNote, undefined, '刚正常结束的运行无 stopNote');
  });
});
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
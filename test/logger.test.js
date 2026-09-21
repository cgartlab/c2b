/**
 * logger.test.js — 结构化日志器测试
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLogger, shouldLog, LOG_LEVELS, configureGlobalLogger, getLogger } from '../src/logger.js';

function tmpDir() {
  return mkdtempSync(path.join(tmpdir(), 'log-test-'));
}

test('级别过滤：低于生效级别的不输出', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'run.jsonl');
  const log = createLogger({ logPath: file, level: 'warn' });
  log.debug('debug 消息');
  log.info('info 消息');
  log.warn('警告');
  log.error('错误');
  log.close();
  const lines = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
  const levels = lines.map((l) => JSON.parse(l).level);
  assert.deepEqual(levels, ['warn', 'error'], 'warn 级别下只应有 warn 与 error');
});

test('shouldLog 边界', () => {
  assert.ok(shouldLog('error', 'info'));
  assert.ok(shouldLog('warn', 'info'));
  assert.ok(shouldLog('info', 'info'));
  assert.ok(!shouldLog('debug', 'info'));
  assert.ok(!shouldLog('info', 'warn'));
});

test('结构化字段：ts/level/module/msg', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'run.jsonl');
  const log = createLogger({ logPath: file, module: 'app' });
  log.child('pipeline').info('启动完成', { pid: 123 });
  log.close();
  const rec = JSON.parse(readFileSync(file, 'utf8').trim().split('\n')[0]);
  assert.ok(rec.ts, '应有时间戳');
  assert.equal(rec.level, 'info');
  assert.equal(rec.module, 'pipeline');
  assert.equal(rec.msg, '启动完成');
  assert.deepEqual(rec.extra, { pid: 123 });
});

test('未指定模块时使用默认模块', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'run.jsonl');
  const log = createLogger({ logPath: file, module: 'app' });
  log.info('无模块标签消息');
  log.close();
  const rec = JSON.parse(readFileSync(file, 'utf8').trim().split('\n')[0]);
  assert.equal(rec.module, 'app');
});

test('error 级立即落盘（不等缓冲 flush）', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'run.jsonl');
  const log = createLogger({ logPath: file, level: 'info' });
  log.error('立即落盘');
  // 不调用 close，直接读文件
  const content = readFileSync(file, 'utf8');
  assert.ok(content.includes('立即落盘'), 'error 应已写入文件');
  log.close();
});

test('写盘失败不抛出', () => {
  // 指向一个不存在的目录（父目录不存在 → openSync 失败）
  const badPath = path.join(tmpDir(), 'no-such-dir', 'run.jsonl');
  const log = createLogger({ logPath: badPath, level: 'info' });
  assert.doesNotThrow(() => log.info('这条不该崩溃'));
  assert.ok(log.getLastError(), '应记录写盘错误但不抛出');
  log.close();
});

test('child 返回带模块标签的日志器', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'run.jsonl');
  const log = createLogger({ logPath: file, level: 'info' });
  const p = log.child('pipeline');
  p.error('管线错误');
  log.close();
  const rec = JSON.parse(readFileSync(file, 'utf8').trim().split('\n')[0]);
  assert.equal(rec.module, 'pipeline');
});

test('configureGlobalLogger 切换全局 logger', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'run.jsonl');
  const lg = configureGlobalLogger({ logPath: file, level: 'info', console: false });
  assert.equal(getLogger(), lg);
  lg.info('全局日志');
  lg.close();
  assert.ok(readFileSync(file, 'utf8').includes('全局日志'));
});

test('JSONL 每行一条记录', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'run.jsonl');
  const log = createLogger({ logPath: file, level: 'info' });
  for (let i = 0; i < 5; i += 1) log.info(`消息 ${i}`);
  log.close();
  const lines = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 5);
});
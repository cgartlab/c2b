/**
 * encoder-probe.test.js — 探测缓存
 *
 * 目标：冷启动的串行探测成本（多候选 × 超时）只付一次；
 * 缓存命中仍做**一次复验**，绝不"免验证硬跑"。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  probeSig, probeCacheFile, selectEncoder, ENCODER_CANDIDATES,
} from '../src/encoder-probe.js';
import { resolveExecutable } from '../src/proc.js';

const ff = resolveExecutable('ffmpeg');
const tmp = () => mkdtempSync(path.join(tmpdir(), 'probe-test-'));

/* ── 纯函数：签名 ── */

test('probeSig：ffmpeg mtime / 工况 / prefer 任一变化即变', () => {
  const fake = path.join(tmp(), 'ffmpeg-fake.exe');
  writeFileSync(fake, 'x');
  const base = probeSig(fake, { width: 1920, height: 1080, bitrate: 8 });
  assert.equal(base, probeSig(fake, { width: 1920, height: 1080, bitrate: 8 }), '相同输入签名稳定');
  assert.notEqual(base, probeSig(fake, { width: 1280, height: 720, bitrate: 8 }), '分辨率变化 → 变');
  assert.notEqual(base, probeSig(fake, { width: 1920, height: 1080, bitrate: 8, prefer: 'libx264' }), 'prefer → 变');
  // 显式改写 mtime（部分临时目录的 mtime 粒度粗，重写小文件可能不更新时间戳）
  utimesSync(fake, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
  assert.notEqual(base, probeSig(fake, { width: 1920, height: 1080, bitrate: 8 }), 'ffmpeg 升级(mtime) → 变');
  assert.notEqual(probeSig('/a/ffmpeg.exe'), probeSig('/b/ffmpeg.exe'), '路径 → 变');
});

test('probeSig 对不存在的 ffmpeg 也返回稳定字符串', () => {
  const s = probeSig('definitely-not-exist.exe');
  assert.equal(s, probeSig('definitely-not-exist.exe'));
  assert.match(s, /definitely-not-exist\.exe/);
});

test('probeCacheFile 位于临时目录且文件名稳定', () => {
  assert.match(probeCacheFile(), /cam-to-bg-encoder-probe\.json$/);
});

test('probeCacheFile 分域：录制工况与壁纸工况各用独立缓存（防单条目互相冲刷）', () => {
  const wall = probeCacheFile();
  const wall2 = probeCacheFile('wallpaper');
  const rec = probeCacheFile('record');
  assert.equal(wall, wall2, '缺省与显式 wallpaper 同域（文件名不变）');
  assert.notEqual(rec, wall, '录制工况（屏幕分辨率+录制码率）必须与壁纸工况分文件');
  assert.match(rec, /cam-to-bg-encoder-probe-record\.json$/);
  assert.notEqual(probeCacheFile('record'), probeCacheFile('wallpaper'));
});

/* ── 集成：真实探测 + 缓存流 ── */

test('完整探测 → 写缓存 → 二次调用命中（缓存复验日志）', { skip: !ff }, async () => {
  const cacheFile = path.join(tmp(), 'cache.json');

  const r1 = await selectEncoder(ff, { cacheFile });
  assert.ok(ENCODER_CANDIDATES.some((e) => e.name === r1.encoder.name));
  assert.ok(existsSync(cacheFile), '首次探测成功后必须写缓存');
  const saved = JSON.parse(readFileSync(cacheFile, 'utf8'));
  assert.equal(saved.encoder, r1.encoder.name);
  assert.equal(saved.sig, probeSig(ff, {}), '缓存签名应与默认工况一致');

  const logs = [];
  const r2 = await selectEncoder(ff, { cacheFile, onLog: (m) => logs.push(m) });
  assert.equal(r2.encoder.name, r1.encoder.name, '缓存复验通过应返回同一编码器');
  assert.equal(r2.cached, true, '应标记为缓存命中');
  assert.ok(logs.some((m) => m.includes('缓存复验')), `应出现缓存复验日志，实际: ${logs.join(' | ')}`);
});

test('缓存指向无效编码器 → 丢弃缓存、完整探测并重写', { skip: !ff }, async () => {
  const cacheFile = path.join(tmp(), 'cache.json');
  const r1 = await selectEncoder(ff, { cacheFile });
  // 篡改：签名保持有效，但结论指向不存在的编码器
  const saved = JSON.parse(readFileSync(cacheFile, 'utf8'));
  writeFileSync(cacheFile, JSON.stringify({ ...saved, encoder: 'no-such-encoder' }));

  const logs = [];
  const r2 = await selectEncoder(ff, { cacheFile, onLog: (m) => logs.push(m) });
  assert.ok(ENCODER_CANDIDATES.some((e) => e.name === r2.encoder.name), '必须回落到真实可用的候选');
  const rewritten = JSON.parse(readFileSync(cacheFile, 'utf8'));
  assert.equal(rewritten.encoder, r2.encoder.name, '缓存应被真实结论重写');
});

test('工况变化（分辨率）→ 签名不同 → 缓存不命中，走完整探测', { skip: !ff }, async () => {
  const cacheFile = path.join(tmp(), 'cache.json');
  await selectEncoder(ff, { cacheFile }); // 默认工况缓存
  const before = JSON.parse(readFileSync(cacheFile, 'utf8'));

  const logs = [];
  await selectEncoder(ff, { cacheFile, width: 1280, height: 720, onLog: (m) => logs.push(m) });
  const after = JSON.parse(readFileSync(cacheFile, 'utf8'));
  assert.notEqual(after.sig, before.sig, '不同工况必须写入不同签名');
  assert.ok(!logs.some((m) => m.includes('缓存复验')), '不应命中默认工况的缓存');
});

test('cache:false 完全绕过缓存（不读不写）', { skip: !ff }, async () => {
  const cacheFile = path.join(tmp(), 'cache.json');
  const logs = [];
  await selectEncoder(ff, { cacheFile, cache: false, onLog: (m) => logs.push(m) });
  assert.ok(!existsSync(cacheFile), '禁用缓存时不应创建文件');
  assert.ok(!logs.some((m) => m.includes('缓存复验')));
});

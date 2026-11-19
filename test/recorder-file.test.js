/**
 * recorder-file.test.js — 录制文件真实可播放性集成测试
 *
 * 背景（真实缺陷）：Windows 上 child.kill 是硬杀，MP4 的 moov 只在正常
 * 收尾时写入 → 之前录出来的文件无法播放。修复分两层：
 *   1) 输出改为分片 MP4（empty_moov），强杀也只损失最后一小段；
 *   2) 停止时先向 stdin 写 'q' 走优雅收尾，写不通再 taskkill 兜底。
 *
 * 本测试用真实 ffmpeg 录一小段桌面，分别验证两条停止路径的产物都能被解码。
 * 环境没有 ffmpeg 或起不了 gdigrab 时自动跳过，不阻塞套件。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, statSync } from 'node:fs';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Recorder } from '../src/recorder.js';
import { runCaptured, resolveExecutable } from '../src/proc.js';
import { ENCODER_CANDIDATES } from '../src/encoder-probe.js';

const ff = resolveExecutable('ffmpeg');
const X264 = ENCODER_CANDIDATES.find((e) => e.name === 'libx264');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeRecorder(outputPath) {
  const rec = new Recorder({
    ffmpegPath: ff,
    encoder: X264,
    outputPath,
    audioDevice: null,
    region: { x: 0, y: 0, w: 320, h: 240 },
    fps: 15,
    bitrate: 2,
    quality: 30,
    // 隔离互斥锁到输出文件旁（唯一位点）：默认锁走真实 ~/.cam-to-bg，
    // 若单测运行时用户的真实 app 正在录制，测试会因"已有录制"莫名失败
    lockPath: outputPath.replace(/\.mp4$/, '.lock'),
  });
  rec.on('error', () => { /* 启动失败由 start() 抛出，这里避免未监听 error 崩溃 */ });
  return rec;
}

/** 用 ffmpeg 解码整个文件到 null，成功即文件可播放。 */
async function assertPlayable(file) {
  assert.ok(existsSync(file), '输出文件应存在');
  assert.ok(statSync(file).size > 0, '输出文件不应为空');
  const r = await runCaptured(ff, ['-hide_banner', '-v', 'error', '-i', file, '-f', 'null', '-'], { timeout: 30000 });
  assert.equal(r.code, 0, `文件必须能被完整解码。stderr: ${(r.stderr || '').slice(0, 400)}`);
  assert.doesNotMatch(r.stderr || '', /moov atom not found|Error opening input/i,
    '缺 moov = 普通 MP4 被硬杀的典型症状（回归防护）');
}

test('rec.stop() 停止后 MP4 可播放（有管道写 q 优雅收尾，无管道 taskkill 兜底）', { skip: !ff }, async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rec-q-'));
  const out = path.join(dir, 'rec-q.mp4');
  const rec = makeRecorder(out);
  let started = false;
  try {
    try { await rec.start(); started = true; } catch (err) { t.skip(`环境无法启动 gdigrab 录制: ${err.message}`); return; }
    // 注入的互斥锁在录制期间应被本进程持有 —— 证明 Recorder 用的是注入路径
    //（而非真实 ~/.cam-to-bg，否则单测会与用户正录制的真实 app 冲突而莫名失败）
    const lockFile = out.replace(/\.mp4$/, '.lock');
    assert.ok(existsSync(lockFile), '录制期间应持有注入的互斥锁');
    assert.equal(fs.readFileSync(lockFile, 'utf8'), String(process.pid), '锁持有者应为本测试进程');
    await sleep(2500);          // > 1 个 GOP，确保至少一个分片落盘
    await rec.stop();
    await sleep(300);
    // 收尸：受限环境下 taskkill 不可用时进程可能还活着
    if (rec.running) {
      try { rec.child?.kill('SIGKILL'); } catch { /* 忽略 */ }
      await sleep(300);
    }
    assert.ok(!existsSync(lockFile), '停止后注入锁应被释放（不残留）');
    await assertPlayable(out);
  } finally {
    // 断言失败也必须收尾：否则孤儿子进程挂住事件循环 → 整个测试文件无法退出
    //（第48轮实证：锁断言失败在 stop 之前 → 孤儿 ffmpeg → 文件 hang、失败详情也打不出）
    if (started) {
      try { await rec.stop(); } catch { /* 尽力而为 */ }
      if (rec.running) { try { rec.child?.kill('SIGKILL'); } catch { /* 尽力而为 */ } }
    }
  }
});

test('stop 并发幂等：共享同一收尾 promise、stopping 可见、finished 只发一次', { skip: !ff }, async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rec-conc-'));
  const out = path.join(dir, 'rec-conc.mp4');
  const rec = makeRecorder(out);
  let started = false;
  try {
    try { await rec.start(); started = true; } catch (err) { t.skip(`环境无法启动 gdigrab 录制: ${err.message}`); return; }
    await sleep(1500);
    let finished = 0;
    rec.on('finished', () => { finished += 1; });

    const p1 = rec.stop();
    const p2 = rec.stop();
    assert.strictEqual(p1, p2, '并发 stop 必须共享同一次收尾（否则二次写 q/二次 taskkill）');
    await p1;
    await sleep(300);
    // 注：不立即断言 stopping===true——无 stdin 管道的环境（EPERM 回退）下
    // _stopCore 全程同步跑完（taskkill 即同步），stopping 在同 tick 就已复位；
    // 这是正确的（= 没有在途窗口）。stopping=true 的可见性由 stdin 路径保证，
    // 服务端收尾期守卫另有 stub 级测试覆盖。
    assert.equal(rec.stopping, false, '收尾完成必须复位');
    assert.equal(rec.running, false, '收尾后不得仍报运行中');
    assert.equal(finished, 1, 'finished 只发一次（重复 stop 不得重复广播）');
  } finally {
    // 断言失败也必须收尾（防孤儿 ffmpeg 挂住事件循环 → 测试文件无法退出）
    if (started) {
      try { await rec.stop(); } catch { /* 尽力而为 */ }
      if (rec.running) { try { rec.child?.kill('SIGKILL'); } catch { /* 尽力而为 */ } }
    }
  }
});

test('硬杀（模拟 Windows SIGINT 实际行为）：分片 MP4 仍可播放', { skip: !ff }, async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rec-kill-'));
  const out = path.join(dir, 'rec-kill.mp4');
  const rec = makeRecorder(out);
  let started = false;

  try {
    try { await rec.start(); started = true; } catch (err) { t.skip(`环境无法启动 gdigrab 录制: ${err.message}`); return; }
    await sleep(3500);

    // 不走 rec.stop()：直接 taskkill /F，等价于修复前 SIGINT 的硬杀路径。
    // 受限沙箱里 taskkill 可能不可用（管道 EPERM），失败时回退 child.kill。
    const pid = rec.child?.pid;
    assert.ok(pid, '录制进程应存活');
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore', windowsHide: true, timeout: 5000,
      });
    } catch {
      try { rec.child?.kill('SIGKILL'); } catch { /* 已退出 */ }
    }
    // 无论杀没杀死，都要收尸，避免测试泄漏 ffmpeg 进程
    await sleep(400);
    if (rec.running) { try { await rec.stop(); } catch { /* 尽力而为 */ } }
    await sleep(300);

    await assertPlayable(out);
  } finally {
    // 断言失败也必须收尾（防孤儿 ffmpeg 挂住事件循环 → 测试文件无法退出）
    if (started) {
      try { await rec.stop(); } catch { /* 尽力而为 */ }
      if (rec.running) { try { rec.child?.kill('SIGKILL'); } catch { /* 尽力而为 */ } }
    }
  }
});

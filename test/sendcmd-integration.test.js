/**
 * sendcmd-integration.test.js — sendcmd 滤镜链的真实 ffmpeg 集成测试
 *
 * 背景（真实缺陷）：
 * ffmpeg 的滤镜参数以 `:` 分隔，Windows 绝对路径形如 `C:/x/y.txt`，
 * 其中的冒号会被当成下一个选项名，导致：
 *     No option name near '/x/y.txt'
 *     Error parsing a filter description
 * 实测绝对路径（正斜杠/反斜杠/转义冒号）全部失败，只有纯文件名可用。
 *
 * 因此 buildFilterChain 只接受"纯文件名"，调用方需把 ffmpeg 的 cwd
 * 设为该文件所在目录。本测试用真实 ffmpeg 固化这一约束。
 *
 * 若环境没有 ffmpeg，测试会自动跳过而不是失败。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildFilterChain, buildSendcmdContent } from '../src/filters.js';
import { runCaptured, resolveExecutable } from '../src/proc.js';

const ff = resolveExecutable('ffmpeg');
const TARGET = { width: 640, height: 480 };

/** 跑一段合成视频，验证滤镜链能被 ffmpeg 解析。 */
async function runChain(vf, dir) {
  const out = path.join(dir, 'out.ts');
  const r = await runCaptured(ff, [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=size=640x480:rate=30',
    '-vf', vf,
    '-c:v', 'libx264', '-preset', 'ultrafast',
    '-frames:v', '5', '-y', out,
  ], { timeout: 30000, cwd: dir });
  return { code: r.code, stderr: r.stderr || '', out };
}

test('纯文件名的 sendcmd 滤镜链能被 ffmpeg 解析', { skip: !ff }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sendcmd-ok-'));
  const name = 'cam-to-bg-cmd-test.txt';
  writeFileSync(path.join(dir, name), buildSendcmdContent({ brightness: 0.25, contrast: 1.4 }), 'utf8');

  const vf = buildFilterChain({ scaleMode: 'fill' }, TARGET, name);
  assert.match(vf, /^sendcmd=f=cam-to-bg-cmd-test\.txt,/, '滤镜链应以纯文件名开头');

  const r = await runChain(vf, dir);
  assert.equal(r.code, 0, `ffmpeg 应成功编码。stderr: ${r.stderr.slice(0, 200)}`);
  assert.ok(statSync(r.out).size > 0, '应产生非空输出');
});

test('绝对路径会导致滤镜解析失败（回归防护）', { skip: !ff }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sendcmd-bad-'));
  const name = 'cmd.txt';
  const abs = path.join(dir, name);
  writeFileSync(abs, buildSendcmdContent({ brightness: 0.3 }), 'utf8');

  // 故意用绝对路径 —— 这正是修复前的错误做法
  const vf = `sendcmd=f=${abs.replace(/\\/g, '/')},eq=brightness=0:eval=frame,format=yuv420p`;
  const r = await runChain(vf, dir);

  assert.notEqual(r.code, 0, '绝对路径应当失败（C: 的冒号破坏滤镜解析）');
  assert.match(r.stderr, /No option name|Error parsing/i, '应报滤镜解析错误');
});

test('几何变换 + sendcmd + 色彩 + 缩放 的完整链可被解析', { skip: !ff }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sendcmd-full-'));
  const name = 'cmd.txt';
  writeFileSync(path.join(dir, name), buildSendcmdContent({ brightness: 0.1, hue: 20 }), 'utf8');

  const vf = buildFilterChain(
    { flipHorizontal: true, rotate: '90', scaleMode: 'fit' },
    TARGET,
    name,
  );
  const r = await runChain(vf, dir);
  assert.equal(r.code, 0, `完整链应可解析。stderr: ${r.stderr.slice(0, 200)}`);
});
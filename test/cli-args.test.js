/**
 * cli-args.test.js — flag/位置参数分类
 *
 * 背景（第50轮）：flag 过滤历史上只认 `--` → 单字母短 flag（-v/-l）被当成
 * 位置参数，flags.has('-v')/('-l') 恒 false —— 意图中的简写从未生效，
 * 实测 `c2b logs -l` 把 -l 当 runId 报"未找到运行: -l"。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { isFlagArg } from '../src/cli-args.js';

test('单字母短 flag 被识别为 flag（-v/-l 历史上恒 false）', () => {
  assert.equal(isFlagArg('-v'), true, '-v (verbose 简写)');
  assert.equal(isFlagArg('-l'), true, '-l (logs --last 简写)');
  assert.equal(isFlagArg('--verbose'), true, '长 flag 仍识别');
  assert.equal(isFlagArg('--max-duration'), true);
});

test('负数与配置项不被误判为 flag（否则 set 负值/runId 会被吞）', () => {
  assert.equal(isFlagArg('-0.5'), false, '独立负数小数');
  assert.equal(isFlagArg('-3'), false, '独立负整数');
  assert.equal(isFlagArg('brightness=-0.5'), false, 'k=v 形式的负值');
  assert.equal(isFlagArg('fps=60'), false, '普通配置项');
  assert.equal(isFlagArg('20260923_143005_12345_ab12'), false, 'runId 是位置参数');
  assert.equal(isFlagArg('start'), false, '子命令');
});

test('cli.js 真的用 isFlagArg 分类（防退回只认 -- 的历史实现）+ help 记载短 flag', () => {
  const cli = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js'), 'utf8',
  );
  assert.ok(cli.includes('rest.filter(isFlagArg)'), 'flags 收集必须走 isFlagArg');
  assert.ok(cli.includes('!isFlagArg(a)'), 'positionals 排除必须走 isFlagArg');
  assert.ok(/--verbose\|-v/.test(cli), 'help 应记载 -v 简写（否则用户不知道可用）');
  assert.ok(/--last\|-l/.test(cli), 'help 应记载 -l 简写');
  // 代码里仍在使用这两个简写（意图与实现一致）
  assert.ok(cli.includes("flags.has('-v')") && cli.includes("flags.has('-l')"),
    'flags.has("-v")/("-l") 必须存在（否则说明简写被移除，help 也应同步）');
});

test('help 通用约定：--help/-h 等价 help，且 usage 自列 help（历史上 --help 报"未知命令"）', () => {
  const cli = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js'), 'utf8',
  );
  assert.ok(cli.includes("=== '--help'") && cli.includes("=== '-h'"),
    'main 分发必须把 --help/-h 归一到 help');
  assert.ok(/cam-to-bg help\s+/.test(cli) && /显示帮助/.test(cli),
    'usage 必须自列 help 命令（已注册却曾不在自己的 usage 里）');
});

test('probe 退出码反映可用性（历史上恒 0 → probe && start 带病继续）', () => {
  const cli = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js'), 'utf8',
  );
  assert.ok(/return failed \? 1 : 0/.test(cli), 'cmdProbe 必须按 failed 返回非零');
  // 三个致命失败点都要置 failed：依赖缺失 / 桌面探测失败 / 编码器探测失败
  assert.ok((cli.match(/failed = true/g) || []).length >= 3,
    `三个致命点都应置 failed，实际 ${(cli.match(/failed = true/g) || []).length} 处`);
  assert.ok(/for \(const p of env\.problems\) \{ out\(` {2}! \$\{p\}`\); failed = true; \}/.test(cli)
    || cli.includes('for (const p of env.problems) { out(`  ! ${p}`); failed = true; }'),
    'env.problems（缺 ffmpeg/mpv）必须置 failed');
});

test('status 退出码携带状态（历史上恒 0 → status && … 无法门控）', () => {
  const cli = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js'), 'utf8',
  );
  assert.ok(/状态: 未运行'[\s\S]{0,1200}?return 3;/.test(cli),
    '未运行分支必须 return 3（与运行中 0、内部错误 1 区分）');
  assert.ok(cli.includes('退出码 0=运行中 / 3=未运行'), 'help 应记载 status 退出码约定');
});

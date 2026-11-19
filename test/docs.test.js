/**
 * docs.test.js — 文档与代码的双向一致性（防 README 再次漂移）
 *
 * 背景：第 9 轮审计发现 README 在 8 轮修复后积累了 9 处失真
 *（命令缺漏、参数语义过时、测试数过期……）。文档是产品面，
 * 漂移会直接误导用户——用测试把最容易漂的三类锚死：
 *   1. 命令清单（README ⟷ cli.js 注册表）
 *   2. npm 脚本（README 快速开始 ⟷ package.json）
 *   3. 环境变量（代码实际使用 ⟷ README 记载）
 *   4. 测试规模声明（README 数字 ≤ 实际数量）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const readme = readFileSync(path.join(root, 'README.md'), 'utf8');
const cliSrc = readFileSync(path.join(root, 'src', 'cli.js'), 'utf8');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

test('README 命令清单与 cli.js 注册命令双向一致', () => {
  const block = /const commands = \{([\s\S]*?)\n\};/.exec(cliSrc);
  assert.ok(block, 'cli.js 应有 commands 注册表');
  const cliCmds = new Set([...block[1].matchAll(/([a-z]+):\s*cmd[A-Z]\w*/g)].map((m) => m[1]));
  assert.ok(cliCmds.size >= 8, `注册命令数异常: ${cliCmds.size}`);

  const docCmds = new Set([...readme.matchAll(/cam-to-bg ([a-z]+)\b/g)].map((m) => m[1]));

  const missingInReadme = [...cliCmds].filter((c) => !docCmds.has(c));
  const staleInReadme = [...docCmds].filter((c) => !cliCmds.has(c));
  assert.deepEqual(missingInReadme, [], `README 缺少已实现的命令: ${missingInReadme}`);
  assert.deepEqual(staleInReadme, [], `README 文档了不存在的命令: ${staleInReadme}`);
});

test('README 快速开始的 npm 脚本都存在于 package.json', () => {
  const firstBlock = /```bash\n([\s\S]*?)```/.exec(readme);
  assert.ok(firstBlock, 'README 应有快速开始代码块');
  const scripts = [...firstBlock[1].matchAll(/npm (?:run )?([\w:-]+)/g)].map((m) => m[1]);
  assert.ok(scripts.length >= 4, `快速开始应列出若干脚本，实际: ${scripts.join(',')}`);
  for (const s of scripts) {
    assert.ok(pkg.scripts && pkg.scripts[s], `package.json 缺少 script: ${s}（README 却在教用户跑它）`);
  }
});

test('代码使用的全部 CAM_TO_BG_* 环境变量都被 README 记载', () => {
  const srcDir = path.join(root, 'src');
  const used = new Set();
  for (const f of readdirSync(srcDir, { recursive: true })) {
    if (!String(f).endsWith('.js')) continue;
    const txt = readFileSync(path.join(srcDir, f), 'utf8');
    for (const m of txt.matchAll(/CAM_TO_BG_[A-Z_]+/g)) used.add(m[0]);
  }
  const documented = new Set([...readme.matchAll(/CAM_TO_BG_[A-Z_]+/g)].map((m) => m[0]));
  const missing = [...used].filter((v) => !documented.has(v));
  assert.ok(used.size >= 4, `代码应使用多个环境变量，实际: ${used.size}`);
  assert.deepEqual(missing, [], `README 未记载代码实际使用的环境变量: ${missing}`);
});

test('README 声称的测试规模不超过实际测试数量（防"55 个测试"式过期）', () => {
  const claim = /运行 \*\*(\d+)\+\*\* 个测试/.exec(readme);
  assert.ok(claim, 'README 应声明测试规模（N+ 格式）');
  const claimed = Number(claim[1]);

  let actual = 0;
  const testDir = path.join(root, 'test');
  for (const f of readdirSync(testDir)) {
    if (!String(f).endsWith('.js')) continue;
    const txt = readFileSync(path.join(testDir, f), 'utf8');
    actual += [...txt.matchAll(/(^|\n)\s*test\(/g)].length;
  }
  assert.ok(actual >= claimed,
    `README 声称 ${claimed}+ 个测试，但实际只数到 ${actual} 个 test() —— 声明已过期`);
});

test('README 项目结构清单与 src/*.js 双向一致（新文件漏列/幽灵条目）', () => {
  // 从 README 的结构代码块抽取 `  xxx.js` 条目
  const blockMatch = /```\nsrc\/([\s\S]*?)```/.exec(readme);
  assert.ok(blockMatch, 'README 应含 src/ 结构代码块');
  const listed = new Set([...blockMatch[1].matchAll(/^ {2}([\w.-]+\.js)\s/mg)].map((m) => m[1]));

  const actual = readdirSync(path.join(root, 'src')).filter((f) => f.endsWith('.js')).map(String);

  const missing = actual.filter((f) => !listed.has(f));
  assert.deepEqual(missing, [], `src 文件未列入 README 结构清单: ${missing.join(', ')}`);

  const phantom = [...listed].filter((f) => !actual.includes(f));
  assert.deepEqual(phantom, [], `README 结构清单列了不存在的文件: ${phantom.join(', ')}`);
});

test('CLI 输出不宣称未实现的 flag（幽灵 flag 回归防护）', () => {
  // 背景：cmdDevices 曾提示 `--device "名称"`，但全代码无解析 → 用户照做被静默忽略。
  // 不变量：cli.js **代码**（剥离行/块注释后）出现的每个 `--flag` 都必须出现在
  // 解析表达式里（flags.has / startsWith / indexOf），否则就是只写在提示里的幽灵 flag。
  //（注释可提及历史 flag 做说明，故先剥离注释再扫描。）
  const raw = readFileSync(path.join(root, 'src', 'cli.js'), 'utf8');
  const code = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  const tokens = new Set([...code.matchAll(/--([a-z][a-z0-9-]+)/g)].map((m) => m[0]));
  assert.ok(tokens.size >= 3, `应至少识别到几个 flag，实际 ${tokens.size}`);
  const ghost = [...tokens].filter((tok) => !(
    code.includes(`flags.has('${tok}')`)
    || code.includes(`startsWith('${tok}')`)
    || code.includes(`indexOf('${tok}')`)
    || code.includes(`=== '${tok}'`) // 命令别名分发（如 --help → help），非幽灵 flag
  ));
  assert.deepEqual(ghost, [],
    `CLI 宣称但未实现的幽灵 flag: ${ghost.join(', ')}（提示了用户却静默忽略）`);
});

/**
 * ui-consistency.test.js — 前端 id 引用一致性
 *
 * 防一类真实回归：app.js 用 $('id') 取元素，index.html 改版删掉某个 id
 * 后不会报编译错，只会运行时静默失效（状态不刷新、按钮点了没反应）。
 * 这里静态比对：JS 里引用的每个 id 都必须存在于 HTML，
 * 例外是 buildField 动态创建的 id 前缀（in-/num-/val-）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const uiDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'ui');
const html = readFileSync(path.join(uiDir, 'index.html'), 'utf8');
const js = readFileSync(path.join(uiDir, 'app.js'), 'utf8');

const DYNAMIC_PREFIX = /^(in-|num-|val-)/;

test('app.js 引用的所有 id 都存在于 index.html', () => {
  const refs = [...js.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]);
  assert.ok(refs.length > 10, `app.js 应引用了若干 id，实际 ${refs.length}`);

  const missing = [...new Set(refs)]
    .filter((id) => !DYNAMIC_PREFIX.test(id))
    .filter((id) => !html.includes(`id="${id}"`));
  assert.deepEqual(missing, [], `index.html 缺少 id: ${missing.join(', ')}`);
});

test('关键交互入口都在：重启（顶栏+横幅）、录制、页签容器、toast 容器', () => {
  for (const id of ['btnRestart', 'btnBannerRestart', 'btnStop', 'btnRecord',
    'tabs', 'panels', 'advPanel', 'toasts', 'restartBanner', 'connHint']) {
    assert.ok(html.includes(`id="${id}"`), `缺少 #${id}`);
  }
});

test('meta viewport 存在（响应式前提）', () => {
  assert.match(html, /name="viewport" content="width=device-width/);
});

test('app.js 不再引用已废弃的 saveHint（v2 改用 toast）', () => {
  assert.ok(!js.includes('saveHint'), 'saveHint 元素已随 v2 移除，不应再被引用');
  assert.ok(!html.includes('saveHint'));
});

test('反馈精确性三件套在位：中文标签映射、flush 在途守卫、规范化值回填', () => {
  assert.ok(js.includes('function keyLabel('), '横幅须经 keyLabel 映射中文标签（禁止裸显英文键名）');
  assert.ok(js.includes('state.flushing'), 'flush 必须有在途守卫（并行 flush 会响应乱序互相覆盖）');
  assert.ok(js.includes('syncFieldsFromConfig'), '服务端规范化值必须回填控件（否则界面与生效值两张皮）');
  assert.ok(js.includes('改动已保留'), '保存失败不得吞掉用户编辑（须回填 pending 缓冲）');
  assert.match(js, /bannerText/);
});

test('麦克风已改为下拉选择（自由文本曾使手滑/改名即录制失败）', () => {
  assert.ok(js.includes("key === 'recAudioDevice'"), 'recAudioDevice 必须走专用下拉分支');
  assert.ok(js.includes('audioDevices'), '必须加载麦克风列表');
  assert.ok(js.includes('当前不可用'), '配置中失效的麦克风须如实展示，不得静默变回不录音频');
});

test('端口切换与重连健壮性三件套在位', () => {
  assert.ok(js.includes('followPortSwitch'), 'uiPort 切换后必须探测新端口并跟跳（否则页面搁浅在死端口）');
  assert.ok(js.includes('wsReconnectTimer'), 'WS 重连必须走唯一受控定时器（防定时器堆积/重复连接）');
  assert.ok(js.includes('saveFails'), '保存失败必须有退避计数（防 220ms toast 风暴）');
});

test('WS 处理 CLI 发起的 port-switch 通告（否则 c2b set 改端口会搁浅打开的界面页）', () => {
  assert.ok(js.includes("msg.type === 'port-switch'"), '界面必须处理服务端的 port-switch 通告');
  assert.ok(js.includes('followPortSwitch(Number(msg.port)') || /followPortSwitch\(Number\(msg\.port\)/.test(js),
    '收到通告应调用 followPortSwitch 跟跳');
});

test('WS 处理外部 config 同步（否则 c2b set 后界面表单停留在旧值误导用户）', () => {
  assert.ok(js.includes("msg.type === 'config'"), '界面必须处理服务端的 config 同步广播');
  assert.ok(js.includes('applyExternalConfig'), '应调用 applyExternalConfig 更新表单');
  // round8 原则：外部同步绝不能打断正在编辑/未保存的字段
  assert.ok(js.includes('state.pending[k] !== undefined'), '须跳过本地有未保存编辑的键');
  assert.ok(/focused && focused\.id === `in-\$\{k\}`/.test(js) || js.includes("focused.id === `in-${k}`"),
    '须跳过当前聚焦的控件（不打断正在输入）');
});

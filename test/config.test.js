/**
 * config.test.js — 配置校验与规范化测试
 *
 * 重点验证"界面传入非法值时不会破坏配置"，因为设置界面允许自由拖动滑块。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SCHEMA,
  defaultConfig,
  coerceValue,
  normalizeConfig,
  mergeConfig,
} from '../src/config.js';

test('默认配置包含 schema 中的每一项', () => {
  const cfg = defaultConfig();
  for (const key of Object.keys(SCHEMA)) {
    assert.ok(key in cfg, `缺少默认值: ${key}`);
  }
});

test('数字超出范围时被夹到边界', () => {
  assert.equal(coerceValue('fps', 9999), SCHEMA.fps.max);
  assert.equal(coerceValue('fps', -5), SCHEMA.fps.min);
});

test('数字非法时回退到默认值', () => {
  assert.equal(coerceValue('fps', 'abc'), SCHEMA.fps.default);
  assert.equal(coerceValue('fps', null), SCHEMA.fps.default);
});

test('数字字符串被正确解析', () => {
  assert.equal(coerceValue('bitrate', '12.5'), 12.5);
});

test('布尔值支持多种表示', () => {
  assert.equal(coerceValue('flipHorizontal', 'true'), true);
  assert.equal(coerceValue('flipHorizontal', '1'), true);
  assert.equal(coerceValue('flipHorizontal', 1), true);
  assert.equal(coerceValue('flipHorizontal', 'false'), false);
});

test('旧配置的 mirror 自动迁移为 flipHorizontal', () => {
  const { config, warnings } = normalizeConfig({ mirror: true });
  assert.equal(config.flipHorizontal, true, 'mirror=true 应迁移为水平翻转');
  assert.ok(!('mirror' in config), '旧键不应保留');
  assert.ok(warnings.some((w) => /mirror/.test(w)), '应给出迁移提示');
});

test('同时存在 mirror 与 flipHorizontal 时以新键为准', () => {
  const { config } = normalizeConfig({ mirror: true, flipHorizontal: false });
  assert.equal(config.flipHorizontal, false);
});

test('水平与垂直翻转是彼此独立的开关', () => {
  const { config } = normalizeConfig({ flipHorizontal: true, flipVertical: false });
  assert.equal(config.flipHorizontal, true);
  assert.equal(config.flipVertical, false);

  const { config: c2 } = normalizeConfig({ flipHorizontal: false, flipVertical: true });
  assert.equal(c2.flipHorizontal, false);
  assert.equal(c2.flipVertical, true);
});

test('枚举非法取值回退到默认值', () => {
  assert.equal(coerceValue('scaleMode', 'bogus'), SCHEMA.scaleMode.default);
  assert.equal(coerceValue('scaleMode', 'fit'), 'fit');
});

test('rotate 作为字符串枚举被正确处理', () => {
  assert.equal(coerceValue('rotate', '270'), '270');
  assert.equal(coerceValue('rotate', 90), '90');
  assert.equal(coerceValue('rotate', '55'), SCHEMA.rotate.default);
});

test('normalizeConfig 丢弃未知键并告警', () => {
  const { config, warnings } = normalizeConfig({ unknownKey: 1, fps: 60 });
  assert.equal(config.fps, 60);
  assert.ok(!('unknownKey' in config));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /unknownKey/);
});

test('normalizeConfig 对超范围值给出告警', () => {
  const { config, warnings } = normalizeConfig({ fps: 1000 });
  assert.equal(config.fps, SCHEMA.fps.max);
  assert.ok(warnings.some((w) => /fps/.test(w)), '应提示 fps 超出范围');
});

test('normalizeConfig 能容忍非对象输入', () => {
  assert.deepEqual(normalizeConfig(null).config, defaultConfig());
  assert.deepEqual(normalizeConfig('nope').config, defaultConfig());
  assert.deepEqual(normalizeConfig(undefined).config, defaultConfig());
});

test('mergeConfig 只覆盖传入的键', () => {
  const base = defaultConfig();
  const { config } = mergeConfig(base, { fps: 60 });
  assert.equal(config.fps, 60);
  assert.equal(config.bitrate, base.bitrate, '未传入的键应保持原值');
});

test('mergeConfig 会夹住非法值', () => {
  const { config } = mergeConfig(defaultConfig(), { fps: -1 });
  assert.equal(config.fps, SCHEMA.fps.min);
});

test('每个参数都带有界面所需的分组与标签', () => {
  for (const [key, def] of Object.entries(SCHEMA)) {
    assert.ok(def.group, `${key} 缺少 group`);
    assert.ok(def.label, `${key} 缺少 label`);
    assert.ok(['number', 'boolean', 'enum', 'string'].includes(def.type), `${key} 类型非法`);
  }
});

test('number 类型必须同时定义 min 与 max', () => {
  for (const [key, def] of Object.entries(SCHEMA)) {
    if (def.type !== 'number') continue;
    assert.equal(typeof def.min, 'number', `${key} 缺少 min`);
    assert.equal(typeof def.max, 'number', `${key} 缺少 max`);
    assert.ok(def.min <= def.default && def.default <= def.max, `${key} 默认值不在范围内`);
  }
});

test('enum 类型的默认值必须在候选列表内', () => {
  for (const [key, def] of Object.entries(SCHEMA)) {
    if (def.type !== 'enum') continue;
    assert.ok(def.values.includes(String(def.default)), `${key} 默认值不在 values 中`);
  }
});

/* ────── 步进对齐与浮点噪声（噪声曾原样入库并向下游传播） ────── */

test('数字对齐步进网格并消除浮点噪声', () => {
  // 0.1+0.2 经典噪声：仅靠 round/乘除消不掉（30*0.01 === 0.30000000000000004），须 toFixed
  assert.equal(coerceValue('brightness', 0.30000000000000004), 0.3);
  assert.equal(coerceValue('bitrate', 8.500000000000001), 8.5);
  assert.equal(coerceValue('gamma', 1.0000000000000002), 1);
});

test('非网格值被吸到最近的步进点', () => {
  assert.equal(coerceValue('width', 1921), 1922, 'width step=2 → 偶数');
  assert.equal(coerceValue('fps', 29.9), 30, 'fps step=1 → 整数');
  assert.equal(coerceValue('bitrate', 8.7), 8.5, 'bitrate step=0.5 → 8.5');
});

test('normalizeConfig 对齐步进时如实告警，不静默改值', () => {
  const { config, warnings } = normalizeConfig({ fps: 29.9 });
  assert.equal(config.fps, 30);
  assert.ok(warnings.some((w) => /对齐步进/.test(w)), `应有对齐告警，实际: ${warnings.join(' | ')}`);
});

test('纯浮点噪声静默清理（不产生告警噪音）', () => {
  const { config, warnings } = normalizeConfig({ brightness: 0.30000000000000004 });
  assert.equal(config.brightness, 0.3, '噪声必须被清理');
  assert.deepEqual(warnings, [], '1e-17 量级的不可见噪声不值得打扰用户');
});

test('网格上的值不产生任何告警（避免正常保存被噪音淹没）', () => {
  const { warnings } = normalizeConfig({ fps: 60, bitrate: 8.5, brightness: 0.3 });
  assert.deepEqual(warnings, []);
});

test('对齐与夹取不叠加双告警（超范围只报超范围）', () => {
  const { config, warnings } = normalizeConfig({ fps: 1000 });
  assert.equal(config.fps, SCHEMA.fps.max);
  assert.equal(warnings.filter((w) => /fps/.test(w)).length, 1, '只应有超范围告警');
});

test('uiPort 设为浏览器禁止端口 → 回退默认并告警（否则设置界面永久打不开）', () => {
  // 6000 在 [1024,65535] 范围内，但属 WHATWG 禁止端口：
  // HTTP 服务绑得上，浏览器/fetch/c2b set 在线转发全被拒 → 界面不可达且难查。
  const { config, warnings } = normalizeConfig({ uiPort: 6000 });
  assert.equal(config.uiPort, SCHEMA.uiPort.default, '必须回退到默认端口（6000 浏览器拒绝访问）');
  assert.ok(warnings.some((w) => /uiPort/.test(w) && /6000/.test(w)),
    `应告警 6000 被回退，实际: ${JSON.stringify(warnings)}`);

  // 其余范围内的禁止端口同样回退
  for (const p of [10080, 5060, 6566, 6667]) {
    assert.equal(normalizeConfig({ uiPort: p }).config.uiPort, SCHEMA.uiPort.default,
      `${p} 也是禁止端口，应回退`);
  }
});

test('uiPort 正常端口不被改动、无保留端口告警', () => {
  for (const p of [5757, 8080, 3000, 1025, 65535]) {
    const { config, warnings } = normalizeConfig({ uiPort: p });
    assert.equal(config.uiPort, p, `${p} 应原样保留`);
    assert.ok(!warnings.some((w) => /保留端口/.test(w)), `${p} 不应触发保留端口告警`);
  }
});
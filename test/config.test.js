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
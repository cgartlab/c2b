/**
 * wallpaper.test.js — 配置变更分类的回归测试
 *
 * 这些断言对应代码审查中发现并修复的真实缺陷：
 *   S1: bitrate/quality 曾漏出重启判定列表，导致改码率/画质静默失效
 *   M1: sendcmd 写入失败曾被静默吞掉，谎报"已生效"
 *
 * 用最小的假 engine 实例测试 applyConfig 的分类逻辑，
 * 不需要真实摄像头或 ffmpeg。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WallpaperEngine, sweepStaleCmdFiles, COLOR_KEYS, GEOMETRY_KEYS, STRUCTURE_KEYS, resolveOutputTarget } from '../src/wallpaper.js';
import { defaultConfig, SCHEMA } from '../src/config.js';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const BASE = defaultConfig();

/** 造一个"看起来正在运行"的引擎，避免真实启动进程。 */
function makeEngine({ cmdFilePath = null } = {}) {
  const e = new WallpaperEngine({
    ffmpegPath: 'ffmpeg',
    mpvPath: 'mpv',
    config: { ...BASE },
  });
  e.state = 'running';
  e.pipeline = {
    stop: async () => {},
    child: null,
    streamUrl: null,
    recentLog: () => '',
  };
  e.cmdFilePath = cmdFilePath;
  e.desktop = null;
  e.effectiveCapture = null;
  e.device = { name: 'fake' };
  e.encoder = { name: 'h264_amf', label: 'test', hardware: true };
  return e;
}

test('改码率必须提示重启（S1 回归）', async () => {
  const e = makeEngine();
  const r = await e.applyConfig({ ...BASE, bitrate: 16 });
  assert.equal(r.mode, 'pending-restart', '码率是 ffmpeg 命令行参数，无法动态生效');
  assert.ok(r.pendingKeys.includes('bitrate'));
});

test('改画质必须提示重启（S1 回归）', async () => {
  const e = makeEngine();
  const r = await e.applyConfig({ ...BASE, quality: 18 });
  assert.equal(r.mode, 'pending-restart');
  assert.ok(r.pendingKeys.includes('quality'));
});

test('改色彩走 sendcmd，不需要重启', async () => {
  const e = makeEngine();
  const r = await e.applyConfig({ ...BASE, brightness: 0.2 });
  // cmdFilePath 为 null 时会如实报告写入失败，而不是谎报成功
  assert.ok(['sendcmd', 'sendcmd-failed'].includes(r.mode), `实际 mode=${r.mode}`);
});

test('cmd 文件写入失败时如实报告（M1 回归）', async () => {
  const e = makeEngine({ cmdFilePath: null });
  const r = await e.applyConfig({ ...BASE, brightness: 0.2 });
  assert.equal(r.mode, 'sendcmd-failed', '不能把写入失败谎报成已生效');
  assert.ok(r.error, '应带上失败原因');
});

test('改几何参数提示重启', async () => {
  for (const patch of [{ flipHorizontal: true }, { flipVertical: true }, { rotate: '90' }, { scaleMode: 'fit' }]) {
    const e = makeEngine();
    const r = await e.applyConfig({ ...BASE, ...patch });
    assert.equal(r.mode, 'pending-restart', `${Object.keys(patch)[0]} 应提示重启`);
  }
});

test('改结构参数提示重启', async () => {
  for (const patch of [{ fps: 60 }, { width: 1280 }, { height: 720 }, { encoder: 'libx264' }, { latencyMode: 'smooth' }]) {
    const e = makeEngine();
    const r = await e.applyConfig({ ...BASE, ...patch });
    assert.equal(r.mode, 'pending-restart', `${Object.keys(patch)[0]} 应提示重启`);
  }
});

test('无改动返回 none', async () => {
  const e = makeEngine();
  const r = await e.applyConfig({ ...BASE });
  assert.equal(r.mode, 'none');
});

test('未运行时任何改动都不触发重启', async () => {
  const e = makeEngine();
  e.state = 'idle';
  const r = await e.applyConfig({ ...BASE, bitrate: 20 });
  assert.equal(r.mode, 'none', '未运行时应只保存配置');
});

test('色彩与结构同时变更时优先提示重启', async () => {
  const e = makeEngine();
  const r = await e.applyConfig({ ...BASE, brightness: 0.3, bitrate: 20 });
  assert.equal(r.mode, 'pending-restart');
  assert.ok(r.pendingKeys.includes('bitrate'));
});

test('pendingKeys 只包含真正变化的键', async () => {
  const e = makeEngine();
  const r = await e.applyConfig({ ...BASE, fps: 45, bitrate: 12 });
  assert.deepEqual(r.pendingKeys.sort(), ['bitrate', 'fps']);
});

test('uiPort 变更不再要求重启管线（由 HTTP 服务自行 relisten，历史假选项）', async () => {
  const e = makeEngine();
  const r = await e.applyConfig({ ...BASE, uiPort: 5999 });
  assert.equal(r.mode, 'none', 'uiPort 与 ffmpeg/mpv 管线无关，不应要求重启');
});

test('重启进行中禁止并发 start（摄像头排他，曾是状态机漏洞）', async () => {
  const e = makeEngine();
  e.state = 'restarting';
  // 用真实 start()：守卫必须在任何副作用（_bindCleanup/_bringUp）之前触发
  await assert.rejects(() => e.start(), /不能并发启动/, '应以 BUSY 错误拒绝');
  assert.equal(e.state, 'restarting', '拒绝时不得改动状态');
});

test('启动进行中同样禁止并发 start', async () => {
  const e = makeEngine();
  e.state = 'starting';
  await assert.rejects(() => e.start(), /不能并发启动/);
  assert.equal(e.state, 'starting');
});

/* ────── 挂载模式告警（历史死分支：检查 ps1 永不返回的模式名） ────── */

test('workerw-small 挂载必须给出可见告警（否则表现为挂载成功但看不见画面）', () => {
  const e = makeEngine();
  const logs = [];
  e.on('log', (m) => logs.push(m));
  e._warnAttachMode('workerw-small');
  assert.ok(logs.some((m) => /裁成一小块/.test(m) && /explorer/.test(m)),
    `应告警并给出处置建议，实际: ${logs.join(' | ')}`);
});

test('标准模式（progman/workerw）不产生告警噪音', () => {
  const e = makeEngine();
  const logs = [];
  e.on('log', (m) => logs.push(m));
  e._warnAttachMode('progman');
  e._warnAttachMode('workerw');
  assert.deepEqual(logs, [], 'Win11 progman 是实测正常路径，不应刷警告');
});

test('死分支已移除：代码不再比较 progman-fallback（ps1 从不返回它）', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const src = readFileSync(fileURLToPath(new URL('../src/wallpaper.js', import.meta.url)), 'utf8');
  // 只断言"代码比较"消失；注释里回顾历史缺陷是允许的
  assert.ok(!/res\.mode\s*===\s*'progman-fallback'/.test(src),
    '永不触发的分支应删除，防止误导后续维护');
  assert.ok(src.includes('_warnAttachMode'), '告警必须收敛到统一入口（两处挂载都走它）');
});

/* ────── 生效语义一致性：schema.restart ⟺ applyConfig 分类（双向防谎） ────── */

test('schema 的 restart 标记与 applyConfig 分类严格等价', () => {
  const prompted = new Set([...GEOMETRY_KEYS, ...STRUCTURE_KEYS]);
  for (const [key, def] of Object.entries(SCHEMA)) {
    assert.equal(def.restart, prompted.has(key),
      `${key}: schema.restart=${def.restart} 与分类(pending-restart=${prompted.has(key)})不一致 —— `
      + '要么"标了需重启却永不提示/重启也不生效"、要么"弹了重启提示却不带标记"');
  }
});

test('色彩键全部即时生效（restart:false 且不在重启分类中）', () => {
  const prompted = new Set([...GEOMETRY_KEYS, ...STRUCTURE_KEYS]);
  for (const k of COLOR_KEYS) {
    assert.equal(SCHEMA[k].restart, false, `${k} 走 sendcmd 即时生效，不应标 restart`);
    assert.ok(!prompted.has(k), `${k} 不应出现在重启分类`);
  }
});

test('三类键互斥、无重复、全部存在于 schema', () => {
  const all = [...COLOR_KEYS, ...GEOMETRY_KEYS, ...STRUCTURE_KEYS];
  assert.equal(new Set(all).size, all.length, '三类之间不得有键重复');
  for (const k of all) assert.ok(k in SCHEMA, `分类引用了 schema 中不存在的键: ${k}`);
});

/* ────── resolveOutputTarget：编码器探测/壁纸输出共用的显示器选择 ────── */

const DESKTOP = {
  monitors: [
    // 刻意让副屏在前、主屏在后：EnumDisplayMonitors 不保证主屏首位，
    // SCHEMA 契约仍要求 monitor:0 = 主屏（本测试即该契约的回归防护）
    { width: 2560, height: 1440, primary: false },
    { width: 1920, height: 1080, primary: true },
  ],
};

test('resolveOutputTarget：0=主显示器（SCHEMA 契约），即便枚举顺序主屏在后', () => {
  const fb = { width: 999, height: 999 };
  const t0 = resolveOutputTarget(DESKTOP, 0, fb);
  assert.equal(t0.width, 1920, '序号 0 必须是主屏（契约"0=主显示器"），而非枚举首位的副屏');
  assert.equal(t0.monitor.primary, true);
  const t1 = resolveOutputTarget(DESKTOP, 1, fb);
  assert.equal(t1.width, 2560, '序号 1 = 副屏');
  assert.equal(t1.monitor.primary, false);
});

test('resolveOutputTarget 序号越界/缺省 → 回退主屏', () => {
  const t = resolveOutputTarget(DESKTOP, 9, { width: 999, height: 999 });
  assert.equal(t.width, 1920, '越界应回退 primary');
  // 无 primary 时取第一个（保持原枚举顺序）
  const t3 = resolveOutputTarget({ monitors: [{ width: 800, height: 600 }] }, 5, { width: 1, height: 1 });
  assert.equal(t3.width, 800, '无 primary 回退首个显示器');
});

test('resolveOutputTarget 无显示器信息 → 回退 fallback 尺寸（不崩）', () => {
  const t = resolveOutputTarget(null, 0, { width: 1280, height: 720 });
  assert.equal(t.width, 1280);
  assert.equal(t.height, 720);
  assert.equal(t.monitor, null, '探测失败时 monitor 为 null');
  const t2 = resolveOutputTarget({ monitors: [] }, undefined, { width: 640, height: 480 });
  assert.equal(t2.width, 640, '空 monitors 也回退 fallback');
});

test('resolveOutputTarget 返回所选 monitor 对象（挂载/区域钳制依赖它）', () => {
  const t = resolveOutputTarget(DESKTOP, 1, { width: 1, height: 1 });
  assert.equal(t.monitor.width, 2560, '应返回按序选中的 monitor 引用本身');
  assert.equal(t.monitor, DESKTOP.monitors[0], '排序不改对象引用（副屏即原枚举第一位）');
});

test('应用启动级配置不冒充"管线重启"（openUiOnStart 只影响下次启动）', () => {
  assert.equal(SCHEMA.openUiOnStart.restart, false, '点"重启"并不会重新打开 UI，标 restart 是谎言');
  assert.match(SCHEMA.openUiOnStart.help, /下次启动/, '必须如实说明生效时机');
});

test('logLevel/logRetainRuns 已改为即时生效（历史上标了 restart 却双重静默失效）', () => {
  assert.equal(SCHEMA.logLevel.restart, false);
  assert.equal(SCHEMA.logRetainRuns.restart, false);
  assert.match(SCHEMA.logLevel.help, /立即生效/);
  assert.match(SCHEMA.logRetainRuns.help, /立即生效/);
});

/* ────── sendcmd 残留文件清扫（崩溃遗留会永久堆积在 %TEMP%） ────── */

test('sweepStaleCmdFiles 删除同前缀遗留文件（含 .tmp），不碰无关文件', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sweep-test-'));
  const stale1 = path.join(dir, 'cam-to-bg-cmd-111-aaaa.txt');
  const stale2 = path.join(dir, 'cam-to-bg-cmd-222-bbbb.txt.tmp');
  const keep = path.join(dir, 'someone-elses-file.txt');
  writeFileSync(stale1, 'x');
  writeFileSync(stale2, 'x');
  writeFileSync(keep, 'x');

  const removed = sweepStaleCmdFiles(dir);
  assert.equal(removed.length, 2, `应清掉 2 个遗留，实际: ${removed.join(',')}`);
  assert.ok(!existsSync(stale1));
  assert.ok(!existsSync(stale2), '临时 .tmp 也要清');
  assert.ok(existsSync(keep), '无关文件必须保留');
});

test('sweepStaleCmdFiles 目录不可读/为空时安全返回', () => {
  assert.deepEqual(sweepStaleCmdFiles(path.join(tmpdir(), 'no-such-dir-xyz')), []);
});

/* ────── 崩溃状态诚实：ffmpeg/mpv 死了就不许再报 running ────── */

test('管线崩溃：running → error、startedAt 清空、事件照常外抛', () => {
  const e = makeEngine();
  e.startedAt = Date.now();
  let emitted = null;
  e.once('pipeline-exit', (info) => { emitted = info; });
  e._onPipelineCrash({ code: 1 });
  assert.equal(e.state, 'error', '历史缺陷：状态不变，界面显示运行中而壁纸已冻住');
  assert.equal(e.startedAt, null, '运行时长失去意义应清空');
  assert.deepEqual(emitted, { code: 1 }, 'index.js 依赖该事件刷新状态文件');
});

test('渲染器崩溃：running → error', () => {
  const e = makeEngine();
  e.startedAt = Date.now();
  let emitted = null;
  e.once('renderer-exit', (info) => { emitted = info; });
  e._onRendererCrash({ code: 2 });
  assert.equal(e.state, 'error');
  assert.deepEqual(emitted, { code: 2 });
});

test('启动/重启过程中的崩溃不越权改状态（由该流程自身失败路径收敛）', () => {
  for (const st of ['starting', 'restarting']) {
    const e = makeEngine();
    e.state = st;
    e._onPipelineCrash({ code: 1 });
    assert.equal(e.state, st, `${st} 态下不应被崩溃回调改写`);
  }
});

/* ────── error 态恢复：start 前必须清理崩溃现场（防孤儿浮窗） ────── */

test('start 先清理上一轮残留再 bring-up', async () => {
  const e = makeEngine();
  e.state = 'error';
  e.attached = true;
  let rStopped = false; let pStopped = false;
  e.renderer = { stop: async () => { rStopped = true; }, child: null };
  e.pipeline = { stop: async () => { pStopped = true; }, child: null };
  e._bindCleanup = () => {}; // 避免测试向 process 挂 exit 监听
  e._bringUp = async () => ({ state: 'running' });

  const st = await e.start();
  assert.ok(st, '应完成启动');
  assert.ok(rStopped, '旧 renderer 必须被停掉，否则覆盖引用后成孤儿浮窗');
  assert.ok(pStopped, '旧 pipeline 必须被停掉');
  assert.equal(e.renderer, null);
  assert.equal(e.pipeline, null);
  assert.equal(e.attached, false);
  assert.equal(e.state, 'running');
});

/* ────── 重启的采集参数判断基准（协商设备重启失败的真实缺陷） ────── */

/** 让 restart 走到"决策已做、new Pipeline 前后即失败"的确定性失败点。 */
function restartWithBaseline(baseline, effective, patch = {}) {
  const e = makeRestartEngine();
  e.config = { ...BASE, ...patch };
  e.requestedConfig = { ...BASE, ...patch };
  e._lastRequestedCapture = baseline;
  e.effectiveCapture = effective;
  e.device = null; // 决策之后必然抛错，便于观察决策结果
  return e;
}

test('用户没改参数 → 恢复协商结果（历史缺陷：协商设备每次重启都失败）', async () => {
  const eff = { width: 2560, height: 1440, fps: 30 };
  const base = { width: BASE.width, height: BASE.height, fps: BASE.fps };
  const e = restartWithBaseline(base, eff);
  await assert.rejects(() => e.restart());
  assert.deepEqual(e.effectiveCapture, eff,
    '协商值必须恢复——否则回退到设备并不支持的原始值，重启永远失败');
  assert.deepEqual(e._lastRequestedCapture, base, '基准应刷新为本轮原始意图');
});

test('用户真改了参数 → 清空协商结果、用新值尝试', async () => {
  const eff = { width: 2560, height: 1440, fps: 30 };
  const base = { width: BASE.width, height: BASE.height, fps: BASE.fps };
  const e = restartWithBaseline(base, eff, { width: 1280, height: 720 });
  await assert.rejects(() => e.restart());
  assert.equal(e.effectiveCapture, null, '改了参数必须放弃旧协商值');
  assert.deepEqual(e._lastRequestedCapture,
    { width: 1280, height: 720, fps: BASE.fps }, '基准刷新为新意图');
});

test('无基准（首启动即重启）→ 保守恢复协商值', async () => {
  const eff = { width: 1920, height: 1080, fps: 60 };
  const e = restartWithBaseline(null, eff);
  await assert.rejects(() => e.restart());
  assert.deepEqual(e.effectiveCapture, eff, '没有比较基准时不能误判为“用户改了”');
});

/* ────── 拆卸顺序：先 ffmpeg 后 mpv（反序会引发 -10054 级联） ────── */

test('_teardown 先停 pipeline 再停 renderer（真机日志实证的级联防护）', async () => {
  const e = makeEngine();
  const order = [];
  e.pipeline = { stop: async () => { order.push('pipeline'); }, child: null };
  e.renderer = { stop: async () => { order.push('renderer'); }, child: null };
  e.attached = true;
  e.mpvHwnd = 123;

  await e._teardown();
  assert.deepEqual(order, ['pipeline', 'renderer'],
    '先杀 mpv 会让 ffmpeg 的 mpegts 写入收到 RST(-10054) 致命退出并刷屏丢帧告警');
  assert.equal(e.pipeline, null);
  assert.equal(e.renderer, null);
});

/* ────────────────────────── 重启失败的回滚与状态收敛 ────────────────────────── */

/** 造一个可以走完 restart 前半程（停旧、等摄像头）的运行中引擎。 */
function makeRestartEngine({ throwInWait = false } = {}) {
  const e = makeEngine();
  e._waited = false;
  e._waitForCameraReady = async () => {
    e._waited = true;
    if (throwInWait) throw new Error('摄像头释放超时');
  };
  // 旧渲染器：restart 失败时应被清理
  e._rendererStopped = false;
  e.renderer = {
    stop: async () => { e._rendererStopped = true; },
    child: null,
  };
  e.mpvHwnd = 0;
  e.attached = false;
  return e;
}

test('重启在新管线阶段失败 → state=error、上抛、清理残留', async () => {
  const e = makeRestartEngine();
  // device=null 使 try 内 this.device.name 抛错，模拟"新 ffmpeg 起不来"
  e.device = null;

  await assert.rejects(() => e.restart(), /null|undefined/i, '错误必须上抛给调用方（面板据此显示重启失败）');
  assert.equal(e.state, 'error', '失败后必须收敛到 error，不能停在 restarting');
  assert.equal(e.pipeline, null, '残留的新管线必须被清掉');
  assert.equal(e.renderer, null, '旧渲染器应被清理，不留双份');
  assert.ok(e._rendererStopped, '旧 renderer.stop() 应被调用');
});

test('重启等待摄像头释放阶段失败 → 仍收敛到 error（不能卡 restarting）', async () => {
  const e = makeRestartEngine({ throwInWait: true });

  await assert.rejects(() => e.restart(), /摄像头释放超时/);
  assert.equal(e.state, 'error', '停旧/等待阶段失败也必须收敛到 error');
  assert.equal(e.pipeline, null);
  assert.ok(e._waited, '应确实进入了等待摄像头阶段');
});

test('重启会先停掉旧管线再等待摄像头释放', async () => {
  const e = makeRestartEngine();
  e.device = null; // 让它在新管线阶段失败，便于观察前半程
  e._pipelineStopped = false;
  e.pipeline.stop = async () => { e._pipelineStopped = true; };

  await assert.rejects(() => e.restart());
  assert.ok(e._pipelineStopped, '旧 ffmpeg 必须先停（摄像头是排他资源）');
  assert.ok(e._waited, '停旧后应等待设备释放');
});

test('非 running 状态下 restart 委托给 start', async () => {
  const e = makeEngine();
  e.state = 'idle';
  let started = 0;
  e.start = async () => { started += 1; return { state: 'running' }; };

  await e.restart();
  assert.equal(started, 1, '未运行时 restart 应直接 start');
  assert.equal(e.state, 'idle', '本测试 stub 了 start，状态由 stub 决定，仅验证委托发生');
});
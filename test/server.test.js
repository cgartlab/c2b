/**
 * server.test.js — 设置面板「重启会失败」的 HTTP 契约测试
 *
 * 背景（真实链路）：
 *   界面点「重启」→ POST /api/action {action:'restart'}
 *     → server._action → engine.restart()
 *     · 成功 → 200 {ok:true, result}
 *     · 失败 → 500 {ok:false, error, hint}（界面据此显示「重启失败」并写日志）
 *     · 重启进行中重复点击 → 409（防连点并发重启）
 *
 * 用假 engine + port 0 起真实 HTTP 服务，fetch 打接口，
 * 不需要摄像头 / ffmpeg / mpv。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { UiServer } from '../src/server.js';
import { CamToBgError, ErrorCodes } from '../src/errors.js';
import { defaultConfig } from '../src/config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 带网络级重试的 fetch：同进程连续测试会复用临时候选端口，
 * undici 连接池里的陈旧 socket 偶发 RST（单次重试仍有漏网）。
 * 只重试网络层（fetch throw），任何 HTTP 状态/断言错误照常失败。 */
async function xfetch(url, init) {
  const doFetch = () => fetch(url, init);
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await doFetch();
    } catch (err) {
      lastErr = err;
      await sleep(200 * (attempt + 1));
    }
  }
  throw lastErr;
}

/** 造一个行为可控的假 engine。 */
function makeEngine(overrides = {}) {
  return {
    state: 'running',
    status: () => ({ state: 'running', running: true }),
    restart: async () => ({ state: 'running' }),
    start: async () => ({ state: 'running' }),
    stop: async () => ({ stopped: true }),
    encoder: null,
    ...overrides,
  };
}

function makeServer(engine, extra = {}) {
  // 忠实模拟生产契约：onConfigChange 负责持久化（生产实现里 currentConfig = next
  // 然后才返回），getConfig 返回持久化后的内存态。服务端响应以 getConfig() 为准
  // ——这样才能覆盖"响应与实际配置不得两张皮"（如 uiPort 回退）的场景。
  let cfg = defaultConfig();
  return new UiServer({
    engine,
    getConfig: () => cfg,
    onConfigChange: extra.onConfigChange
      || (async (next) => { cfg = next; return { mode: 'none' }; }),
    port: 0,
  });
}

/** POST /api/config（带一次网络级重试：同进程连续测试会复用临时候选端口，
 *  undici 连接池里的陈旧 socket 偶发 RST——重试只针对网络层，断言错误不受影响） */
async function postConfig(ui, body) {
  const url = `http://127.0.0.1:${ui._testPort}/api/config`;
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await xfetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: payload,
      });
      return { status: res.status, data: await res.json() };
    } catch (err) {
      lastErr = err;
      await sleep(150);
    }
  }
  throw lastErr;
}

async function postAction(ui, body) {
  const url = `http://127.0.0.1:${ui._testPort}/api/action`;
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await xfetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      });
      return { status: res.status, data: await res.json() };
    } catch (err) {
      lastErr = err;
      await sleep(150);
    }
  }
  throw lastErr;
}

/**
 * WHATWG/undici "bad ports"（fetch 按规范拒绝访问的端口）。
 * 根因（第41轮实证）：本机动态端口范围 1024–15000 与该列表有交集
 * （1719/1720/1723/1755/2049/3659/4045/4190/5060/5061/6000/6566/6665-6669/
 * 6679/6697/10080 等），`listen(0)` 偶尔分到坏端口 → fetch 抛 `bad port`
 * → 3 次重试全败 → 该测试必失败（每次随机不同测试 = 随机的是端口）。
 * 测试里凡用 fetch 访问的端口都必须避开坏端口。
 */
const BAD_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540,
  548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 1755,
  2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6679, 6697, 10080,
]);
const isBadPort = (p) => BAD_PORTS.has(Number(p));

/**
 * 权威判定端口是否可被 fetch 访问 —— 直接用 undici 自己的坏端口检查。
 * 自维护的 BAD_PORTS 列表可能与 undici 实际实现有出入（第41轮实证：
 * 某端口 undici 判 bad、isBadPort 却放行 → 重试没触发）。
 * 返回 false 仅当 undici 抛 `bad port`；连不上/任何响应都算可用。
 */
async function portUsable(p) {
  try {
    await fetch(`http://127.0.0.1:${p}/api/status`, { signal: AbortSignal.timeout(900) });
    return true; // 拿到响应（哪怕 500）→ 端口可用
  } catch (e) {
    // undici 把 "bad port" 放在 cause.message（顶层 e.message 只是 "fetch failed"，
    // cause.code 常为 undefined）—— 必须遍历 cause 链，否则永远漏判。
    const detail = `${e?.message || ''} ${e?.cause?.message || ''} ${e?.cause?.code || ''}`;
    return !detail.includes('bad port');
  }
}

/** 起服务并记录实际端口；用 undici 权威判定避开坏端口。 */
async function start(ui) {
  for (let tries = 0; tries < 25; tries += 1) {
    const info = await ui.listen();
    if (await portUsable(info.port)) { ui._testPort = info.port; return ui; }
    await ui.close(); // close 置空状态，listen() 可重建（含状态推送定时器）
    // 关键：_listenHttp 会把 this.port 回写成实际端口（坏端口）。
    // 不重置为 0，重试每次都复用同一个坏端口 → "连续25次全坏"的根因。
    ui.port = 0;
  }
  throw new Error('连续 25 次命中坏端口，无法取得可用端口');
}

/** 取一个可被 fetch 访问的空闲端口（供 relisten 等需要指定端口的场景）。 */
async function freeGoodPort() {
  for (let i = 0; i < 25; i += 1) {
    const srv = net.createServer();
    await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
    const p = srv.address().port;
    await new Promise((resolve) => srv.close(resolve));
    if (await portUsable(p)) return p;
  }
  throw new Error('无法取得非坏端口');
}

/* ── restart 失败：面板的核心契约 ── */

test('engine.restart() 抛错 → 500 {ok:false, error, hint}', async () => {
  const err = new CamToBgError('ffmpeg 未能保持运行，管线启动失败', {
    code: ErrorCodes.PIPELINE_FAILED,
    hint: '摄像头可能仍被占用，稍后重试。',
  });
  const ui = await start(makeServer(makeEngine({
    state: 'running',
    restart: async () => { throw err; },
  })));
  try {
    const { status, data } = await postAction(ui, { action: 'restart' });
    assert.equal(status, 500, '重启失败必须以 500 返回');
    assert.equal(data.ok, false);
    assert.match(data.error, /管线启动失败/, 'error 需带上原始错误信息');
    assert.equal(data.hint, '摄像头可能仍被占用，稍后重试。', 'hint 必须透传给界面展示');
  } finally {
    await ui.close();
  }
});

test('普通 Error 抛出时 hint 回退为空串', async () => {
  const ui = await start(makeServer(makeEngine({
    restart: async () => { throw new Error('boom'); },
  })));
  try {
    const { status, data } = await postAction(ui, { action: 'restart' });
    assert.equal(status, 500);
    assert.equal(data.ok, false);
    assert.equal(data.error, 'boom');
    assert.equal(data.hint, '', '非 CamToBgError 时 hint 为 空串而非 undefined');
  } finally {
    await ui.close();
  }
});

test('engine.restart() 成功 → 200 {ok:true, result}', async () => {
  const ui = await start(makeServer(makeEngine({
    restart: async () => ({ state: 'running', uptimeMs: 123 }),
  })));
  try {
    const { status, data } = await postAction(ui, { action: 'restart' });
    assert.equal(status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.result.state, 'running');
  } finally {
    await ui.close();
  }
});

test('重启进行中重复请求 → 409（防连点并发重启）', async () => {
  const ui = await start(makeServer(makeEngine({ state: 'restarting' })));
  try {
    const { status, data } = await postAction(ui, { action: 'restart' });
    assert.equal(status, 409, 'restarting 状态下应拒绝新的重启');
    assert.equal(data.ok, false);
    assert.match(data.error, /正在启动\/重启中/);
  } finally {
    await ui.close();
  }
});

test('启动进行中重复请求同样 → 409', async () => {
  const ui = await start(makeServer(makeEngine({ state: 'starting' })));
  try {
    const { status, data } = await postAction(ui, { action: 'restart' });
    assert.equal(status, 409);
    assert.equal(data.ok, false);
  } finally {
    await ui.close();
  }
});

test('重启进行中收到 start 也 → 409（start 曾是无守卫的并发漏洞）', async () => {
  const ui = await start(makeServer(makeEngine({ state: 'restarting' })));
  try {
    const { status, data } = await postAction(ui, { action: 'start' });
    assert.equal(status, 409, 'start 与 restart 同族，都必须被并发守卫拦截');
    assert.equal(data.ok, false);
    assert.match(data.error, /正在启动\/重启中/);
  } finally {
    await ui.close();
  }
});

test('启动进行中收到 stop 也 → 409（否则在途流程会把停掉的引擎再拉起来）', async () => {
  const ui = await start(makeServer(makeEngine({ state: 'restarting' })));
  try {
    const { status, data } = await postAction(ui, { action: 'stop' });
    assert.equal(status, 409, 'stop 在过渡态必须被拒绝（CLI 信号关停不走此处）');
    assert.equal(data.ok, false);
    assert.match(data.error, /正在启动\/重启中/);
  } finally {
    await ui.close();
  }
});

/* ── 其余 action 与输入校验 ── */

test('start / stop action 正常透传', async () => {
  const ui = await start(makeServer(makeEngine({ state: 'idle' })));
  try {
    const s = await postAction(ui, { action: 'start' });
    assert.equal(s.status, 200);
    assert.equal(s.data.ok, true);

    const t = await postAction(ui, { action: 'stop' });
    assert.equal(t.status, 200);
    assert.equal(t.data.ok, true);
    assert.equal(t.data.result.stopped, true);
  } finally {
    await ui.close();
  }
});

test('未知 action → 400', async () => {
  const ui = await start(makeServer(makeEngine()));
  try {
    const { status, data } = await postAction(ui, { action: 'explode' });
    assert.equal(status, 400);
    assert.equal(data.ok, false);
    assert.match(data.error, /未知操作/);
  } finally {
    await ui.close();
  }
});

test('请求体不是合法 JSON → 400', async () => {
  const ui = await start(makeServer(makeEngine()));
  try {
    const { status, data } = await postAction(ui, '{not json');
    assert.equal(status, 400);
    assert.equal(data.ok, false);
    assert.match(data.error, /JSON/);
  } finally {
    await ui.close();
  }
});

test('engine 为 null 时 /api/status 返回 idle', async () => {
  const ui = await start(makeServer(null));
  try {
    const res = await xfetch(`http://127.0.0.1:${ui._testPort}/api/status`);
    const data = await res.json();
    assert.equal(data.state, 'idle');
  } finally {
    await ui.close();
  }
});

/* ─────────── 路径穿越防护（startsWith 前缀匹配的脆弱性已修正） ─────────── */

test('路径穿越防护：/../ 等在 path.relative 下被正确拦截', async () => {
  const ui = await start(makeServer(makeEngine()));
  try {
    // URL 规范化已处理 ..，但纵深防御：path.relative 判定才可靠
    // 即使绕过 URL 规范化的编码路径，_static 也必须拦截
    const res = await xfetch(`http://127.0.0.1:${ui._testPort}/../../../etc/passwd`);
    // URL 规范化把 /../../etc/passwd → /etc/passwd → 不存在的 UI 文件 → 404（非穿越）
    assert.ok(res.status === 404 || res.status === 403, `不应返回 200，实际 ${res.status}`);
    // 正常文件仍可访问
    const ok = await xfetch(`http://127.0.0.1:${ui._testPort}/style.css`);
    assert.equal(ok.status, 200, '正常资源应可访问');
  } finally {
    await ui.close();
  }
});

test('畸形请求路径不挂起连接（_handleHttp async → sync throw 被 catch → 500）', async () => {
  const ui = await start(makeServer(makeEngine()));
  try {
    // 发送一个无法被 new URL() 解析的请求路径
    // fetch 会规范化 URL，所以用 raw socket 模拟
    const net = await import('node:net');
    const sock = net.connect({ port: ui._testPort, host: '127.0.0.1' });
    await new Promise((r) => sock.on('connect', r));
    // 发送畸形 HTTP 请求（路径含空格 → URL 解析抛错）
    sock.write('GET /bad path HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
    const data = await new Promise((resolve) => {
      let buf = '';
      sock.on('data', (c) => { buf += c.toString(); if (buf.includes('\r\n\r\n')) resolve(buf); });
      setTimeout(() => resolve(buf), 3000);
    });
    sock.destroy();
    // 必须收到 HTTP 响应（而不是连接挂起）
    assert.ok(data.length > 0, '必须返回 HTTP 响应，不能挂起');
    assert.match(data, /HTTP\/1\.\d/, '必须是合法 HTTP 响应');
    // 500 或 400 都可接受——关键是"有响应"
    assert.ok(/500|400/.test(data.split(' ')[1]), `应返回 4xx/5xx，实际: ${data.split(' ')[1]}`);
  } finally {
    await ui.close();
  }
});

/* ─────────── 请求分发异常兜底：绝不允许请求被挂起 ─────────── */

test('_updateConfig 内部抛错 → 分发层兜底 500 JSON（历史：unhandled rejection = 请求永远挂着）', async () => {
  const ui = await start(makeServer(makeEngine(), {
    onConfigChange: async () => { throw new Error('磁盘写入失败'); },
  }));
  try {
    const res = await xfetch(`http://127.0.0.1:${ui._testPort}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(res.status, 500, '必须以 500 结束请求而不是挂起');
    const data = await res.json();
    assert.equal(data.ok, false);
    assert.match(data.error, /磁盘写入失败/);
  } finally {
    await ui.close();
  }
});

test('启动/重启进行中拒收配置写入 → 409，且 onConfigChange 不被调用', async () => {
  for (const state of ['restarting', 'starting']) {
    let called = 0;
    const ui = await start(makeServer(makeEngine({ state }), {
      onConfigChange: async (cfg) => { called += 1; return { mode: 'none', config: cfg }; },
    }));
    try {
      const { status, data } = await postConfig(ui, { bitrate: 16 });
      assert.equal(status, 409, `${state} 态必须拒绝（否则改动被静默吞掉且无 pending 提示）`);
      assert.equal(data.ok, false);
      assert.match(data.error, /正在启动\/重启中/);
      assert.equal(called, 0, '拒绝时绝不能触发配置变更');
    } finally {
      await ui.close();
    }
  }
});

test('正常状态下配置写入仍然可用', async () => {
  const ui = await start(makeServer(makeEngine({ state: 'running' })));
  try {
    const { status, data } = await postConfig(ui, { bitrate: 16 });
    assert.equal(status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.config.bitrate, 16, '合并后的配置应包含新值');
  } finally {
    await ui.close();
  }
});

/* ─────────── uiPort 热切换（relisten） ─────────── */

test('relisten 切到新端口：新端口服务、旧端口关闭', async () => {
  const ui = await start(makeServer(makeEngine()));
  const oldPort = ui._testPort;
  try {
    // 预留一个确定不同于旧端口的**非坏**空闲端口（坏端口 fetch 会拒访）
    const newPort = await freeGoodPort();
    assert.notEqual(newPort, oldPort);

    const info = await ui.relisten(newPort);
    ui._testPort = info.port;
    assert.equal(info.port, newPort, '应切到指定的新端口');

    const onNew = await xfetch(`http://127.0.0.1:${info.port}/api/status`);
    assert.equal(onNew.status, 200, '新端口应正常服务');

    await assert.rejects(
      async () => { await xfetch(`http://127.0.0.1:${oldPort}/api/status`); },
      '旧端口应已关闭',
    );
    assert.equal(ui.port, newPort);
  } finally {
    await ui.close();
  }
});

test('relisten 目标端口被占用 → 抛错且自动回退原端口继续服务', async () => {
  const ui = await start(makeServer(makeEngine()));
  const oldPort = ui._testPort;
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const occupied = blocker.address().port;
  try {
    await assert.rejects(() => ui.relisten(occupied), /不可用/, '应报告端口不可用');
    assert.equal(ui.port, oldPort, '端口配置必须回退');

    const ok = await xfetch(`http://127.0.0.1:${oldPort}/api/status`);
    assert.equal(ok.status, 200, '回退后原端口必须仍在服务（配置值与实际一致的前提）');
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
    await ui.close();
  }
});

test('relisten 相同端口为幂等 no-op', async () => {
  const ui = await start(makeServer(makeEngine()));
  try {
    const info = await ui.relisten(ui._testPort);
    assert.equal(info.port, ui._testPort);
    const ok = await xfetch(`http://127.0.0.1:${info.port}/api/status`);
    assert.equal(ok.status, 200);
  } finally {
    await ui.close();
  }
});

/* ─────────── action=shutdown（Windows 外部信号是硬杀，优雅关停的唯一通道） ─────────── */

test('action=shutdown → 200 且触发 onShutdown 钩子（进程退出由钩子负责）', async () => {
  let called = 0;
  const ui = await start(makeServer(makeEngine({ state: 'running' })));
  ui.onShutdown = async () => { called += 1; };
  try {
    const { status, data } = await postAction(ui, { action: 'shutdown' });
    assert.equal(status, 200, '响应必须先落地');
    assert.equal(data.ok, true);
    assert.equal(data.result?.shutdown, 'graceful');
    await sleep(150); // 钩子经 30ms setTimeout 触发
    assert.equal(called, 1, '钩子应被调用一次');
  } finally {
    ui.onShutdown = null; // 防止 close 流程误触
    await ui.close();
  }
});

test('过渡态 shutdown → 409 且钩子不被触发（否则与在途重启并发）', async () => {
  let called = 0;
  const ui = await start(makeServer(makeEngine({ state: 'restarting' })));
  ui.onShutdown = async () => { called += 1; };
  try {
    const { status } = await postAction(ui, { action: 'shutdown' });
    assert.equal(status, 409);
    await sleep(120);
    assert.equal(called, 0, '409 时绝不能触发关停');
  } finally {
    ui.onShutdown = null;
    await ui.close();
  }
});

/* ─────────── Origin 安全策略：防浏览器级 CSRF 与跨源读取 ─────────── */

test('外源 Origin 的 POST → 403 且配置零变更（历史 ACAO:* 放行是 CSRF）', async () => {
  let called = 0;
  const ui = await start(makeServer(makeEngine({ state: 'running' }), {
    onConfigChange: async (cfg) => { called += 1; return { mode: 'none', config: cfg }; },
  }));
  try {
    const res = await xfetch(`http://127.0.0.1:${ui._testPort}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', Origin: 'https://evil.example.com' },
      body: JSON.stringify({ fps: 99 }),
    });
    assert.equal(res.status, 403, '外源状态变更必须被拒绝');
    assert.equal((await res.json()).ok, false);
    assert.equal(called, 0, 'onConfigChange 绝不能被调用');
    assert.ok(!res.headers.get('access-control-allow-origin'), '不得给外源回 CORS 头');
  } finally {
    await ui.close();
  }
});

test('同源 Origin 的 POST → 200 且 CORS 头精确反射该 Origin（不再是 *）', async () => {
  const ui = await start(makeServer(makeEngine({ state: 'running' })));
  try {
    const selfOrigin = `http://127.0.0.1:${ui._testPort}`;
    const res = await xfetch(`http://127.0.0.1:${ui._testPort}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: selfOrigin },
      body: '{}',
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), selfOrigin, '应精确反射自身 Origin');
    assert.notEqual(res.headers.get('access-control-allow-origin'), '*', '不得再回 *');
  } finally {
    await ui.close();
  }
});

test('无 Origin 的 POST（curl/CLI 工具）→ 正常放行', async () => {
  const ui = await start(makeServer(makeEngine({ state: 'running' })));
  try {
    const res = await xfetch(`http://127.0.0.1:${ui._testPort}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(res.status, 200, '原生客户端无 Origin，不受 CORS 影响');
    assert.ok(!(await res.json()).error);
  } finally {
    await ui.close();
  }
});

test('OPTIONS 预检：外源拿不到 CORS 头（预检失败 → 浏览器拦截后续请求）', async () => {
  const ui = await start(makeServer(makeEngine()));
  try {
    const evil = await xfetch(`http://127.0.0.1:${ui._testPort}/api/config`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example.com', 'Access-Control-Request-Method': 'POST' },
    });
    assert.equal(evil.status, 204);
    assert.ok(!evil.headers.get('access-control-allow-origin'), '外源预检不得获得放行头');

    const self = await xfetch(`http://127.0.0.1:${ui._testPort}/api/config`, {
      method: 'OPTIONS',
      headers: { Origin: `http://127.0.0.1:${ui._testPort}`, 'Access-Control-Request-Method': 'POST' },
    });
    assert.equal(self.status, 204);
    assert.ok(self.headers.get('access-control-allow-origin'), '同源预检应放行');
  } finally {
    await ui.close();
  }
});

test('WebSocket 升级：外源 Origin 被拒（403），同源 101', async () => {
  const net = await import('node:net');
  const ui = await start(makeServer(makeEngine()));
  const wsHandshake = (origin) => new Promise((resolve) => {
    const sock = net.connect({ port: ui._testPort, host: '127.0.0.1' });
    let buf = '';
    sock.on('data', (c) => { buf += c.toString(); });
    sock.on('close', () => resolve(buf));
    sock.on('connect', () => {
      sock.write(
        'GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
        + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n'
        + `Origin: ${origin}\r\n\r\n`,
      );
      setTimeout(() => { try { sock.destroy(); } catch { /* ignore */ } }, 800);
    });
  });
  try {
    const evil = await wsHandshake('https://evil.example.com');
    assert.match(evil, /403 Forbidden/, `外源 WS 必须被拒，实际: ${evil.split('\r\n')[0]}`);
    assert.doesNotMatch(evil, /101 Switching Protocols/);

    const self = await wsHandshake(`http://127.0.0.1:${ui._testPort}`);
    assert.match(self, /101 Switching Protocols/, '同源 WS 应正常升级');
  } finally {
    await ui.close();
  }
});

test('_recordStatus 暴露录制进程 pid（可观测性：外部据此操作录制进程）', async () => {
  const ui = await start(makeServer(makeEngine()));
  ui.recorder = {
    running: true, stopping: false, outputPath: 'C:/x.mp4', startedAt: Date.now(),
    child: { pid: 424242 }, recentLog: () => '',
  };
  try {
    const res = await xfetch(`http://127.0.0.1:${ui._testPort}/api/record/status`);
    const d = await res.json();
    assert.equal(d.recording, true);
    assert.equal(d.pid, 424242, 'pid 必须来自 recorder.child.pid');
    assert.ok(d.uptimeMs >= 0);
  } finally {
    ui.recorder = null;
    await ui.close();
  }
});

test('未录制时 _recordStatus 返回 recording:false 且无 pid', async () => {
  const ui = await start(makeServer(makeEngine()));
  try {
    const res = await xfetch(`http://127.0.0.1:${ui._testPort}/api/record/status`);
    const d = await res.json();
    assert.equal(d.recording, false);
    assert.equal(d.pid, undefined);
  } finally {
    await ui.close();
  }
});

test('录制启动在途守卫：探测窗口 409 拒绝双击，close 等待创建后补停（防孤儿）', async () => {
  const ui = await start(makeServer(makeEngine()));

  // 场景1：record-start 在途（探测中，recorder 尚未赋值）→ 双击开始被 409 拒绝
  ui._recordStartP = sleep(400); // Promise 形状即可（守卫只做 truthy 检查）
  try {
    const r = await xfetch(`http://127.0.0.1:${ui._testPort}/api/record/start`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(r.status, 409, '探测窗口内 recorder=null，只查 recorder 会双开双录');
    assert.match((await r.json()).error, /正在准备录制/);
  } finally {
    ui._recordStartP = null;
    await ui._recordStartP_cleanup?.();
  }

  // 场景2：close 遇到在途探测 → 必须等它创建出 recorder 再补停（否则关停后孤儿）
  let stopCalls = 0;
  ui._recordStartP = (async () => {
    await sleep(150);
    ui.recorder = {
      running: true, stopping: false, outputPath: 'C:/late.mp4', startedAt: 1,
      recentLog: () => '',
      stop: async () => { stopCalls += 1; },
    };
  })();
  try {
    await ui.close();
    assert.equal(stopCalls, 1, 'close 必须等在途探测完成后补停新创建的录制器');
    assert.equal(ui.recorder, null, '补停后释放引用');
  } finally {
    ui._recordStartP = null;
    await ui.close(); // 幂等
  }
});

test('录制收尾期三连：start 409、stop 幂等确认、close 等待收尾（不产生孤儿）', async () => {
  const ui = await start(makeServer(makeEngine()));
  let stopCalls = 0;
  ui.recorder = {
    running: false, stopping: true, outputPath: 'C:/x.mp4', startedAt: 1,
    recentLog: () => '',
    stop: async () => { stopCalls += 1; await sleep(150); },
  };
  try {
    const s1 = await xfetch(`http://127.0.0.1:${ui._testPort}/api/record/start`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(s1.status, 409, '收尾期开始录制必须 409（只查 running 会放行 → 状态错乱）');
    assert.match((await s1.json()).error, /正在停止录制/);

    const s2 = await xfetch(`http://127.0.0.1:${ui._testPort}/api/record/stop`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(s2.status, 200, '重复停止应幂等确认而非报错');
    const d2 = await s2.json();
    assert.equal(d2.ok, true);
    assert.equal(d2.result?.alreadyStopping, true);
    assert.equal(stopCalls, 0, '收尾中的重复 stop 不得再次触发收尾');

    // close 必须等待收尾中的录制器（只看 running 会跳过 → 退出留孤儿 ffmpeg）
    await ui.close();
    assert.equal(stopCalls, 1, 'close 应对收尾中的 recorder 调用 stop 并等待其完成');
    assert.equal(ui.recorder, null, 'close 后应释放 recorder 引用');
  } finally {
    await ui.close(); // 幂等
  }
});

test('坏端口识别（第41轮抖动根因）：动态范围内的 bad port 必须被规避', () => {
  // 本机动态范围 1024–15000 与 bad-ports 列表的交集（抽样）
  for (const p of [1719, 2049, 4045, 5060, 6000, 6566, 6665, 6697, 10080]) {
    assert.ok(isBadPort(p), `${p} 是 fetch 拒绝访问的坏端口，必须在规避列表内`);
  }
  // 常规测试端口不误判
  for (const p of [5757, 12345, 49152, 0, 65535]) {
    assert.ok(!isBadPort(p), `${p} 不应被误判为坏端口`);
  }
  // start() 的规避逻辑：绑定后若命中坏端口会重试（这里验证判定函数本身）
  assert.equal(isBadPort('6000'), true, '字符串端口也应识别');
});

test('录制互斥冲突（外部路径持有锁）→ 409 而非 500（与其它录制冲突语义对齐）', async () => {
  const { resolveExecutable } = await import('../src/proc.js');
  const ff = resolveExecutable('ffmpeg');
  if (!ff) return; // 无 ffmpeg：本用例无意义（静默跳过）
  const { acquireRecordLock, releaseRecordLock } = await import('../src/recorder.js');
  const { ENCODER_CANDIDATES } = await import('../src/encoder-probe.js');

  const ui = await start(makeServer(makeEngine({ state: 'running' })));
  // 服务端跳过编码器探测（复用 engine.encoder），直接走到 Recorder 取锁
  ui.engine.encoder = ENCODER_CANDIDATES.find((e) => e.name === 'libx264');
  const held = acquireRecordLock(); // 默认路径 = 服务端 Recorder 用的同一把锁
  try {
    const r = await xfetch(`http://127.0.0.1:${ui._testPort}/api/record/start`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    // 持锁者是本测试进程（存活）→ Recorder 取锁必失败 → BUSY
    assert.equal(r.status, 409, `跨进程录制冲突应 409，实际 ${r.status}`);
    const d = await r.json();
    assert.equal(d.ok, false);
    assert.match(d.error, /已有录制/, `错误信息应说明冲突，实际: ${d.error}`);
  } finally {
    if (held) releaseRecordLock();
    ui.recorder = null;
    await ui.close();
  }
});

test('遥测兜底：pushStatus/pushLog 在 status() 或广播抛异常时不得冒泡', async () => {
  const boom = { ...makeEngine({ state: 'running' }), status: () => { throw new Error('状态快照炸了'); } };
  const ui = await start(makeServer(boom));
  try {
    // pushStatus 跑在 setInterval 回调里：抛异常 = uncaughtException = 应用关停
    assert.doesNotThrow(() => ui.pushStatus(), 'pushStatus 必须吞掉 status() 异常');
    // 再连推几次（模拟 interval 持续触发）也不得抛
    for (let i = 0; i < 3; i += 1) ui.pushStatus();
    // pushLog 被事件处理器同步调用：同样不得冒泡
    assert.doesNotThrow(() => ui.pushLog('测试日志'), 'pushLog 必须吞掉广播异常');
    // 兜底后服务仍可用 —— 用不依赖 status() 的端点证明服务活着
    //（/api/status 此时会诚实地 500：dispatch 兜底，非挂起、非崩溃）
    const res = await xfetch(`http://127.0.0.1:${ui._testPort}/api/schema`);
    assert.equal(res.status, 200, '遥测失败后服务必须继续响应');
  } finally {
    await ui.close();
  }
});

test('安全响应头：全路由 nosniff + HTML 严格 CSP（无 unsafe-inline）', async () => {
  const ui = await start(makeServer(makeEngine()));
  try {
    const page = await xfetch(`http://127.0.0.1:${ui._testPort}/`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    const csp = page.headers.get('content-security-policy') || '';
    assert.match(csp, /script-src 'self'/, '必须限制脚本只来自同源');
    assert.match(csp, /frame-ancestors 'none'/, '必须禁止被任意页面嵌入');
    assert.match(csp, /http:\/\/127\.0\.0\.1:\*/, 'connect-src 须放行端口切换探测（跨端口即跨源）');
    assert.doesNotMatch(csp, /unsafe-inline/, 'index.html 无内联脚本，不得放宽');

    const api = await xfetch(`http://127.0.0.1:${ui._testPort}/api/status`);
    assert.equal(api.headers.get('x-content-type-options'), 'nosniff', 'API 响应同样带 nosniff');
  } finally {
    await ui.close();
  }
});

test('中文配置体跨 TCP 块边界截断 → 服务端仍完整还原（Buffer 收集统一解码）', async () => {
  const net = await import('node:net');
  const ui = await start(makeServer(makeEngine({ state: 'running' })));
  const sock = net.connect({ port: ui._testPort, host: '127.0.0.1' });
  let resp = '';
  let closed = false;
  sock.on('data', (c) => { resp += c.toString(); });
  sock.on('close', () => { closed = true; });
  sock.on('error', () => { closed = true; });
  try {
    await new Promise((r) => sock.on('connect', r));
    const body = Buffer.from(JSON.stringify({ recFolder: 'C:/视频/录像超长路径测试' }), 'utf8');
    const splitAt = body.indexOf(Buffer.from('视')) + 2; // 拆在"视"（3字节）的第2、3字节之间
    assert.ok(splitAt > 0 && splitAt < body.length);
    const head = Buffer.from(
      // HTTP/1.0：不支持 chunked，响应体按连接关闭定界（否则要手工去 chunk 化）
      'POST /api/config HTTP/1.0\r\nHost: 127.0.0.1\r\n'
      + 'Content-Type: application/json\r\n'
      + `Content-Length: ${body.length}\r\n\r\n`, 'utf8',
    );
    sock.write(Buffer.concat([head, body.subarray(0, splitAt)]));
    await sleep(120); // 确保两段落在不同 TCP 数据事件里
    sock.write(body.subarray(splitAt));
    const end = Date.now() + 4000;
    while (!closed && Date.now() < end) await sleep(50);
    assert.ok(/HTTP\/1\.[01] 200/.test(resp), `未收到 200: ${resp.slice(0, 120)}`);
    const jsonStr = resp.split('\r\n\r\n').slice(1).join('\r\n\r\n');
    const data = JSON.parse(jsonStr);
    assert.equal(data.ok, true, resp.slice(0, 200));
    assert.equal(data.config.recFolder, 'C:/视频/录像超长路径测试',
      `跨块中文必须原样还原，实际: ${data.config.recFolder}`);
  } finally {
    try { sock.destroy(); } catch { /* ignore */ }
    await ui.close();
  }
});

test('恶意 runId → 400（path.join 穿越防线），合法 runId 404 不误伤', async () => {
  const ui = await start(makeServer(makeEngine()));
  try {
    for (const bad of ['not-a-run', '..%2F..%2Fx', '20260922_143005_12345_abcdefg']) {
      const res = await xfetch(`http://127.0.0.1:${ui._testPort}/api/logs/${bad}`);
      assert.equal(res.status, 400, `应 400: ${bad} 实际 ${res.status}`);
      assert.match((await res.json()).error, /非法 runId/);
    }
    const miss = await xfetch(`http://127.0.0.1:${ui._testPort}/api/logs/20260922_143005_12345_ab12`);
    assert.equal(miss.status, 404, '合法格式但不存在 → 404 而非 400');
  } finally {
    await ui.close();
  }
});

test('WS 残帧灌水 >1MB → 连接被断开，且服务继续存活（DoS 防线）', async () => {
  const net = await import('node:net');
  const ui = await start(makeServer(makeEngine({ state: 'running' })));
  const sock = net.connect({ port: ui._testPort, host: '127.0.0.1' });
  let closed = false;
  sock.on('close', () => { closed = true; });
  sock.on('error', () => { closed = true; });
  try {
    await new Promise((r) => sock.on('connect', r));
    sock.write(
      'GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
      + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n'
      + 'Origin: http://127.0.0.1:1\r\n\r\n',
    );
    await sleep(300); // 等 101 升级完成
    // 构造"永不完成的残帧"：掩码文本帧，8 字节扩展长度声明 1000 万字节，
    // 但只送来 1MB+ → decodeFrames 恒 break、残帧只进不出 → 应触发上限断开
    const header = Buffer.from([
      0x81, 0xFF,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x98, 0x96, 0x80, // 10_000_000 (BE)
      0x00, 0x00, 0x00, 0x00,                           // mask key
    ]);
    const water = Buffer.alloc(1024 * 1024 + 64 * 1024, 0x61);
    sock.write(Buffer.concat([header, water]));
    const end = Date.now() + 3000;
    while (!closed && Date.now() < end) await sleep(100);
    assert.ok(closed, '残帧缓冲超上限后服务端必须断开该连接');
    // 服务本体必须存活
    const st = await xfetch(`http://127.0.0.1:${ui._testPort}/api/status`);
    assert.equal(st.status, 200, '服务必须继续服务（不能被灌水拖垮）');
  } finally {
    try { sock.destroy(); } catch { /* ignore */ }
    await ui.close();
  }
});

/**
 * server.js — 设置界面的本地 HTTP + WebSocket 服务
 *
 * 只用 Node 内置模块，无需任何第三方依赖（本机没有 VS Build Tools，
 * 不能编译原生插件，因此刻意保持零依赖）。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { schemaForUi, mergeConfig, saveConfig } from './config.js';
import { clampRegion } from './recorder.js';
import { ErrorCodes } from './errors.js';
import { listRuns, readRun, readRunLog, parseRunLog, runDir, logsDir, isValidRunId } from './runs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.join(__dirname, 'ui');

/* ────────────────────────── WebSocket（RFC6455 最小实现） ────────────────────────── */

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/**
 * 允许的跨源来源：仅本机回环（同源 UI、本机其他端口的开发页）。
 * 无 Origin 头 = 非浏览器客户端（curl/CLI/原生 App 导航），不适用 CORS 策略。
 *
 * 历史缺陷：ACAO `*` + OPTIONS 全放行 → 任意恶意网页都可跨源 POST /api/config
 * 修改用户配置（浏览器级 CSRF：`Content-Type: text/plain` 的简单请求连预检都不触发），
 * 还可读取 /api/status 等响应（设备名/路径信息泄露）。同源与 CLI 本来就不需要 `*`。
 */
const ALLOWED_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/i;

function originAllowed(origin) {
  return !origin || ALLOWED_ORIGIN.test(origin);
}

/** 把服务器 → 客户端的数据编码为 WebSocket 文本帧。 */
function encodeTextFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;

  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81; // FIN + text
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

/** 解析客户端发来的帧（仅支持文本帧与关闭帧，够用即可）。 */
function decodeFrames(buffer) {
  const messages = [];
  let offset = 0;

  while (offset + 2 <= buffer.length) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let len = second & 0x7f;
    let cursor = offset + 2;

    if (len === 126) {
      if (cursor + 2 > buffer.length) break;
      len = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (len === 127) {
      if (cursor + 8 > buffer.length) break;
      len = Number(buffer.readBigUInt64BE(cursor));
      cursor += 8;
    }

    let maskKey = null;
    if (masked) {
      if (cursor + 4 > buffer.length) break;
      maskKey = buffer.subarray(cursor, cursor + 4);
      cursor += 4;
    }

    if (cursor + len > buffer.length) break;

    const payload = Buffer.from(buffer.subarray(cursor, cursor + len));
    if (maskKey) {
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= maskKey[i % 4];
    }

    messages.push({ opcode, payload: payload.toString('utf8') });
    offset = cursor + len;
  }

  return { messages, rest: buffer.subarray(offset) };
}

/* ────────────────────────────── 服务器 ────────────────────────────── */

export class UiServer {
  /**
   * @param {object} opts
   * @param {import('./wallpaper.js').WallpaperEngine} opts.engine
   * @param {() => object} opts.getConfig
   * @param {(cfg:object) => Promise<object>} opts.onConfigChange
   * @param {number} opts.port
   * @param {object} [opts.run] 当前运行会话（runs.js 的 startRun 返回值）
   */
  constructor({ engine, getConfig, onConfigChange, port, run = null }) {
    this.engine = engine;
    this.getConfig = getConfig;
    this.onConfigChange = onConfigChange;
    this.port = port;
    this.run = run;

    this.server = null;
    this.sockets = new Set();
    this.logBuffer = [];
    this._maxLog = 300;

    /** 录制器实例（独立于壁纸管线）。 */
    this.recorder = null;
    /** record-start 在途 promise（探测窗口守卫 + close 等待用）。 */
    this._recordStartP = null;

    /**
     * 优雅关停钩子（由 createApp 注入）：action=shutdown 时调用。
     * 职责包含"最终终止本进程"——服务器层只负责触发与响应，不自行 exit，
     * 以便单元测试注入假钩子而不被杀。
     * @type {null | (() => Promise<void> | void)}
     */
    this.onShutdown = null;
  }

  /** 记录一条日志并广播给所有界面。 */
  pushLog(message) {
    // 遥测兜底：本函数被引擎/录制的事件处理器同步调用，抛异常会一路冒泡成
    // uncaughtException → 应用关停。日志推送失败只丢这一条，绝不能打挂核心。
    try {
      const entry = { t: Date.now(), message: String(message) };
      this.logBuffer.push(entry);
      if (this.logBuffer.length > this._maxLog) this.logBuffer.shift();
      this.broadcast({ type: 'log', entry });
    } catch { /* 这一条日志丢弃，下一条照常 */ }
  }

  broadcast(obj) {
    const frame = encodeTextFrame(JSON.stringify(obj));
    for (const sock of this.sockets) {
      try { sock.write(frame); } catch { /* 连接可能已断 */ }
    }
  }

  /** 把状态推给界面。 */
  pushStatus() {
    // ⚠️ 遥测兜底：本函数跑在 setInterval(1500ms) 回调里，一旦 engine.status()
    //（含 buildFilterChain 快照）抛异常 → interval 回调抛出 → uncaughtException
    // → CLI 的兜底处理会 app.stop() + process.exit(1) —— 每 1.5s 一次的诊断
    // 推送不应具备关停整个壁纸服务的能力。状态快照失败只跳过这一帧。
    try {
      if (!this.engine) return;
      this.broadcast({ type: 'status', status: this.engine.status() });
    } catch { /* 这一帧跳过，下一轮（1.5s 后）再试 */ }
  }

  async listen() {
    // 定时推送状态，界面上的帧率/占用等指标可实时刷新（relisten 不重复创建）
    if (!this._statusTimer) {
      this._statusTimer = setInterval(() => this.pushStatus(), 1500);
    }
    return this._listenHttp();
  }

  /**
   * 创建 HTTP 服务并监听 this.port。
   *
   * 分发层必须兜底：_handleHttp 的处理器都是 async 的，任何未捕获的异常
   * 若放任变成 unhandled rejection，HTTP 响应将永远不会发出，
   * 浏览器端 fetch 一直挂起（界面表现为"保存中…"卡死）——商用级不可接受。
   * 这里统一 catch 并以 500 JSON 回复。
   */
  _listenHttp() {
    this.server = http.createServer((req, res) => {
      Promise.resolve(this._handleHttp(req, res)).catch((err) => {
        try {
          this._json(res, { ok: false, error: err?.message || String(err) }, 500);
        } catch { /* 响应可能已发出，忽略 */ }
      });
    });
    this.server.on('upgrade', (req, socket) => this._handleUpgrade(req, socket));

    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, '127.0.0.1', () => {
        this.server.removeListener('error', reject);
        // 后续运行期错误（如 socket 级）不应打崩进程
        this.server.on('error', (err) => { try { console.error('[c2b] http error:', err.message); } catch { /* 忽略 */ } });
        const actual = this.server.address().port;
        // 回写实际端口：this.port 初始可能是 0（系统分配），
        // 不回写会导致 relisten 的"同端口 no-op"与失败回退比较全错（实测缺陷）。
        this.port = actual;
        resolve({ port: actual, url: `http://127.0.0.1:${actual}/` });
      });
    });
  }

  /**
   * 切换监听端口（配置改 uiPort 时调用），**不打断**状态定时器与进行中的录制。
   *
   * 失败语义：新端口不可用 → 关闭新尝试、回退并重新监听原端口 → 抛错，
   * 调用方据此回退配置值并向用户提示，服务始终保有一个可用端口。
   *
   * @param {number} port 新端口（0 = 系统分配）
   */
  async relisten(port) {
    const target = Number(port);
    if (!Number.isInteger(target) || target < 0 || target > 65535) {
      throw new Error(`非法端口: ${port}`);
    }
    // 以**实际监听端口**为准做 no-op 判定（this.port 已在 _listenHttp 回写）
    if (this.server?.listening && target !== 0 && target === this.port) {
      const a = this.server.address();
      return { port: a.port, url: `http://127.0.0.1:${a.port}/` };
    }

    const oldPort = this.port;

    // 先关旧监听（保留 recorder 与 _statusTimer——close() 会停录制，不能用）
    if (this.server) {
      for (const sock of this.sockets) { try { sock.destroy(); } catch { /* 忽略 */ } }
      this.sockets.clear();
      const srv = this.server;
      this.server = null;
      await new Promise((resolve) => srv.close(resolve));
    }

    this.port = target;
    try {
      const info = await this._listenHttp();
      return info;
    } catch (err) {
      // 清掉绑定失败的实例（未在监听，close 会抛，忽略即可）
      try { this.server?.close(); } catch { /* 忽略 */ }
      this.server = null;
      this.port = oldPort;
      try { await this._listenHttp(); } catch { /* 原端口也失败：极端情况，由上层报错 */ }
      throw new Error(`端口 ${target} 不可用（${err?.message || err}），已回退到端口 ${oldPort}`);
    }
  }

  async close() {
    // 必须置 null 而非只 clearInterval：留下陈旧真值会让后续 listen() 的
    // `if (!this._statusTimer)` 判断为"已存在"而静默跳过重建 —— close→listen
    // 复用（含测试端口重试）后状态推送定时器永久丢失。
    if (this._statusTimer) { clearInterval(this._statusTimer); this._statusTimer = null; }

    // 关键：必须先停掉正在进行的录制。
    // 录制是一条独立的 ffmpeg 进程；若主进程直接退出而不停它，
    // 它会变成孤儿继续写文件，且 MP4 的尾部（moov）永远不会被写入，
    // 录出来的文件无法播放。
    // 1) 先等在途的 record-start：探测窗口里 recorder 尚未创建，
    //    不等会在其返回后才赋值 → 关停流程已跳过 → 孤儿录制进程。
    if (this._recordStartP) {
      try { await this._recordStartP; } catch { /* 启动失败：无需停 */ }
    }
    // 2) 不能只看 running：停止**在途**时 running=false 但进程还活着——
    //    只查 running 会让 close 跳过等待，进程退出把收尾中的 ffmpeg 变成孤儿。
    if (this.recorder) {
      try {
        const busy = this.recorder.running || this.recorder.stopping;
        if (busy) this.pushLog('正在停止录制…');
        await this.recorder.stop(); // 幂等：共享在途收尾；已停止则立即返回
        if (busy) this.pushLog(`录制已保存: ${this.recorder.outputPath}`);
      } catch { /* 尽力而为 */ }
    }
    this.recorder = null;

    for (const sock of this.sockets) {
      try { sock.destroy(); } catch { /* 忽略 */ }
    }
    this.sockets.clear();
    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve));
      this.server = null;
    }
  }

  /* ── HTTP ── */

  async _handleHttp(req, res) {
    let url;
    try {
      url = new URL(req.url, `http://127.0.0.1:${this.port}`);
    } catch (err) {
      // 畸形请求（非法字符/null 字节等）→ new URL 同步抛错；
      // _handleHttp 为 async → throw 变 Promise rejection → 被 _listenHttp 的 .catch() 兜底
      throw new Error(`非法请求路径: ${req.url}`);
    }

    // ── Origin 安全策略（两层，见 ALLOWED_ORIGIN 注释） ──
    //   层1（预检）：仅对允许的 Origin 反射 CORS 头；外源预检拿不到头 → 浏览器拦截
    //   层2（直发）：text/plain 等简单 POST 不经预检即可直达 → 状态变更请求(POST)
    //        对外源 Origin 直接 403，杜绝浏览器级 CSRF
    // nosniff 全路由：防 MIME 嗅探（CSP 随 HTML 下发，见 _static）
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const origin = req.headers.origin;
    const allowed = originAllowed(origin);
    if (origin && allowed) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    }
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (req.method !== 'GET' && origin && !allowed) {
      return this._json(res, { ok: false, error: '拒绝跨源请求' }, 403);
    }

    if (url.pathname === '/api/schema') return this._json(res, { schema: schemaForUi(), config: this.getConfig() });
    if (url.pathname === '/api/status') return this._json(res, this.engine ? this.engine.status() : { state: 'idle' });
    if (url.pathname === '/api/devices') return this._devices(res);
    if (url.pathname === '/api/config' && req.method === 'POST') return this._updateConfig(req, res);
    if (url.pathname === '/api/action' && req.method === 'POST') return this._action(req, res);
    if (url.pathname === '/api/log') return this._json(res, { entries: this.logBuffer.slice(-100) });
    if (url.pathname === '/api/record/start' && req.method === 'POST') return this._recordStart(req, res);
    if (url.pathname === '/api/record/stop' && req.method === 'POST') return this._recordStop(res);
    if (url.pathname === '/api/record/status') return this._recordStatus(res);
    if (url.pathname === '/api/audio-devices') return this._audioDevices(res);
    if (url.pathname === '/api/logs' || url.pathname === '/api/logs/') return this._listLogs(res);
    if (url.pathname.startsWith('/api/logs/')) return this._getRunLog(url.pathname.slice('/api/logs/'.length), res);

    return this._static(url.pathname, res);
  }

  _json(res, data, code = 200) {
    const body = JSON.stringify(data);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
  }

  async _devices(res) {
    try {
      const { listVideoDevices, disambiguateDevices } = await import('./devices.js');
      const { resolveExecutable } = await import('./proc.js');
      const ff = resolveExecutable('ffmpeg');
      const devices = ff ? await listVideoDevices(ff) : [];
      // 返回 {value,label}：value 是 dshow 打开标识（重名设备=备用名），
      // label 是可读名（重名加序号）——两个同型号摄像头从此选得中第二个
      const entries = disambiguateDevices(devices).map((d) => ({ value: d.value, label: d.label }));
      return this._json(res, { devices: entries });
    } catch (err) {
      return this._json(res, { devices: [], error: err.message });
    }
  }

  _readBody(req) {
    return new Promise((resolve) => {
      // 收集 Buffer 再统一解码：`data += chunk` 会把 UTF-8 多字节字符
      //（中文设备名/路径）在 TCP 块边界截断成 U+FFFD 乱码
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > 1e6) { req.destroy(); resolve(''); return; }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', () => resolve(''));
    });
  }

  async _updateConfig(req, res) {
    const raw = await this._readBody(req);
    let patch;
    try {
      patch = JSON.parse(raw || '{}');
    } catch {
      return this._json(res, { ok: false, error: '请求体不是合法 JSON' }, 400);
    }

    // 过渡态拒收配置：启动/重启进行中 applyConfig 会走"仅保存"分支，
    // 结果是改动被静默吞掉且没有 pending-restart 提示（半应用混乱）。
    // 与 /api/action 的 409 守卫同族：稍后再改，一次说清。
    if (this.engine && (this.engine.state === 'restarting' || this.engine.state === 'starting')) {
      return this._json(res, { ok: false, error: '正在启动/重启中，请稍候再改设置' }, 409);
    }

    const { config: merged, warnings } = mergeConfig(this.getConfig(), patch);
    const result = await this.onConfigChange(merged);
    // 响应必须反映 onConfigChange **之后的最终生效配置**（可能被回退，
    // 如 uiPort 预检失败时服务端会改回旧端口并落盘）。
    // 若直接回传 mergeConfig 的中间产物，客户端看到的值与磁盘/内存两张皮
    //（第 27 轮真机演练实证的缺陷，属第 8 轮"回填"问题的服务端同族）。
    return this._json(res, { ok: true, config: this.getConfig(), warnings, result });
  }

  async _action(req, res) {
    const raw = await this._readBody(req);
    let body;
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      return this._json(res, { ok: false, error: '请求体不是合法 JSON' }, 400);
    }

    try {
      // 防连点：启动/重启流程进行中再发 start/restart/stop/shutdown 都会与在途
      // 流程并发抢摄像头或产生"停了又被在途流程拉起来"的僵尸状态，统一 409 拒绝
      //（调用方轮询重试；外部 cam-to-bg stop 对 409 会等待过渡结束后重发 shutdown）。
      if (['restart', 'start', 'stop', 'shutdown'].includes(body.action)) {
        if (this.engine && (this.engine.state === 'restarting' || this.engine.state === 'starting')) {
          return this._json(res, { ok: false, error: '正在启动/重启中，请稍候' }, 409);
        }
      }
      if (body.action === 'shutdown') {
        // Windows 跨进程 kill('SIGTERM') 是无条件 TerminateProcess（处理器不执行），
        // 进程内优雅关停必须由本进程自己完成 → 经钩子走 doStop 再退出。
        // 先落响应，再触发钩子（服务器层不自行 exit，便于单测注入假钩子）。
        this._json(res, { ok: true, result: { shutdown: 'graceful' } });
        setTimeout(() => {
          Promise.resolve(this.onShutdown?.()).catch(() => { /* 钩子自带看门狗兜底 */ });
        }, 30);
        return;
      }
      if (body.action === 'restart') {
        const r = await this.engine.restart();
        return this._json(res, { ok: true, result: r });
      }
      if (body.action === 'start') {
        return this._json(res, { ok: true, result: await this.engine.start() });
      }
      if (body.action === 'stop') {
        return this._json(res, { ok: true, result: await this.engine.stop() });
      }
      return this._json(res, { ok: false, error: `未知操作: ${body.action}` }, 400);
    } catch (err) {
      return this._json(res, { ok: false, error: err.message, hint: err.hint || '' }, 500);
    }
  }

  _static(pathname, res) {
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const filePath = path.join(UI_DIR, rel);

    // 防目录穿越：用 path.relative 正确判定是否在 UI_DIR 之内。
    // startsWith(UI_DIR) 的前缀匹配不带分隔符是脆弱的
    //（"ui-backdoor" 字符串前缀匹配 "ui"），path.relative 才是正解。
    const relFromUi = path.relative(UI_DIR, filePath);
    if (relFromUi.startsWith('..') || path.isAbsolute(relFromUi)) {
      res.writeHead(403); res.end('Forbidden'); return;
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('未找到该资源');
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      const mime = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
      }[ext] || 'application/octet-stream';

      const headers = { 'Content-Type': mime, 'Cache-Control': 'no-store' };
      if (ext === '.html') {
        // 严格 CSP（纵深防御，XSS 残余风险兜底）：index.html 只有外部
        // <script src>、无内联脚本/样式 → 无需 unsafe-inline。
        // connect-src 显式放开回环任意端口：followPortSwitch 要探测端口热切换后
        // 的新地址（跨端口即跨源）。frame-ancestors 防点击劫持嵌入。
        headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";
      }
      res.writeHead(200, headers);
      res.end(data);
    });
  }

  /* ── 录制 ── */

  async _recordStart(req, res) {
    // 在途守卫：探测窗口（selectEncoder 数秒）内 recorder 尚未赋值——
    // 只查 recorder 时双击开始会双双过守卫 → 两个录制器并发录屏；
    // 且 close() 因 recorder=null 漏停随后创建的录制器 → 关停后孤儿。
    if (this._recordStartP) {
      return this._json(res, { ok: false, error: '正在准备录制，请稍候' }, 409);
    }
    // 停止在途时 running=false（child 已摘除）——只查 running 会放行第二次开始，
    // 新录制器覆盖引用后，旧收尾完成时的 record-stopped 广播会让 UI 在
    // 新录制进行中翻回"已停止"（状态错乱）。收尾期一律 409 拒绝。
    if (this.recorder?.stopping) {
      return this._json(res, { ok: false, error: '正在停止录制，请稍候再开始' }, 409);
    }
    if (this.recorder?.running) {
      return this._json(res, { ok: false, error: '已在录制中' }, 400);
    }

    this._recordStartP = this._recordStartCore(req);
    try {
      const data = await this._recordStartP;
      return this._json(res, { ok: true, ...data });
    } catch (err) {
      // 跨进程录制互斥冲突（另一路径的录制持有锁）→ 409 Conflict，
      // 与"收尾期 409 / 进行中 400"等其它录制冲突语义保持一致（历史恒 500）。
      const status = err?.code === ErrorCodes.BUSY ? 409 : 500;
      return this._json(res, { ok: false, error: err.message, hint: err.hint || '' }, status);
    } finally {
      this._recordStartP = null;
    }
  }

  /** 录制启动核心（由 _recordStart 以 _recordStartP 在途标记包裹）。 */
  async _recordStartCore(req) {
    const raw = await this._readBody(req);
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch { /* 用默认配置 */ }

    const cfg = this.getConfig();
    const { Recorder, defaultOutputPath, resolveVideosDir } = await import('./recorder.js');
    const { resolveExecutable } = await import('./proc.js');
    const { selectEncoder, probeCacheFile } = await import('./encoder-probe.js');
    const ff = resolveExecutable('ffmpeg');

    if (!ff) {
      throw new Error('未找到 ffmpeg，无法录制');
    }

    // 录制区域必须钳制到主屏内：gdigrab 的 offset+size 越界会直接报错，
    // 录制在 600ms 探活后崩掉。屏幕尺寸按优先级取：
    //   引擎已知的主屏 → 引擎输出分辨率 → 现场 probeDesktop() → 不钳（由 ffmpeg 报错兜底）
    // ⚠️ 必须在编码器探测**之前**算好：探测要按录制真实工况（区域/屏幕分辨率）
    // 而非 testEncoder 默认 640x480——否则"640x480 探测通过、实际分辨率录制失败"。
    let screen = null;
    try {
      const mon = this.engine?.desktop?.monitors?.find((m) => m.primary)
        || this.engine?.desktop?.monitors?.[0];
      if (mon) {
        screen = { width: mon.width, height: mon.height };
      } else {
        const out = this.engine?.status?.()?.output;
        if (out) screen = { width: out.width, height: out.height };
        else {
          const { probeDesktop } = await import('./win32.js');
          const d = await probeDesktop();
          const m = d.monitors.find((x) => x.primary) || d.monitors[0];
          if (m) screen = { width: m.width, height: m.height };
        }
      }
    } catch { screen = null; }

    const region = clampRegion(body.region || null, screen);
    if (body.region && region) {
      const r = body.region;
      if (region.x !== Math.round(Number(r.x) || 0) || region.y !== Math.round(Number(r.y) || 0)
        || region.w !== Math.round(Number(r.w) || 0) || region.h !== Math.round(Number(r.h) || 0)) {
        this.pushLog(`录制区域已钳制到主屏范围内: ${region.w}x${region.h} @(${region.x},${region.y})`);
      }
    }

    // 录制真实工况：gdigrab 采集尺寸 = 区域（或整屏），码率用 recBitrate（非壁纸 bitrate）
    const recW = region ? region.w : (screen?.width ?? null);
    const recH = region ? region.h : (screen?.height ?? null);

    // 用壁纸管线已探测的编码器，或按**录制真实工况**重新探测
    let encoder = this.engine?.encoder;
    if (!encoder) {
      const r = await selectEncoder(ff, {
        prefer: cfg.encoder !== 'auto' ? cfg.encoder : undefined,
        ...(recW && recH ? { width: recW, height: recH } : {}),
        bitrate: cfg.recBitrate || 10,
        cacheFile: probeCacheFile('record'),
      });
      encoder = r.encoder;
    }

    // 输出目录：显式路径确保父目录存在；默认用 Known Folder 的真实
      // 「视频」位置（OneDrive 重定向机器上 homedir/Videos 是错的，
      // 历史缺陷：录制 600ms 后因 Permission denied 崩掉）。
      let outputPath = body.outputPath;
      if (outputPath) {
        try { fs.mkdirSync(path.dirname(outputPath), { recursive: true }); } catch { /* 由 ffmpeg 报错兜底 */ }
      } else {
        outputPath = defaultOutputPath(cfg.recFolder || (await resolveVideosDir()));
      }

      this.recorder = new Recorder({
        ffmpegPath: ff,
        encoder,
        outputPath,
        audioDevice: cfg.recAudioDevice || body.audioDevice || null,
        // 只录屏幕的一块区域（不传则录整个屏幕）
        region,
        fps: cfg.recFps || 30,
        bitrate: cfg.recBitrate || 10,
        quality: cfg.recQuality || 20,
        maxDuration: body.maxDuration || null,
        runDir: this.run?.dir || null,
      });

      this.recorder.on('log', (m) => this.pushLog(m));
      this.recorder.on('exit', (info) => {
        this.pushLog(`录制异常退出 code=${info.code}`);
        this.broadcast({ type: 'record-stopped', reason: 'exit', code: info.code });
      });
      this.recorder.on('finished', (info) => {
        this.pushLog(`录制完成: ${info.outputPath}`);
        this.broadcast({ type: 'record-stopped', reason: 'finished', outputPath: info.outputPath });
      });

      const result = await this.recorder.start();
      this.broadcast({ type: 'record-started', ...result });
      return result;
  }

  async _recordStop(res) {
    // 幂等：停止已在收尾（stop() 共享同一 promise），重复请求直接确认，
    // 不重复 await/广播（否则双击停止会推两条 record-stopped 刷 UI）
    if (this.recorder?.stopping) {
      return this._json(res, { ok: true, result: { alreadyStopping: true } });
    }
    if (!this.recorder?.running) {
      return this._json(res, { ok: false, error: '未在录制中' }, 400);
    }
    try {
      const outputPath = this.recorder.outputPath;
      await this.recorder.stop();
      this._json(res, { ok: true, outputPath });
      this.broadcast({ type: 'record-stopped', reason: 'manual', outputPath });
    } catch (err) {
      this._json(res, { ok: false, error: err.message }, 500);
    }
  }

  _recordStatus(res) {
    if (!this.recorder) return this._json(res, { recording: false });
    return this._json(res, {
      recording: this.recorder.running,
      pid: this.recorder.child?.pid || null,
      outputPath: this.recorder.outputPath,
      startedAt: this.recorder.startedAt,
      uptimeMs: this.recorder.startedAt ? Date.now() - this.recorder.startedAt : 0,
      logTail: this.recorder.recentLog(800),
    });
  }

  async _audioDevices(res) {
    try {
      const { resolveExecutable } = await import('./proc.js');
      const { listAudioDevices } = await import('./recorder.js');
      const ff = resolveExecutable('ffmpeg');
      const devices = ff ? await listAudioDevices(ff) : [];
      // 与 /api/devices 同构：{value,label}（value=dshow 打开标识）
      return this._json(res, { devices: devices.map((d) => ({ value: d.value, label: d.label })) });
    } catch (err) {
      return this._json(res, { devices: [], error: err.message });
    }
  }

  /** 列出所有运行（含最近一次的错误摘要）。 */
  _listLogs(res) {
    try {
      const runs = listRuns().map((r) => ({
        runId: r.runId,
        startedAt: r.startedAt,
        endedAt: r.endedAt,
        exitCode: r.exitCode,
        errorSummary: r.errorSummary,
        // 强制收尾原因：界面日志列表也应可见（与 CLI 一致）
        stopNote: r.stopNote,
        pid: r.pid,
      }));
      return this._json(res, { ok: true, runs, logsDir: logsDir() });
    } catch (err) {
      return this._json(res, { ok: false, error: err.message }, 500);
    }
  }

  /** 读取某次运行的 manifest 与日志。 */
  _getRunLog(runId, res) {
    // 严格校验：runId 直接进 path.join，非法值（含 ../ 组合）→ 400
    if (!isValidRunId(runId)) {
      return this._json(res, { ok: false, error: '非法 runId（应为 时间_pid_随机4位）' }, 400);
    }
    try {
      const manifest = readRun(runId);
      if (!manifest) return this._json(res, { ok: false, error: `未找到运行: ${runId}` }, 404);
      const raw = readRunLog(runId);
      return this._json(res, {
        ok: true,
        runId,
        manifest,
        entries: parseRunLog(raw),
        dir: runDir(runId),
      });
    } catch (err) {
      return this._json(res, { ok: false, error: err.message }, 500);
    }
  }

  /* ── WebSocket 握手 ── */

  _handleUpgrade(req, socket) {
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }

    // Origin 校验：拒绝非本机回环来源的 WebSocket 升级（防恶意网页订阅状态流）
    const origin = req.headers.origin;
    if (!originAllowed(origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const accept = crypto
      .createHash('sha1')
      .update(key + WS_GUID)
      .digest('base64');

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Connection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );

    socket.setNoDelay(true);
    this.sockets.add(socket);

    // 连上就先给一份完整状态
    if (this.engine) {
      socket.write(encodeTextFrame(JSON.stringify({ type: 'status', status: this.engine.status() })));
    }

    let pending = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      const { messages, rest } = decodeFrames(pending);
      pending = rest;
      // 残帧缓冲上限：客户端（UI）实际只发 <1KB 的 ping JSON，且服务端从不主动
      // 读大帧——不设限 = 任意本机页面连上 WS 后用"永不完成的大帧"缓慢灌数据，
      // 残帧只进不出把堆撑到 OOM，整个壁纸进程被击杀（第 28 轮实证的 DoS 面）
      if (pending.length > 1024 * 1024) { socket.destroy(); return; }
      for (const m of messages) {
        if (m.opcode === 0x8) { socket.destroy(); return; }
        if (m.opcode === 0x1) {
          try {
            const msg = JSON.parse(m.payload);
            if (msg.type === 'ping') socket.write(encodeTextFrame(JSON.stringify({ type: 'pong' })));
          } catch { /* 忽略非 JSON */ }
        }
      }
    });

    const drop = () => this.sockets.delete(socket);
    socket.on('close', drop);
    socket.on('error', drop);
  }
}
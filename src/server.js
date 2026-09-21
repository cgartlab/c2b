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
import { listRuns, readRun, readRunLog, parseRunLog, runDir, logsDir } from './runs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.join(__dirname, 'ui');

/* ────────────────────────── WebSocket（RFC6455 最小实现） ────────────────────────── */

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

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
  }

  /** 记录一条日志并广播给所有界面。 */
  pushLog(message) {
    const entry = { t: Date.now(), message: String(message) };
    this.logBuffer.push(entry);
    if (this.logBuffer.length > this._maxLog) this.logBuffer.shift();
    this.broadcast({ type: 'log', entry });
  }

  broadcast(obj) {
    const frame = encodeTextFrame(JSON.stringify(obj));
    for (const sock of this.sockets) {
      try { sock.write(frame); } catch { /* 连接可能已断 */ }
    }
  }

  /** 把状态推给界面。 */
  pushStatus() {
    if (!this.engine) return;
    this.broadcast({ type: 'status', status: this.engine.status() });
  }

  async listen() {
    this.server = http.createServer((req, res) => this._handleHttp(req, res));
    this.server.on('upgrade', (req, socket) => this._handleUpgrade(req, socket));

    // 定时推送状态，界面上的帧率/占用等指标可实时刷新
    this._statusTimer = setInterval(() => this.pushStatus(), 1500);

    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, '127.0.0.1', resolve);
    });

    const actual = this.server.address().port;
    return { port: actual, url: `http://127.0.0.1:${actual}/` };
  }

  async close() {
    if (this._statusTimer) clearInterval(this._statusTimer);

    // 关键：必须先停掉正在进行的录制。
    // 录制是一条独立的 ffmpeg 进程；若主进程直接退出而不停它，
    // 它会变成孤儿继续写文件，且 MP4 的尾部（moov）永远不会被写入，
    // 录出来的文件无法播放。
    if (this.recorder?.running) {
      try {
        this.pushLog('正在停止录制…');
        await this.recorder.stop();
        this.pushLog(`录制已保存: ${this.recorder.outputPath}`);
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

  _handleHttp(req, res) {
    const url = new URL(req.url, `http://127.0.0.1:${this.port}`);

    // CORS：方便用浏览器/WebView2 打开
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

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
      const { listVideoDevices } = await import('./devices.js');
      const { resolveExecutable } = await import('./proc.js');
      const ff = resolveExecutable('ffmpeg');
      const devices = ff ? await listVideoDevices(ff) : [];
      return this._json(res, { devices: devices.map((d) => d.name) });
    } catch (err) {
      return this._json(res, { devices: [], error: err.message });
    }
  }

  _readBody(req) {
    return new Promise((resolve) => {
      let data = '';
      req.on('data', (c) => {
        data += c;
        if (data.length > 1e6) { req.destroy(); resolve(''); }
      });
      req.on('end', () => resolve(data));
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

    const { config, warnings } = mergeConfig(this.getConfig(), patch);
    const result = await this.onConfigChange(config);
    return this._json(res, { ok: true, config, warnings, result });
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

    // 防目录穿越
    if (!filePath.startsWith(UI_DIR)) {
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

      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
      res.end(data);
    });
  }

  /* ── 录制 ── */

  async _recordStart(req, res) {
    if (this.recorder?.running) {
      return this._json(res, { ok: false, error: '已在录制中' }, 400);
    }
    const raw = await this._readBody(req);
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch { /* 用默认配置 */ }

    const cfg = this.getConfig();
    try {
      const { Recorder, defaultOutputPath } = await import('./recorder.js');
      const { resolveExecutable } = await import('./proc.js');
      const { selectEncoder } = await import('./encoder-probe.js');
      const ff = resolveExecutable('ffmpeg');

      // 用壁纸管线已探测的编码器，或重新探测
      let encoder = this.engine?.encoder;
      if (!encoder) {
        const r = await selectEncoder(ff, { prefer: cfg.encoder !== 'auto' ? cfg.encoder : undefined });
        encoder = r.encoder;
      }

      const outputPath = body.outputPath || defaultOutputPath(cfg.recFolder || undefined);

      this.recorder = new Recorder({
        ffmpegPath: ff,
        encoder,
        outputPath,
        audioDevice: cfg.recAudioDevice || body.audioDevice || null,
        // 可选：只录屏幕的一块区域（不传则录整个屏幕）
        region: body.region || null,
        fps: cfg.recFps || 30,
        bitrate: cfg.recBitrate || 10,
        quality: cfg.recQuality || 20,
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
      this._json(res, { ok: true, ...result });
      this.broadcast({ type: 'record-started', ...result });
    } catch (err) {
      this._json(res, { ok: false, error: err.message, hint: err.hint || '' }, 500);
    }
  }

  async _recordStop(res) {
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
      return this._json(res, { devices });
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
        pid: r.pid,
      }));
      return this._json(res, { ok: true, runs, logsDir: logsDir() });
    } catch (err) {
      return this._json(res, { ok: false, error: err.message }, 500);
    }
  }

  /** 读取某次运行的 manifest 与日志。 */
  _getRunLog(runId, res) {
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
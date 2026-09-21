/**
 * app.js — 设置界面逻辑
 *
 * 控件由后端的 schema 自动生成，避免前后端参数定义不一致。
 * 拖动滑块时做防抖，避免高频请求导致管线反复重启。
 */

const state = {
  schema: null,
  config: null,
  devices: [],
  ws: null,
  pending: {},
  timer: null,
};

const $ = (id) => document.getElementById(id);

/* ─────────── 启动 ─────────── */

async function init() {
  try {
    const res = await fetch('/api/schema');
    const data = await res.json();
    state.schema = data.schema;
    state.config = data.config;
  } catch (err) {
    logLine('无法读取配置: ' + err.message, 'err');
    return;
  }

  await loadDevices();
  renderPanels();
  bindActions();
  await syncRecordState();
  syncRunInfo();
  connectWs();
}

/**
 * 同步运行会话信息（运行 ID 与日志目录）。
 * 展示在高级区，方便用户定位本次运行的日志文件。
 */
async function syncRunInfo() {
  try {
    const res = await fetch('/api/logs');
    const d = await res.json();
    if (d.ok && d.runs && d.runs.length) {
      const runIdEl = $('statRunId');
      const logsDirEl = $('statLogsDir');
      if (runIdEl) runIdEl.textContent = d.runs[0].runId;
      if (logsDirEl) {
        logsDirEl.textContent = d.logsDir || '—';
        logsDirEl.title = `运行目录：${d.runs[0].runId}`;
      }
    }
  } catch { /* 服务未提供日志信息时保持默认 */ }
}

/**
 * 同步录制状态。
 *
 * 为什么需要：录制进程跑在服务端，与页面生命周期无关。
 * 若用户刷新页面或 WebSocket 重连，UI 会丢失"正在录制"的显示，
 * 于是出现"界面显示未录制、点开始却被拒绝（已在录制中）"的矛盾。
 * 因此初始化时主动查一次服务端状态。
 */
async function syncRecordState() {
  try {
    const res = await fetch('/api/record/status');
    const d = await res.json();
    if (d.recording) {
      state.recStartedAt = d.startedAt || Date.now();
      $('recLabel').textContent = '录制中';
      $('recDot').classList.add('recording');
      $('btnRecord').classList.add('recording');
      $('btnRecord').textContent = '停止录制';
    }
  } catch { /* 查询失败时保持默认未录制状态 */ }
}

async function loadDevices() {
  try {
    const res = await fetch('/api/devices');
    const data = await res.json();
    state.devices = data.devices || [];
  } catch {
    state.devices = [];
  }
}

/* ─────────── 渲染控件 ─────────── */

/**
 * 渲染控件面板。
 *
 * 分组策略（让界面更精简）：
 *   "色彩"和"画面"合并为一个"画面与色彩"面板 —— 它们都是高频可调项
 *   布尔类字段（翻转、镜像、开机自启）两两排成一行，节省纵向空间
 *   其余保持单栏
 */
function renderPanels() {
  const groups = {};
  for (const [key, def] of Object.entries(state.schema)) {
    let g = def.group;
    // 色彩与画面合并显示
    if (g === '色彩') g = '画面与色彩';
    if (g === '画面') g = '画面与色彩';
    (groups[g] ||= []).push([key, def]);
  }

  const panels = $('panels');
  panels.innerHTML = '';

  for (const [groupName, fields] of Object.entries(groups)) {
    const panel = document.createElement('div');
    panel.className = 'panel';

    const h2 = document.createElement('h2');
    h2.textContent = groupName;
    panel.appendChild(h2);

    // 把同组的布尔字段两两配对，排成一行
    const bools = fields.filter(([, def]) => def.type === 'boolean');
    const nonBools = fields.filter(([, def]) => def.type !== 'boolean');

    // 非布尔字段先逐个渲染
    for (const [key, def] of nonBools) {
      panel.appendChild(buildField(key, def));
    }

    // 布尔字段两两一行
    for (let i = 0; i < bools.length; i += 2) {
      const row = document.createElement('div');
      row.className = 'field field-bool';
      row.appendChild(buildField(bools[i][0], bools[i][1]));
      if (bools[i + 1]) row.appendChild(buildField(bools[i + 1][0], bools[i + 1][1]));
      panel.appendChild(row);
    }

    panels.appendChild(panel);
  }
}

function buildField(key, def) {
  let wrap = document.createElement('div');
  wrap.className = 'field';

  const value = state.config[key];

  if (def.type === 'number') {
    const head = document.createElement('div');
    head.className = 'field-head';
    const label = document.createElement('label');
    label.textContent = def.label;
    const val = document.createElement('span');
    val.className = 'val';
    val.id = `val-${key}`;
    val.textContent = formatNumber(value, def);
    head.append(label, val);

    const input = document.createElement('input');
    input.type = 'range';
    input.min = def.min;
    input.max = def.max;
    input.step = def.step || 1;
    input.value = value;
    input.id = `in-${key}`;
    input.addEventListener('input', () => {
      val.textContent = formatNumber(input.value, def);
      scheduleUpdate(key, Number(input.value));
    });

    wrap.append(head, input);
  } else if (def.type === 'boolean') {
    // 布尔字段：不再套 .field wrapper，直接返回 toggle，由外层 .field-bool 排版
    const label = document.createElement('label');
    label.className = 'toggle';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = !!value;
    input.id = `in-${key}`;
    input.addEventListener('change', () => scheduleUpdate(key, input.checked, 0));
    const span = document.createElement('span');
    span.textContent = def.label;
    label.append(input, span);
    wrap = label; // 直接返回 label，不套 .field
  } else if (def.type === 'enum') {
    const head = document.createElement('div');
    head.className = 'field-head';
    const label = document.createElement('label');
    label.textContent = def.label;
    head.appendChild(label);

    const select = document.createElement('select');
    select.id = `in-${key}`;

    // 摄像头选择单独用设备列表填充
    const options = key === 'device'
      ? [{ v: '', t: '自动选择' }, ...state.devices.map((d) => ({ v: d, t: d }))]
      : (def.values || []).map((v) => ({ v, t: enumLabel(key, v) }));

    for (const o of options) {
      const opt = document.createElement('option');
      opt.value = o.v;
      opt.textContent = o.t;
      if (String(value) === String(o.v)) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener('change', () => scheduleUpdate(key, select.value, 0));

    wrap.append(head, select);
  } else {
    const head = document.createElement('div');
    head.className = 'field-head';
    const label = document.createElement('label');
    label.textContent = def.label;
    head.appendChild(label);

    const input = document.createElement('input');
    input.type = 'text';
    input.value = value ?? '';
    input.id = `in-${key}`;
    input.addEventListener('change', () => scheduleUpdate(key, input.value, 0));

    wrap.append(head, input);
  }

  // 需要重启管线的项加标记。
  // 布尔字段直接返回 label，help 通过 title 提示，不额外加元素
  if (def.type === 'boolean') {
    if (def.help) wrap.title = def.help;
    if (def.restart) wrap.title = (wrap.title ? wrap.title + ' · ' : '') + '改动需重启';
  } else if (def.help || def.restart) {
    const help = document.createElement('div');
    help.className = 'help';
    const bits = [];
    if (def.help) bits.push(def.help);
    if (def.restart) bits.push('改动需重启');
    help.textContent = bits.join(' · ');
    wrap.appendChild(help);
  }

  return wrap;
}

function enumLabel(key, value) {
  const map = {
    scaleMode: { fill: '铺满（裁切）', fit: '完整（留黑边）', stretch: '拉伸' },
    rotate: { 0: '不旋转', 90: '90°', 180: '180°', 270: '270°' },
    encoder: {
      auto: '自动选择',
      h264_amf: 'AMD H.264（硬件）', h264_nvenc: 'NVIDIA H.264（硬件）',
      h264_qsv: 'Intel H.264（硬件）', h264_mf: 'Media Foundation H.264', libx264: 'x264 H.264（软件）',
      hevc_amf: 'AMD H.265（硬件）', hevc_nvenc: 'NVIDIA H.265（硬件）',
      hevc_qsv: 'Intel H.265（硬件）', libx265: 'x265 H.265（软件）',
      av1_amf: 'AMD AV1（硬件）', av1_nvenc: 'NVIDIA AV1（硬件）',
    },
  };
  return map[key]?.[value] ?? value;
}

function formatNumber(v, def) {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  const step = def.step || 1;
  const decimals = step < 1 ? String(step).split('.')[1]?.length || 2 : 0;
  return n.toFixed(decimals);
}

/* ─────────── 保存（防抖） ─────────── */

function scheduleUpdate(key, value, delay) {
  state.pending[key] = value;
  // 拖动滑块时高频触发，等到停顿再发请求
  const wait = delay === undefined ? 220 : delay;
  clearTimeout(state.timer);
  state.timer = setTimeout(flushUpdates, wait);
  $('saveHint').textContent = '正在应用…';
}

async function flushUpdates() {
  if (!Object.keys(state.pending).length) return;
  const patch = state.pending;
  state.pending = {};

  try {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const data = await res.json();

    if (!data.ok) {
      logLine('保存失败: ' + (data.error || '未知错误'), 'err');
      $('saveHint').textContent = '保存失败';
      return;
    }

    state.config = data.config;
    for (const w of (data.warnings || [])) logLine(w, 'warn');

    const mode = data.result?.mode;
    if (mode === 'pending-restart') {
      const keys = data.result.pendingKeys || [];
      $('saveHint').innerHTML = `已保存，<b>需重启生效</b>（${keys.join('、')}）`;
      $('saveHint').classList.add('pending');
      $('btnRestart').classList.add('pulse');
    } else if (mode === 'sendcmd') {
      $('saveHint').textContent = '已即时生效';
      $('saveHint').classList.remove('pending');
      $('btnRestart').classList.remove('pulse');
    } else if (mode === 'sendcmd-failed') {
      // 色彩参数写入命令文件失败：如实告知，不能谎报成功
      $('saveHint').textContent = '色彩写入失败，请重试';
      $('saveHint').classList.remove('pending');
      logLine('色彩参数写入失败: ' + (data.result?.error || '未知原因'), 'err');
    } else {
      $('saveHint').textContent = '已保存';
      $('saveHint').classList.remove('pending');
      $('btnRestart').classList.remove('pulse');
    }
  } catch (err) {
    logLine('保存请求失败: ' + err.message, 'err');
    $('saveHint').textContent = '保存失败';
  }
}

/* ─────────── 操作按钮 ─────────── */

function bindActions() {
  $('btnRestart').addEventListener('click', async () => {
    $('saveHint').textContent = '正在重启…';
    try {
      const res = await fetch('/api/action', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'restart' }),
      });
      const d = await res.json();
      $('saveHint').textContent = d.ok ? '已重启' : '重启失败';
      if (!d.ok) logLine('重启失败: ' + d.error, 'err');
    } catch (e) { logLine('重启失败: ' + e.message, 'err'); }
  });

  $('btnStop').addEventListener('click', async () => {
    try {
      await fetch('/api/action', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'stop' }),
      });
      $('saveHint').textContent = '已停止';
      $('btnRestart').classList.remove('pulse');
    } catch (e) { logLine('停止失败: ' + e.message, 'err'); }
  });

  // 高级区折叠
  const advToggle = $('advToggle');
  const advContent = $('advContent');
  if (advToggle && advContent) {
    advToggle.addEventListener('click', () => {
      const hidden = advContent.hasAttribute('hidden');
      if (hidden) {
        advContent.removeAttribute('hidden');
        advToggle.textContent = '高级 ▾';
      } else {
        advContent.setAttribute('hidden', '');
        advToggle.textContent = '高级 ▸';
      }
    });
  }

  // 录制按钮
  const btnRec = $('btnRecord');
  if (btnRec) {
    btnRec.addEventListener('click', async () => {
      const isRecording = btnRec.classList.contains('recording');
      if (isRecording) {
        // 停止录制
        try {
          const res = await fetch('/api/record/stop', { method: 'POST' });
          const d = await res.json();
          if (d.ok) {
            logLine(`录制完成: ${d.outputPath}`, 'ok');
            $('recLabel').textContent = '未录制';
            $('recDot').classList.remove('recording');
            btnRec.classList.remove('recording');
            btnRec.textContent = '开始录制';
          } else { logLine('停止录制失败: ' + d.error, 'err'); }
        } catch (e) { logLine('停止录制失败: ' + e.message, 'err'); }
      } else {
        // 开始录制
        try {
          const res = await fetch('/api/record/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
          const d = await res.json();
          if (d.ok) {
            logLine(`开始录制: ${d.outputPath}`);
            $('recLabel').textContent = '录制中';
            $('recDot').classList.add('recording');
            btnRec.classList.add('recording');
            btnRec.textContent = '停止录制';
            state.recStartedAt = Date.now();
          } else { logLine('开始录制失败: ' + d.error, 'err'); }
        } catch (e) { logLine('开始录制失败: ' + e.message, 'err'); }
      }
    });
  }
}

/* ─────────── WebSocket ─────────── */

function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}`);
  state.ws = ws;

  ws.onopen = () => {
    $('connHint').textContent = '已连接';
    $('connHint').className = 'connected';
  };

  ws.onclose = () => {
    $('connHint').textContent = '连接断开，重连中…';
    $('connHint').className = 'disconnected';
    setTimeout(connectWs, 2000);
  };

  ws.onerror = () => { /* onclose 会跟进处理 */ };

  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'status') renderStatus(msg.status);
    else if (msg.type === 'log') logLine(msg.entry.message);
    else if (msg.type === 'record-started') {
      $('recLabel').textContent = '录制中';
      $('recDot').classList.add('recording');
      $('btnRecord').classList.add('recording');
      $('btnRecord').textContent = '停止录制';
      state.recStartedAt = Date.now();
    } else if (msg.type === 'record-stopped') {
      $('recLabel').textContent = '未录制';
      $('recDot').classList.remove('recording');
      $('btnRecord').classList.remove('recording');
      $('btnRecord').textContent = '开始录制';
      state.recStartedAt = null;
      if (msg.outputPath) logLine(`录制完成: ${msg.outputPath}`, 'ok');
    }
  };
}

// 录制计时器
setInterval(() => {
  const t = $('recTime');
  if (!t) return;
  if (state.recStartedAt) {
    const secs = Math.floor((Date.now() - state.recStartedAt) / 1000);
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    t.textContent = `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  } else {
    t.textContent = '00:00';
  }
}, 1000);

/* ─────────── 状态渲染 ─────────── */

function renderStatus(s) {
  if (!s) return;

  const dot = $('stateDot');
  const cls = s.state === 'running' ? 'running'
    : s.state === 'error' ? 'error'
    : (s.state === 'starting' || s.state === 'restarting') ? 'restarting' : '';
  dot.className = 'dot ' + cls;

  $('stateLabel').textContent = {
    running: '运行中', starting: '启动中…', restarting: '重启中…',
    error: '出错', stopped: '已停止', idle: '未启动',
  }[s.state] || s.state;

  // 主状态条（精简：只显示三项）
  $('statDevice').textContent = s.device || '—';
  $('statEncoder').textContent = s.encoder ? s.encoder.name : '—';
  $('statUptime').textContent = s.uptimeMs ? formatUptime(s.uptimeMs) : '—';

  // 高级区里的状态（在高级展开时才可见）
  const out = $('statOutput');
  if (out) out.textContent = s.output ? `${s.output.width}×${s.output.height}` : '—';
  const hw = $('statHw');
  if (hw) hw.textContent = s.encoder ? (s.encoder.hardware ? '硬件' : '软件') : '—';
  const pid = $('statPid');
  if (pid) pid.textContent = s.pids ? `${s.pids.ffmpeg ?? '-'} / ${s.pids.mpv ?? '-'}` : '—';
  const fc = $('filterChain');
  if (fc) fc.textContent = s.filterChain || '—';

  if (s.deviceFallbackFrom) {
    const d = $('statDevice');
    if (d) d.title = `指定的「${s.deviceFallbackFrom}」不可用，已改用「${s.device}」`;
  }
}

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}时${m}分`;
  if (m) return `${m}分${sec}秒`;
  return `${sec}秒`;
}

function logLine(message, cls) {
  const box = $('log');
  const row = document.createElement('div');
  const t = document.createElement('span');
  t.className = 't';
  t.textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const body = document.createElement('span');
  if (cls) body.className = cls;
  // 依据内容做简单的着色
  if (!cls) {
    if (/失败|错误|error|无法/i.test(message)) body.className = 'err';
    else if (/警告|注意|warn/i.test(message)) body.className = 'warn';
    else if (/完成|成功|生效|可用/i.test(message)) body.className = 'ok';
  }
  body.textContent = message;
  row.append(t, body);
  box.appendChild(row);

  // 只保留最近 300 行
  while (box.childElementCount > 300) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
}

init();
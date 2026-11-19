/**
 * app.js — 设置面板逻辑
 *
 * 交互模型（v2 重设计）：
 *  · 分区页签（画面/色彩/编码/录制/系统/诊断）代替单列长页面，
 *    每个页签只放相关的控件卡片，宽屏自动多列、窄屏单列。
 *  · 反馈走 toast（右上角轻提示），不再占用底栏常驻文字。
 *  · 需重启的改动聚合到顶部横幅 + 一键重启，避免"改完忘了重启"。
 *  · 数字项同时提供滑块与精确输入框，互相同步。
 *  · 重启请求在途禁用重启按钮（后端另有 409 守卫），防连点并发。
 *
 * 控件仍由后端 schema 自动生成，避免前后端参数定义不一致。
 */

const state = {
  schema: null,
  config: null,
  devices: [],
  audioDevices: [],
  ws: null,
  pending: {},        // 防抖缓冲的配置改动
  timer: null,
  flushing: false,    // 有请求在途时禁止并行 flush（防响应乱序互相覆盖）
  saveFails: 0,       // 连续保存失败计数（退避 + 防 toast 风暴）
  wsReconnectTimer: null, // 唯一的 WS 重连定时器（防堆积）
  pendingRestart: null, // 需重启的键列表（非 null 表示横幅可见）
  activeTab: null,
  restarting: false,
  recStartedAt: null,
};

const $ = (id) => document.getElementById(id);

/**
 * 页签 → schema 分组的映射（键顺序即页签顺序）。
 * '诊断' 是静态内容（advPanel），不从 schema 生成。
 */
const TAB_GROUPS = {
  '画面': ['设备', '画面'],
  '色彩': ['色彩'],
  '编码': ['编码', '延迟'],
  '录制': ['录制'],
  '系统': ['其他', '日志'],
  '诊断': [],
};

const TAB_STORAGE_KEY = 'c2b.activeTab';

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

/* ─────────── 启动 ─────────── */

async function init() {
  try {
    const res = await fetch('/api/schema');
    const data = await res.json();
    state.schema = data.schema;
    state.config = data.config;
  } catch (err) {
    toast('无法读取配置: ' + err.message, 'err');
    return;
  }

  await loadDevices();
  await loadAudioDevices();
  renderTabs();
  restoreTab();
  renderPanels();
  bindActions();
  await syncRecordState();
  syncRunInfo();
  connectWs();
}

/** 渲染分区页签。 */
function renderTabs() {
  const nav = $('tabs');
  nav.innerHTML = '';
  for (const name of Object.keys(TAB_GROUPS)) {
    const btn = el('button', 'tab', name);
    btn.type = 'button';
    btn.role = 'tab';
    btn.dataset.tab = name;
    btn.addEventListener('click', () => setActiveTab(name));
    nav.appendChild(btn);
  }
}

function restoreTab() {
  let saved = null;
  try { saved = localStorage.getItem(TAB_STORAGE_KEY); } catch { /* 隐私模式等 */ }
  setActiveTab(saved && TAB_GROUPS[saved] ? saved : Object.keys(TAB_GROUPS)[0]);
}

function setActiveTab(name) {
  if (!TAB_GROUPS[name]) name = Object.keys(TAB_GROUPS)[0];
  state.activeTab = name;
  try { localStorage.setItem(TAB_STORAGE_KEY, name); } catch { /* 忽略 */ }
  for (const btn of $('tabs').children) {
    btn.setAttribute('aria-selected', String(btn.dataset.tab === name));
  }
  renderPanels();
}

/**
 * 同步运行会话信息（运行 ID 与日志目录），展示在诊断页签。
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
        logsDirEl.title = `运行目录：${d.logsDir || ''}`;
      }
    }
  } catch { /* 服务未提供日志信息时保持默认 */ }
}

/**
 * 同步录制状态：录制进程跑在服务端，与页面生命周期无关。
 * 刷新页面或 WebSocket 重连后必须以服务端为准，否则会出现
 * "界面显示未录制、点开始却被拒绝（已在录制中）"的矛盾。
 */
async function syncRecordState() {
  try {
    const res = await fetch('/api/record/status');
    const d = await res.json();
    if (d.recording) {
      state.recStartedAt = d.startedAt || Date.now();
      setRecordingUi(true);
    }
  } catch { /* 查询失败时保持默认未录制状态 */ }
}

function setRecordingUi(on) {
  $('recLabel').textContent = on ? '录制中' : '未录制';
  $('recDot').classList.toggle('recording', on);
  $('btnRecord').classList.toggle('recording', on);
  $('btnRecord').textContent = on ? '停止录制' : '开始录制';
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

/**
 * 加载麦克风列表（{value,label}；重名第二个=备用名）。
 * 历史缺陷：recAudioDevice 是自由文本框 —— 手滑/设备改名即录制失败，
 * 且两个同名麦克风根本无法区分选择。改为下拉后整类输入错误消失。
 */
async function loadAudioDevices() {
  try {
    const res = await fetch('/api/audio-devices');
    const data = await res.json();
    state.audioDevices = data.devices || [];
  } catch {
    state.audioDevices = [];
  }
}

/* ─────────── 渲染控件 ─────────── */

/** 只渲染当前页签的 schema 分组；'诊断' 显示静态面板。 */
function renderPanels() {
  const container = $('panels');
  const adv = $('advPanel');

  if (state.activeTab === '诊断') {
    container.hidden = true;
    container.innerHTML = '';
    adv.hidden = false;
    return;
  }
  adv.hidden = true;
  container.hidden = false;
  container.innerHTML = '';

  for (const groupName of TAB_GROUPS[state.activeTab] || []) {
    const fields = Object.entries(state.schema).filter(([, def]) => def.group === groupName);
    if (!fields.length) continue;

    const panel = el('div', 'panel');
    panel.appendChild(el('h2', '', groupName));

    const bools = fields.filter(([, def]) => def.type === 'boolean');
    const others = fields.filter(([, def]) => def.type !== 'boolean');

    for (const [key, def] of others) panel.appendChild(buildField(key, def));

    // 布尔字段两两一行，节省纵向空间；空间不足自动换行
    for (let i = 0; i < bools.length; i += 2) {
      const row = el('div', 'field field-bool');
      row.appendChild(buildField(bools[i][0], bools[i][1]));
      if (bools[i + 1]) row.appendChild(buildField(bools[i + 1][0], bools[i + 1][1]));
      panel.appendChild(row);
    }

    container.appendChild(panel);
  }
}

function buildField(key, def) {
  let wrap = el('div', 'field');
  const value = state.config[key];

  if (def.type === 'number') {
    // 数字项：标签 + 精确输入框（上），滑块（下），双向同步
    const head = el('div', 'field-head');
    const label = el('label');
    label.textContent = def.label;
    label.htmlFor = `num-${key}`;

    const num = document.createElement('input');
    num.type = 'number';
    num.className = 'num-input';
    num.id = `num-${key}`;
    num.min = def.min;
    num.max = def.max;
    num.step = def.step || 1;
    num.value = value;
    head.append(label, num);

    const range = document.createElement('input');
    range.type = 'range';
    range.min = def.min;
    range.max = def.max;
    range.step = def.step || 1;
    range.value = value;
    range.id = `in-${key}`;
    range.setAttribute('aria-label', def.label);

    range.addEventListener('input', () => {
      num.value = range.value;
      scheduleUpdate(key, Number(range.value));
    });
    num.addEventListener('change', () => {
      let v = Number(num.value);
      if (!Number.isFinite(v)) v = Number(state.config[key]);
      v = Math.min(def.max, Math.max(def.min, v));
      // 步进对齐 + 浮点噪声裁剪：Math.round(v/step)*step 本身可能产出
      // 0.30000000000000004 这类噪声（30*0.01 在 IEEE 下即是），须 toFixed 收口
      const step = def.step || 1;
      v = Number((Math.round(v / step) * step).toFixed(6));
      v = Math.min(def.max, Math.max(def.min, v));
      num.value = v;
      range.value = v;
      scheduleUpdate(key, v);
    });

    wrap.append(head, range);
  } else if (def.type === 'boolean') {
    // 布尔字段：滑动开关，不套 .field 外壳，由 .field-bool 排版
    const label = el('label', 'toggle');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = !!value;
    input.id = `in-${key}`;
    input.addEventListener('change', () => scheduleUpdate(key, input.checked, 0));
    const span = el('span', '', def.label);
    label.append(input, span);
    wrap = label;
  } else if (def.type === 'enum') {
    const head = el('div', 'field-head');
    const label = el('label');
    label.textContent = def.label;
    label.htmlFor = `in-${key}`;
    head.appendChild(label);

    const select = document.createElement('select');
    select.id = `in-${key}`;

    // 摄像头选择单独用设备列表填充。
    // 服务端条目为 {value,label}（value=dshow 打开标识，重名设备=备用名）；
    // 兼容旧字符串形态，防止前后端版本短暂错配时整块下拉崩掉。
    const options = key === 'device'
      ? [{ v: '', t: '自动选择' }, ...state.devices.map((d) => (
        typeof d === 'string' ? { v: d, t: d } : { v: d.value, t: d.label }
      ))]
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
  } else if (key === 'recAudioDevice') {
    // 麦克风：下拉选择（值=dshow 打开标识）。兼容旧字符串形态条目；
    // 配置里已失效的设备保留展示为"（当前不可用）"，绝不静默变回"不录音频"。
    const head = el('div', 'field-head');
    const label = el('label');
    label.textContent = def.label;
    label.htmlFor = `in-${key}`;
    head.appendChild(label);

    const select = document.createElement('select');
    select.id = `in-${key}`;
    const opts = [{ v: '', t: '不录音频（留空）' }];
    for (const d of state.audioDevices) {
      opts.push(typeof d === 'string' ? { v: d, t: d } : { v: d.value, t: d.label });
    }
    const cur = value ?? '';
    if (cur && !opts.some((o) => String(o.v) === String(cur))) {
      opts.push({ v: cur, t: `${cur}（当前不可用）` });
    }
    for (const o of opts) {
      const opt = document.createElement('option');
      opt.value = o.v;
      opt.textContent = o.t;
      if (String(cur) === String(o.v)) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener('change', () => scheduleUpdate(key, select.value, 0));
    wrap.append(head, select);
  } else {
    const head = el('div', 'field-head');
    const label = el('label');
    label.textContent = def.label;
    label.htmlFor = `in-${key}`;
    head.appendChild(label);

    const input = document.createElement('input');
    input.type = 'text';
    input.value = value ?? '';
    input.id = `in-${key}`;
    input.addEventListener('change', () => scheduleUpdate(key, input.value, 0));

    wrap.append(head, input);
  }

  // 帮助与"需重启"标记
  if (def.type === 'boolean') {
    if (def.help) wrap.title = def.help;
    if (def.restart) wrap.title = (wrap.title ? wrap.title + ' · ' : '') + '改动需重启';
    if (def.restart) wrap.classList.add('need-restart');
  } else if (def.help || def.restart) {
    const help = el('div', 'help');
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
    latencyMode: { 'ultra-low': '超低延迟（默认）', balanced: '均衡', smooth: '流畅优先' },
    logLevel: { debug: '调试（最详细）', info: '信息（默认）', warn: '警告与错误', error: '仅错误' },
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

/* ─────────── 保存（防抖） ─────────── */

function scheduleUpdate(key, value, delay) {
  state.pending[key] = value;
  // 拖动滑块时高频触发，等到停顿再发请求
  const wait = delay === undefined ? 220 : delay;
  clearTimeout(state.timer);
  state.timer = setTimeout(flushUpdates, wait);
}

async function flushUpdates() {
  // 在途守卫：并行 flush 会因响应乱序互相覆盖配置（后发先至 = 旧值盖新值）。
  // 在途时重新排短延迟，等完成后再合并发送。
  if (state.flushing) {
    clearTimeout(state.timer);
    state.timer = setTimeout(flushUpdates, 220);
    return;
  }
  if (!Object.keys(state.pending).length) return;
  const patch = state.pending;
  state.pending = {};
  state.flushing = true;

  try {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const data = await res.json();

    if (!data.ok) {
      // 保存失败（含过渡态 409）：把这批改动**放回缓冲**，不吞掉用户的编辑。
      // ⚠️ 退避 + 只在首次打扰：连续失败（如过渡态 15s 内的 409、端口切换
      // 瞬间的断连）若每次都弹 toast，会形成每 220ms 一次的 toast 风暴。
      state.pending = { ...patch, ...state.pending };
      state.saveFails += 1;
      const msg = '保存失败: ' + (data.error || '未知错误') + '，改动已保留，稍后重试';
      if (state.saveFails === 1) toast(msg, 'err');
      logLine(msg, `fail#${state.saveFails} `);
      return;
    }
    state.saveFails = 0;
    state.config = data.config;

    // 服务端规范化（步进对齐/夹取）可能改变了提交值 → 回填控件，界面与
    // 实际生效值必须一致（历史上界面停在提交前的值，显示与配置两张皮）
    syncFieldsFromConfig(patch);

    // 告警面向用户（步进对齐这类"我替你改了值"必须可见），不只藏诊断日志
    const warns = data.warnings || [];
    for (const w of warns) logLine(w, 'warn');
    if (warns.length) {
      toast(warns.length > 1 ? `${warns[0]} 等 ${warns.length} 项已自动修正` : warns[0], 'warn');
    }

    const mode = data.result?.mode;

    // uiPort 热切换：本页所在的旧端口即将/已被服务端切走，探测新端口后跳转，
    // 否则用户面对永久"连接断开、重连中"却不知道新地址（真机实证的搁浅场景）
    const newPort = Number(state.config.uiPort);
    if (mode !== 'ui-port-failed' && newPort && String(newPort) !== String(location.port)) {
      await followPortSwitch(newPort);
      return; // 页面即将跳转（或确认失败留在原页），后续 UI 更新无意义
    }

    if (mode === 'pending-restart') {
      const keys = data.result.pendingKeys || [];
      showRestartBanner(keys);
      toast(`已保存 · ${keys.length} 项需重启生效`, 'warn');
    } else if (mode === 'sendcmd') {
      toast('已即时生效', 'ok');
    } else if (mode === 'sendcmd-failed') {
      // 色彩参数写入命令文件失败：如实告知，不能谎报成功
      toast('色彩写入失败，请重试', 'err');
      logLine('色彩参数写入失败: ' + (data.result?.error || '未知原因'), 'err');
    } else if (mode === 'ui-port-failed') {
      // 端口切换失败已被服务端自动回退：错误 + 是否仍有待重启项都要展示
      toast('端口切换失败: ' + (data.result?.error || '未知原因'), 'err');
      const keys = data.result.pendingKeys || [];
      if (keys.length) showRestartBanner(keys);
    } else if (!warns.length) {
      toast('已保存', 'ok');
    }
  } catch (err) {
    // 网络失败同样保留改动；同用退避与首次打扰原则（见上）
    state.pending = { ...patch, ...state.pending };
    state.saveFails += 1;
    const msg = '保存请求失败: ' + err.message + '，改动已保留，稍后重试';
    if (state.saveFails === 1) toast(msg, 'err');
    logLine(msg, `fail#${state.saveFails} `);
  } finally {
    state.flushing = false;
    // 在途期间累积的改动确保会被补发；连续失败时指数退避（220ms → 最长3.5s）
    if (Object.keys(state.pending).length) {
      clearTimeout(state.timer);
      const delay = Math.min(220 * (2 ** Math.min(Math.max(state.saveFails - 1, 0), 4)), 3500);
      state.timer = setTimeout(flushUpdates, delay);
    }
  }
}

/**
 * uiPort 热切换后的跟跳：探测新端口就绪再跳转。
 * - 新端口就绪 → 直接跳（延迟 relisten 约600ms，这里最多等 ~4s）
 * - 探测不到 → 说明服务在竞争窗口里回退了配置（旧端口仍活着），
 *   留在原页即可——保存重试逻辑会自然恢复，绝不把用户带到死端口
 * @param {number} port 目标端口
 * @returns {Promise<boolean>} 是否已跳转
 */
async function followPortSwitch(port) {
  const url = `http://127.0.0.1:${port}/`;
  toast(`端口已切换到 ${port}，正在跳转…`, 'warn');
  for (let i = 0; i < 14; i += 1) {
    try {
      const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout
        ? AbortSignal.timeout(700) : undefined;
      const r = await fetch(new URL('api/status', url), { signal });
      if (r.ok) { location.replace(url); return true; }
    } catch { /* 新端口尚未就绪 */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  toast('新端口未生效，已保留在当前页面（服务已回退）', 'warn');
  return false;
}

/**
 * 把服务端规范化后的值回填到控件。
 * 步进对齐/范围夹取可能改变了用户提交的值（如 29.9→30、0.30000000000000004→0.3），
 * 不回填会出现"界面显示 A、实际生效 B"的两张皮。
 * @param {object} patch 本次提交过的键
 */
function syncFieldsFromConfig(patch) {
  for (const key of Object.keys(patch)) {
    const v = state.config[key];
    if (v === undefined) continue;
    const num = $(`num-${key}`);
    if (num && String(num.value) !== String(v)) num.value = v;
    const ctl = $(`in-${key}`);
    if (!ctl) continue;
    if (ctl.type === 'checkbox') ctl.checked = !!v;
    else if (String(ctl.value) !== String(v)) ctl.value = String(v);
  }
}

/** 配置键 → 界面中文标签（横幅/pendingKeys 不再裸奔英文键名）。 */
function keyLabel(key) {
  return state.schema?.[key]?.label ?? key;
}

/* ─────────── 待重启横幅 ─────────── */

function showRestartBanner(keys) {
  state.pendingRestart = keys;
  // 展示中文标签（历史上裸显 bitrate/quality 等英文键名，用户看不懂）
  const labels = keys.map(keyLabel);
  $('bannerText').textContent = keys.length
    ? `有 ${keys.length} 项改动需重启生效：${labels.join('、')}`
    : '有改动需重启生效';
  $('restartBanner').hidden = false;
}

function hideRestartBanner() {
  state.pendingRestart = null;
  $('restartBanner').hidden = true;
}

/* ─────────── 操作按钮 ─────────── */

function setRestartDisabled(disabled) {
  for (const id of ['btnRestart', 'btnBannerRestart']) {
    const b = $(id);
    if (b) b.disabled = disabled;
  }
}

/** 重启（顶栏按钮与横幅按钮共用）。防连点：在途时直接忽略。 */
async function doRestart() {
  if (state.restarting) return;
  state.restarting = true;
  setRestartDisabled(true);
  toast('正在重启…', 'info');
  try {
    const res = await fetch('/api/action', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'restart' }),
    });
    const d = await res.json();
    if (d.ok) {
      toast('重启完成', 'ok');
      logLine('重启完成', 'ok');
      hideRestartBanner();
    } else {
      // error + hint 一并展示：hint 是"该怎么办"，丢掉它用户只能瞎猜
      const hint = d.hint ? `（${d.hint}）` : '';
      const msg = res.status === 409 ? '正在重启中，请稍候' : `重启失败: ${d.error}${hint}`;
      toast(msg, 'err');
      logLine(msg, 'err');
    }
  } catch (e) {
    toast('重启失败: ' + e.message, 'err');
    logLine('重启失败: ' + e.message, 'err');
  } finally {
    state.restarting = false;
    setRestartDisabled(false);
  }
}

function bindActions() {
  $('btnRestart').addEventListener('click', doRestart);
  $('btnBannerRestart').addEventListener('click', doRestart);

  $('btnStop').addEventListener('click', async () => {
    try {
      await fetch('/api/action', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'stop' }),
      });
      toast('已停止', 'ok');
    } catch (e) {
      toast('停止失败: ' + e.message, 'err');
      logLine('停止失败: ' + e.message, 'err');
    }
  });

  // 录制按钮
  const btnRec = $('btnRecord');
  btnRec.addEventListener('click', async () => {
    const isRecording = btnRec.classList.contains('recording');
    if (isRecording) {
      try {
        const res = await fetch('/api/record/stop', { method: 'POST' });
        const d = await res.json();
        if (d.ok) {
          toast(`录制完成: ${d.outputPath}`, 'ok');
          logLine(`录制完成: ${d.outputPath}`, 'ok');
          setRecordingUi(false);
          state.recStartedAt = null;
        } else { toast('停止录制失败: ' + d.error, 'err'); }
      } catch (e) { toast('停止录制失败: ' + e.message, 'err'); }
    } else {
      try {
        const res = await fetch('/api/record/start', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        });
        const d = await res.json();
        if (d.ok) {
          toast(`开始录制: ${d.outputPath}`, 'ok');
          setRecordingUi(true);
          state.recStartedAt = Date.now();
        } else { toast('开始录制失败: ' + d.error, 'err'); }
      } catch (e) { toast('开始录制失败: ' + e.message, 'err'); }
    }
  });
}

/* ─────────── Toast 轻提示 ─────────── */

function toast(message, type = 'info') {
  const box = $('toasts');
  if (!box) return;
  const item = el('div', `toast ${type}`, message);
  box.appendChild(item);
  requestAnimationFrame(() => item.classList.add('show'));
  const life = type === 'err' ? 5000 : 2500;
  setTimeout(() => {
    item.classList.remove('show');
    setTimeout(() => item.remove(), 300);
  }, life);
  while (box.childElementCount > 4) box.removeChild(box.firstChild);
}

/* ─────────── WebSocket ─────────── */

function connectWs() {
  // 幂等：已有活连接/正在建连时不再发起（防重复连接；曾有"旧 socket 延迟
  // close 触发重复重连"的竞态隐患），并保证全局只有一个重连定时器
  if (state.ws && (state.ws.readyState === WebSocket.OPEN
    || state.ws.readyState === WebSocket.CONNECTING)) return;
  clearTimeout(state.wsReconnectTimer);

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}`);
  state.ws = ws;

  // 连接超时保护：握手悬挂（如端口热切换瞬间、TCP 半开）时主动关闭 →
  // 走 onclose 重连链，避免永远卡在 CONNECTING 却无人重试
  const connectTimeout = setTimeout(() => {
    if (ws.readyState !== WebSocket.OPEN) { try { ws.close(); } catch { /* ignore */ } }
  }, 8000);

  ws.onopen = () => {
    clearTimeout(connectTimeout);
    $('connHint').textContent = '已连接';
    $('connHint').className = 'connected';
  };

  ws.onclose = () => {
    clearTimeout(connectTimeout);
    $('connHint').textContent = '连接断开，重连中…';
    $('connHint').className = 'disconnected';
    clearTimeout(state.wsReconnectTimer);
    state.wsReconnectTimer = setTimeout(connectWs, 2000);
  };

  ws.onerror = () => { /* onclose 会跟进处理 */ };

  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'status') renderStatus(msg.status);
    else if (msg.type === 'log') logLine(msg.entry.message);
    else if (msg.type === 'record-started') {
      setRecordingUi(true);
      state.recStartedAt = Date.now();
    } else if (msg.type === 'record-stopped') {
      setRecordingUi(false);
      state.recStartedAt = null;
      if (msg.outputPath) logLine(`录制完成: ${msg.outputPath}`, 'ok');
    } else if (msg.type === 'port-switch') {
      // CLI 发起的端口切换（c2b set uiPort=X）不会给本页 save 响应 —— 服务端在
      // relisten **前**经 WS 通告本页，跟跳到新端口；否则 WS 被掐断后永久重连
      // 已关闭的旧端口（"连接断开、重连中…"搁浅）。重复触发由 followPortSwitch 幂等。
      if (Number(msg.port) && String(msg.port) !== String(location.port)) {
        followPortSwitch(Number(msg.port));
      }
    } else if (msg.type === 'config') {
      applyExternalConfig(msg.config);
    }
  };
}

/**
 * 应用外部（CLI `c2b set` 等）发起的配置变更。
 *
 * 数据层本就无害（flush 只发 pending 键、服务端 merge），但**显示必须准确** ——
 * 否则界面表单停留在旧值，用户被误导"改了没生效"。
 * 关键：绝不打断正在编辑的字段（round8 原则）——
 * 跳过本地有未保存编辑（state.pending）与当前聚焦的控件，只同步其余变化项。
 * @param {object} cfg 服务端最终配置
 */
function applyExternalConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return;
  const prev = state.config || {};
  const changed = Object.keys(cfg).filter((k) => prev[k] !== cfg[k]);
  // 模型先行：即便个别控件被跳过，后续 flush 的合并也以最新模型为准
  state.config = cfg;
  if (!changed.length) return; // 与本地一致（含自己保存的回声）→ 幂等无操作

  const focused = document.activeElement;
  const syncable = {};
  const skipped = [];
  for (const k of changed) {
    if (state.pending[k] !== undefined) { skipped.push(k); continue; } // 本地未保存编辑 → 让它赢
    if (focused && focused.id === `in-${k}`) { skipped.push(k); continue; } // 正在编辑 → 不打断
    syncable[k] = true;
  }
  if (Object.keys(syncable).length) syncFieldsFromConfig(syncable);
  const label = (arr) => arr.map(keyLabel).join('、');
  if (skipped.length && Object.keys(syncable).length) {
    logLine(`外部配置变更已同步: ${label(Object.keys(syncable))}；保留本地编辑: ${label(skipped)}`, 'warn');
  } else if (skipped.length) {
    logLine(`外部配置变更（保留本地编辑，稍后随保存合并）: ${label(skipped)}`, 'warn');
  } else {
    logLine(`外部配置变更已同步: ${label(Object.keys(syncable))}`, 'warn');
  }
}

// 录制计时器
setInterval(() => {
  const t = $('recTime');
  if (!t) return;
  if (state.recStartedAt) {
    const secs = Math.floor((Date.now() - state.recStartedAt) / 1000);
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    t.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
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
  $('stateBadge').dataset.state = s.state || '';

  $('stateLabel').textContent = {
    running: '运行中', starting: '启动中…', restarting: '重启中…',
    error: '出错', stopped: '已停止', idle: '未启动',
  }[s.state] || s.state;

  // 过渡态禁用操作按钮：启动/重启进行中点停止，会与在途流程并发抢摄像头
  // 或产生"停了又被拉起来"的僵尸状态（服务端另有 409 守卫，这里是体验层）
  const stopBtn = $('btnStop');
  if (stopBtn) stopBtn.disabled = (s.state === 'starting' || s.state === 'restarting');

  // 顶部指标卡
  $('statDevice').textContent = s.device || '—';
  $('statEncoder').textContent = s.encoder ? s.encoder.name : '—';
  $('statOutput').textContent = s.output ? `${s.output.width}×${s.output.height}` : '—';
  $('statUptime').textContent = s.uptimeMs ? formatUptime(s.uptimeMs) : '—';

  // 诊断页签（可能处于隐藏状态，元素始终存在）
  const hw = $('statHw');
  if (hw) hw.textContent = s.encoder ? (s.encoder.hardware ? '硬件' : '软件') : '—';
  const pid = $('statPid');
  if (pid) pid.textContent = s.pids ? `${s.pids.ffmpeg ?? '-'} / ${s.pids.mpv ?? '-'}` : '—';
  const fc = $('filterChain');
  if (fc) fc.textContent = s.filterChain || '—';

  const dev = $('statDevice');
  if (dev && s.deviceFallbackFrom) {
    dev.title = `指定的「${s.deviceFallbackFrom}」不可用，已改用「${s.device}」`;
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

/* ─────────── 运行日志（诊断页签） ─────────── */

function logLine(message, cls) {
  const box = $('log');
  if (!box) return;
  const row = el('div');
  const t = el('span', 't');
  t.textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const body = document.createElement('span');
  if (cls) body.className = cls;
  else if (/失败|错误|error|无法/i.test(message)) body.className = 'err';
  else if (/警告|注意|warn/i.test(message)) body.className = 'warn';
  else if (/完成|成功|生效|可用/i.test(message)) body.className = 'ok';
  body.textContent = message;
  row.append(t, body);
  box.appendChild(row);

  // 只保留最近 300 行
  while (box.childElementCount > 300) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
}

init();

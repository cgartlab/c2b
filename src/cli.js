#!/usr/bin/env node
/**
 * cli.js — 命令行入口
 *
 * 用法：
 *   cam-to-bg start [--no-ui] [--verbose]   启动壁纸
 *   cam-to-bg stop                           停止正在运行的实例
 *   cam-to-bg status                         查看运行状态
 *   cam-to-bg devices                        列出可用摄像头
 *   cam-to-bg probe                          检测环境与编码器
 */
import { createApp, checkEnvironment, lookupRunningInstance } from './index.js';
import { loadConfig, saveConfig, configPath, schemaForUi, defaultConfig, mergeConfig } from './config.js';
import { listVideoDevices, probeDeviceFormats } from './devices.js';
import { selectEncoder, ENCODER_CANDIDATES } from './encoder-probe.js';
import { isElevated } from './pipeline.js';
import { probeDesktop } from './win32.js';
import { CamToBgError } from './errors.js';
import { readState, clearState, isAlive } from './state.js';
import { spawnSync } from 'node:child_process';

const [, , command, ...rest] = process.argv;
const flags = new Set(rest.filter((a) => a.startsWith('--')));
const positionals = rest.filter((a) => !a.startsWith('--'));

function out(msg = '') { process.stdout.write(msg + '\n'); }

function printError(err) {
  if (err instanceof CamToBgError) {
    process.stderr.write(`\n✗ ${err.message}\n`);
    if (err.hint) process.stderr.write(`  ${err.hint.replace(/\n/g, '\n  ')}\n`);
    process.stderr.write('\n');
  } else {
    process.stderr.write(`\n✗ ${err.message}\n`);
    if (process.env.CAM_TO_BG_DEBUG) process.stderr.write(String(err.stack) + '\n');
    process.stderr.write('\n');
  }
}

async function cmdStart() {
  const openUi = !flags.has('--no-ui');
  const verbose = flags.has('--verbose') || flags.has('-v');

  const running = lookupRunningInstance();
  if (running) {
    out(`已在运行中 (pid=${running.pid})。如需重启，请先执行: cam-to-bg stop`);
    if (running.uiUrl) out(`设置界面: ${running.uiUrl}`);
    return 0;
  }

  out('摄像头壁纸 — 正在启动\n');

  const app = await createApp({ openUi, verbose });

  const { status, ui } = await app.start();

  out('');
  out('  ✓ 壁纸已启动');
  out(`    摄像头    ${status.device}`);
  out(`    编码器    ${status.encoder?.name} (${status.encoder?.label})`);
  out(`    输出      ${status.output?.width}×${status.output?.height}`);
  out(`    滤镜      ${status.filterChain}`);
  out(`    桌面挂载  ${status.attached ? '成功' : '未挂载'}`);
  if (ui) out(`    设置界面  ${ui.url}`);
  if (app.run) out(`    运行 ID    ${app.run.runId}`);
  if (app.run) out(`    日志目录  ${app.run.dir}`);
  out('');
  out('  按 Ctrl+C 退出（会自动还原桌面）');
  out('');

  const shutdown = async () => {
    out('\n正在停止并还原桌面…');

    // 顺序很重要：先尝试优雅停止（摘窗口 → 停进程），
    // 只有超时未完成才同步强杀。
    //
    // 早期版本先调 killChildrenSync()，会在优雅流程之前就把 ffmpeg/mpv 杀掉，
    // 导致 detachFromDesktop 对着已消失的窗口操作、录制进程也来不及封尾。
    const forceKill = setTimeout(() => {
      out('停止超时，强制结束子进程…');
      try { app.killChildrenSync?.(); } catch { /* 忽略 */ }
    }, 8000);

    try {
      await app.stop();
      out('✓ 已停止，桌面已还原');
    } catch (err) {
      printError(err);
      // 优雅停止失败时兜底强杀，避免留下孤儿
      try { app.killChildrenSync?.(); } catch { /* 忽略 */ }
    } finally {
      clearTimeout(forceKill);
    }
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  /**
   * 兜底错误处理。
   *
   * 注意 unhandledRejection 必须单独处理：
   * Node 默认会因未处理的 Promise 拒绝而终止进程，
   * 而完整重启（restart）过程中若有异步异常逃逸，
   * 会导致整个服务连同设置界面一起静默退出。
   * 这类错误不应让进程死掉 —— 壁纸还在跑，用户需要能继续通过界面操作。
   */
  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    out(`\n[警告] 未处理的异步异常（服务继续运行）: ${msg}`);
    if (process.env.CAM_TO_BG_DEBUG && reason instanceof Error) {
      out(reason.stack);
    }
  });

  process.on('uncaughtException', async (err) => {
    printError(err);
    try { await app.stop(); } catch { /* 尽力而为 */ }
    process.exit(1);
  });

  // 常驻
  await new Promise(() => {});
  return 0;
}

/**
 * 按"父进程 pid"找出本实例拉起的 ffmpeg / mpv 子进程。
 *
 * 为什么不依赖 state.json 里记录的 pid：
 * 管线重启或进程异常退出时，记录下来的 pid 会过期，
 * 用它去清理会打空，真正的进程反而被漏掉。
 * 直接按父进程关系查找则始终准确。
 *
 * @param {number} parentPid 主进程 pid；传 0 表示查找所有
 * @returns {Array<{pid:number, name:string}>}
 */
function findChildProcesses(parentPid) {
  const found = [];
  try {
    // tasklist 是系统自带工具，不需要额外依赖。
    // 注意用 spawnSync + inherit：execFile 会建管道，受限环境下抛 EPERM。
    const r = spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='ffmpeg.exe' OR Name='mpv.exe'" | `
      + `Where-Object { $_.ParentProcessId -eq ${parentPid} } | `
      + `ForEach-Object { "$($_.ProcessId)|$($_.Name)" }`,
    ], { encoding: 'utf8', windowsHide: true, timeout: 8000 });

    for (const line of String(r.stdout || '').split(/\r?\n/)) {
      const m = line.trim().match(/^(\d+)\|(.+)$/);
      if (m) found.push({ pid: Number(m[1]), name: m[2] });
    }
  } catch {
    // CIM 不可用时回退到"按名字匹配"的粗暴方式（下面单独处理）
  }
  return found;
}

async function cmdStop() {
  const st = readState();
  const mainPid = st?.pid;

  if (!mainPid || !isAlive(mainPid)) {
    // 主进程已不在，但可能仍有孤儿在占用摄像头。
    // 只按"父进程关系"和"状态文件记录的 pid"清理，不做按名全量匹配，
    // 以免误杀用户其他程序启动的 ffmpeg/mpv。
    const kids = mainPid ? findChildProcesses(mainPid) : [];
    const recorded = st?.children || {};
    const orphans = new Set(kids.map((k) => k.pid));
    for (const pid of Object.values(recorded)) {
      if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) orphans.add(pid);
    }

    if (orphans.size) {
      out(`主进程已退出，清理残留子进程 (${orphans.size} 个)…`);
      killPids([...orphans]);
    }
    clearState();
    out('没有正在运行的实例。');
    return 0;
  }

  out(`正在停止 pid=${mainPid} …`);

  // 先记下子进程，供主进程退出后清理。
  // 必须在发信号之前查，因为主进程一退出，父子关系就断了。
  const kidsBefore = findChildProcesses(mainPid);

  try {
    process.kill(mainPid, 'SIGTERM');
  } catch (err) {
    printError(new CamToBgError(`无法通知进程退出: ${err.message}`));
    return 1;
  }

  // 等主进程退出
  let mainGone = false;
  for (let i = 0; i < 40; i += 1) {
    await new Promise((r) => setTimeout(r, 150));
    if (!isAlive(mainPid)) { mainGone = true; break; }
  }

  if (!mainGone) {
    out('主进程未响应，强制结束…');
    try { process.kill(mainPid, 'SIGKILL'); } catch { /* 可能刚退出 */ }
    await new Promise((r) => setTimeout(r, 500));
  }

  // 关键：主进程退出 ≠ 子进程已退出。
  // ffmpeg/mpv 由主进程拉起，主进程若在其退出前就结束，
  // 它们会变成孤儿继续占用摄像头，并在桌面上留下窗口。
  //
  // 清理范围必须严格限定，否则会误杀用户自己另外打开的 ffmpeg/mpv
  // （例如别的转码/录屏任务）。判定依据只有两条：
  //   1) 发信号前记录的、父进程正是本实例的 pid —— 最准确
  //   2) state.json 里记录过的子进程 pid —— 覆盖父子关系已断的孤儿
  // 绝不使用"按进程名全量匹配"的兜底，那会杀掉无关进程。
  const leftovers = new Map();

  for (const k of kidsBefore) {
    if (isAlive(k.pid)) leftovers.set(k.pid, k.name);
  }

  // 用状态文件里记录的子进程 pid 兜底（仅限本实例启动时记下的那些）
  const recorded = st?.children || {};
  for (const [name, pid] of Object.entries(recorded)) {
    if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) leftovers.set(pid, name);
  }

  if (leftovers.size) {
    const list = [...leftovers.keys()];
    out(`清理残留子进程 (${list.length} 个: ${[...leftovers.values()].join(', ')})…`);
    killPids(list);
    await new Promise((r) => setTimeout(r, 900));

    const still = list.filter((pid) => isAlive(pid));
    if (still.length) {
      out(`仍有 ${still.length} 个进程未退出，再次强制结束…`);
      killPids(still);
      await new Promise((r) => setTimeout(r, 600));
    }
    const final = list.filter((pid) => isAlive(pid));
    if (final.length) {
      clearState();
      out('✓ 已停止');
      out('提示：仍有进程未退出。若桌面上残留视频窗口，注销一次或重启 explorer.exe 即可清除。');
      return 0;
    }
  }

  clearState();
  out('✓ 已停止，桌面已还原');
  return 0;
}

/** 强制结束给定 pid（连同其子进程树）。 */
function killPids(pids) {
  for (const pid of pids) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* 已退出 */ }
    try {
      // 用 spawnSync + inherit：execFile 内部会建管道，在受限环境下抛 EPERM
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore', windowsHide: true,
      });
    } catch { /* 已退出 */ }
  }
}

async function cmdStatus() {
  const st = readState();
  if (!st || !isAlive(st.pid)) {
    clearState();
    // 未运行时也展示最近一次运行的错误摘要（如果有）
    const { latestRun } = await import('./runs.js');
    const last = latestRun();
    out('状态: 未运行');
    if (last?.errorSummary) {
      out('');
      out(`  上次运行失败: ${last.errorSummary.message}`);
      if (last.errorSummary.hint) out(`    提示: ${last.errorSummary.hint}`);
      out(`    运行 ID: ${last.runId}  （cam-to-bg logs ${last.runId} 查看详情）`);
    }
    return 0;
  }
  out('状态: 运行中');
  out(`  进程 PID   ${st.pid}`);
  if (st.runId) out(`  运行 ID   ${st.runId}`);
  out(`  摄像头     ${st.device ?? '—'}`);
  out(`  编码器     ${st.encoder ?? '—'}`);
  if (st.uiUrl) out(`  设置界面   ${st.uiUrl}`);
  if (st.startedAt) {
    const secs = Math.round((Date.now() - st.startedAt) / 1000);
    out(`  已运行     ${Math.floor(secs / 60)} 分 ${secs % 60} 秒`);
  }
  return 0;
}

async function cmdDevices() {
  const env = checkEnvironment();
  if (!env.ffmpegPath) {
    printError(new CamToBgError('未找到 ffmpeg，无法枚举摄像头'));
    return 1;
  }

  out('正在枚举摄像头…\n');
  const devices = await listVideoDevices(env.ffmpegPath);

  if (!devices.length) {
    out('未检测到任何摄像头。');
    out('请确认设备已连接，且未被其他程序独占。');
    return 0;
  }

  out(`找到 ${devices.length} 个视频设备:\n`);
  for (const d of devices) {
    out(`  • ${d.name}`);
    try {
      const formats = await probeDeviceFormats(env.ffmpegPath, d.name);
      if (formats.length) {
        const seen = new Set();
        const summary = formats
          .filter((f) => {
            const k = `${f.width}x${f.height}@${f.fps}`;
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
          })
          .map((f) => `${f.width}x${f.height}@${f.fps}`)
          .join(', ');
        out(`      可用格式: ${summary}`);
      } else {
        out('      （无法读取格式：设备可能被占用或不可访问）');
      }
    } catch {
      out('      （读取格式失败）');
    }
  }
  out('');
  out('用 --device "名称" 或界面里的「摄像头」项指定要用的设备。');
  return 0;
}

async function cmdProbe() {
  out('摄像头壁纸 — 环境检测\n');

  const env = checkEnvironment();
  out('外部依赖:');
  out(`  ffmpeg   ${env.ffmpegPath || '✗ 未找到'}`);
  const mpvPath = env.mpvPath;
  out(`  mpv      ${mpvPath || '✗ 未找到'}`);
  for (const p of env.problems) out(`  ! ${p}`);

  // 权限状态很关键：某些摄像头在非管理员进程下无法被 dshow 绑定
  out('');
  out('运行权限:');
  const elevated = isElevated();
  out(`  管理员权限       ${elevated ? '是' : '否'}`);
  if (!elevated) {
    out('  ! 若某个摄像头报「无法绑定/BindToObject」，很可能是权限不足。');
    out('    可尝试以管理员身份重新运行，或改用 OBS 虚拟摄像头中转。');
  }

  if (process.platform === 'win32') {
    out('');
    out('桌面环境:');
    try {
      const d = await probeDesktop();
      out(`  Progman 句柄     ${d.progman}`);
      out(`  WorkerW 数量     ${d.workerWCount}`);
      out(`  屏幕分辨率       ${d.screen.width}×${d.screen.height}`);
      out(`  显示器数量       ${d.monitors.length}`);
      if (d.host) {
        out(`  壁纸宿主         ${d.host.mode} (hwnd=${d.host.hwnd}, ${d.host.width}×${d.host.height})`);
        if (d.host.mode === 'progman') {
          out('                   （Windows 11 常见情形：Progman 本身就是桌面宿主）');
        } else if (d.host.mode === 'workerw-small') {
          out('  ! 只找到小尺寸 WorkerW，壁纸可能被裁切。可尝试重启 explorer.exe 后重试。');
        }
      }
    } catch (err) {
      out(`  ✗ 探测失败: ${err.message}`);
    }
  }

  if (env.ffmpegPath) {
    out('');
    out('硬件编码器（逐个实测编码一帧）:');
    try {
      const r = await selectEncoder(env.ffmpegPath, { onLog: (m) => out(`  ${m}`) });
      out('');
      out(`  将使用: ${r.encoder.name} — ${r.encoder.label}`);
    } catch (err) {
      out(`  ✗ ${err.message}`);
    }
  }

  out('');
  out(`配置文件: ${configPath()}`);
  return 0;
}

function cmdConfig() {
  const { config, warnings, path } = loadConfig();
  out(`配置文件: ${path}\n`);
  for (const w of warnings) out(`! ${w}`);
  if (warnings.length) out('');
  out(JSON.stringify(config, null, 2));
  return 0;
}

function cmdSet() {
  if (!positionals.length) {
    out('用法: cam-to-bg set <键>=<值> [键=值 ...]');
    out('例如: cam-to-bg set brightness=0.2 fps=60');
    return 1;
  }
  const patch = {};
  for (const pair of positionals) {
    const idx = pair.indexOf('=');
    if (idx < 0) { out(`忽略无效参数: ${pair}`); continue; }
    const k = pair.slice(0, idx);
    const v = pair.slice(idx + 1);
    patch[k] = v;
  }
  const { config: base } = loadConfig();
  const { config, warnings } = mergeConfig(base, patch);
  for (const w of warnings) out(`! ${w}`);
  saveConfig(config);
  out('✓ 已保存');
  out('提示：设置界面里的改动会自动保存；命令行改动需重启实例才生效。');
  return 0;
}

async function cmdRecord() {
  const env = checkEnvironment();
  if (!env.ffmpegPath) {
    printError(new CamToBgError('未找到 ffmpeg，无法录制'));
    return 1;
  }

  const { Recorder, defaultOutputPath, listAudioDevices } = await import('./recorder.js');
  const { selectEncoder } = await import('./encoder-probe.js');
  const { config: cfg } = loadConfig();

  out('屏幕录制\n');

  // 探测编码器
  out('探测编码器…');
  const encResult = await selectEncoder(env.ffmpegPath, { prefer: cfg.encoder !== 'auto' ? cfg.encoder : undefined });
  const encoder = encResult.encoder;
  out(`  使用: ${encoder.name} (${encoder.label})`);

  // 列出音频设备
  out('\n可用麦克风:');
  const audioDevs = await listAudioDevices(env.ffmpegPath);
  if (audioDevs.length) {
    audioDevs.forEach((d, i) => out(`  ${i}: ${d}`));
  } else {
    out('  （无）');
  }

  const audioDevice = cfg.recAudioDevice || (audioDevs[0] || null);
  const outputPath = defaultOutputPath(cfg.recFolder || undefined);

  out(`\n输出文件: ${outputPath}`);
  out(`音频: ${audioDevice || '无'}`);
  out(`帧率: ${cfg.recFps}  码率: ${cfg.recBitrate}Mbps\n`);

  const recorder = new Recorder({
    ffmpegPath: env.ffmpegPath,
    encoder,
    outputPath,
    audioDevice,
    fps: cfg.recFps,
    bitrate: cfg.recBitrate,
    quality: cfg.recQuality,
  });

  recorder.on('log', (m) => out(`  ${m}`));
  recorder.on('exit', (info) => {
    out(`\n录制异常退出 code=${info.code}`);
  });
  recorder.on('finished', (info) => {
    out(`\n✓ 录制完成: ${info.outputPath}`);
  });

  try {
    await recorder.start();
  } catch (err) {
    printError(err);
    return 1;
  }

  out('录制中… 按 Ctrl+C 停止\n');

  const stop = async () => {
    out('\n正在停止录制…');
    try {
      await recorder.stop();
      out(`✓ 已保存到: ${outputPath}`);
    } catch (e) {
      out(`停止失败: ${e.message}`);
    }
    process.exit(0);
  };

  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  await new Promise(() => {});
  return 0;
}

async function cmdLogs() {
  const { listRuns, readRun, readRunLog, parseRunLog, logsDir } = await import('./runs.js');

  const arg = positionals[0];
  const wantLast = flags.has('--last') || flags.has('-l');
  const wantList = !arg && !wantLast;

  if (wantList) {
    const runs = listRuns();
    out(`日志目录: ${logsDir()}\n`);
    if (!runs.length) {
      out('尚无运行记录。');
      return 0;
    }
    out(`共 ${runs.length} 次运行：\n`);
    for (const r of runs) {
      const err = r.errorSummary ? ` [错误: ${r.errorSummary.message}]` : '';
      const end = r.endedAt ? r.endedAt.replace('T', ' ').slice(0, 19) : '进行中';
      out(`  ${r.runId}  ${r.startedAt.replace('T', ' ').slice(0, 19)} → ${end} exit=${r.exitCode ?? '?'}${err}`);
    }
    out('');
    out('查看详情: cam-to-bg logs <runId>  或  cam-to-bg logs --last');
    return 0;
  }

  // 取指定 runId 或最近一次
  const runs = listRuns();
  let target = arg ? readRun(arg) : null;
  if (!target && wantLast) target = runs[0] || null;
  if (!target && !arg) { target = runs[0] || null; }

  if (!target) {
    out(`未找到运行${arg ? `: ${arg}` : ''}。先用 cam-to-bg logs 查看可用运行。`);
    return 1;
  }

  const runId = target.runId;
  out(`=== 运行 ${runId} ===`);
  out(`开始: ${target.startedAt}`);
  out(`结束: ${target.endedAt ?? '（进行中）'}`);
  out(`退出码: ${target.exitCode ?? '?'}`);
  out(`PID: ${target.pid}`);
  out(`目录: ${(await import('./runs.js')).runDir(runId)}`);
  if (target.errorSummary) {
    out(`\n[错误摘要]`);
    out(`  消息: ${target.errorSummary.message}`);
    if (target.errorSummary.code) out(`  代码: ${target.errorSummary.code}`);
    if (target.errorSummary.hint) out(`  提示: ${target.errorSummary.hint}`);
    if (target.errorSummary.stack) out(`  堆栈: ${target.errorSummary.stack}`);
  }
  if (target.config) {
    out(`\n[配置快照]`);
    out(`  ${JSON.stringify(target.config)}`);
  }

  const entries = parseRunLog(readRunLog(runId));
  if (entries.length) {
    out(`\n[日志] ${entries.length} 条`);
    for (const e of entries.slice(-80)) {
      const t = (e.ts || '').slice(11, 19);
      const lvl = (e.level || '?').toUpperCase().padEnd(5);
      const mod = e.module ? `(${e.module})` : '';
      const extra = e.extra && Object.keys(e.extra).length ? ' ' + JSON.stringify(e.extra) : '';
      out(`  ${t} ${lvl}${mod} ${e.msg}${extra}`);
    }
  } else {
    out('\n（无日志条目）');
  }
  return 0;
}

function cmdHelp() {
  out(`摄像头壁纸 (cam-to-bg)

用法:
  cam-to-bg start [--no-ui] [--verbose]   启动壁纸（默认同时开启设置界面）
  cam-to-bg stop                           停止正在运行的实例并还原桌面
  cam-to-bg status                         查看运行状态
  cam-to-bg devices                        列出可用摄像头及其支持格式
  cam-to-bg record                         屏幕录制（画面+麦克风 → MP4）
  cam-to-bg probe                          检测环境、桌面与硬件编码器
  cam-to-bg config                         打印当前配置
  cam-to-bg set k=v ...                    修改配置项
  cam-to-bg logs [runId|--last]            查看运行日志与错误摘要

环境变量:
  CAM_TO_BG_FFMPEG  指定 ffmpeg 路径
  CAM_TO_BG_MPV     指定 mpv 路径
  CAM_TO_BG_HOME    指定配置与状态目录
  CAM_TO_BG_PWSH    指定 PowerShell 7+ 路径
  CAM_TO_BG_DEBUG   出错时打印堆栈
`);
  return 0;
}

const commands = {
  start: cmdStart,
  stop: cmdStop,
  status: cmdStatus,
  devices: cmdDevices,
  record: cmdRecord,
  probe: cmdProbe,
  config: cmdConfig,
  set: cmdSet,
  logs: cmdLogs,
  help: cmdHelp,
};

async function main() {
  const fn = commands[command] || (command ? null : cmdHelp);

  if (!fn) {
    out(`未知命令: ${command}\n`);
    cmdHelp();
    process.exitCode = 1;
    return;
  }

  try {
    const code = await fn();
    process.exitCode = code ?? 0;
  } catch (err) {
    printError(err);
    process.exitCode = 1;
  }
}

main();
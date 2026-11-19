/**
 * recorder.test.js — 录制参数构造测试
 *
 * 重点覆盖：
 *   · gdigrab 区域录制的参数生成（含非法值规范化）
 *   · 音频设备的有无分支
 *   · 各编码器的画质参数映射
 *   · 输出文件名的稳定性
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRecorderArgs, normalizeRegion, clampRegion, defaultOutputPath, resolveVideosDir, recordLockPath, acquireRecordLock, releaseRecordLock } from '../src/recorder.js';
import { ENCODER_CANDIDATES } from '../src/encoder-probe.js';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const AMF = ENCODER_CANDIDATES.find((e) => e.name === 'h264_amf');
const X264 = ENCODER_CANDIDATES.find((e) => e.name === 'libx264');
const NVENC = ENCODER_CANDIDATES.find((e) => e.name === 'h264_nvenc');
const MF = ENCODER_CANDIDATES.find((e) => e.name === 'h264_mf');
const AV1AMF = ENCODER_CANDIDATES.find((e) => e.name === 'av1_amf');

const base = {
  encoder: AMF,
  outputPath: 'C:/tmp/out.mp4',
  audioDevice: null,
  region: null,
  fps: 30,
  bitrate: 10,
  quality: 20,
};

test('normalizeRegion 对 null/非对象返回 null', () => {
  assert.equal(normalizeRegion(null), null);
  assert.equal(normalizeRegion(undefined), null);
  assert.equal(normalizeRegion('x'), null);
  assert.equal(normalizeRegion(123), null);
});

test('normalizeRegion 把宽高取偶数（gdigrab 要求）', () => {
  const r = normalizeRegion({ x: 0, y: 0, w: 641, h: 481 });
  assert.equal(r.w, 642);
  assert.equal(r.h, 482);
});

test('normalizeRegion 保证宽高至少为 2', () => {
  const r = normalizeRegion({ x: 0, y: 0, w: 0, h: -5 });
  assert.ok(r.w >= 2 && r.h >= 2, `实际 ${r.w}x${r.h}`);
});

test('normalizeRegion 把坐标夹到非负', () => {
  const r = normalizeRegion({ x: -100, y: -50, w: 640, h: 480 });
  assert.equal(r.x, 0);
  assert.equal(r.y, 0);
});

test('normalizeRegion 对非法数字回退到安全值', () => {
  const r = normalizeRegion({ x: 'abc', y: null, w: 'x', h: NaN });
  assert.ok(Number.isFinite(r.x) && Number.isFinite(r.y));
  assert.ok(r.w >= 2 && r.h >= 2);
});

/* ────── clampRegion：gdigrab 越界硬约束（offset+size 必须在桌面内） ────── */

const SCREEN = { width: 1920, height: 1080 };

test('clampRegion: 区域在屏幕内时保持不变', () => {
  assert.deepEqual(clampRegion({ x: 100, y: 100, w: 800, h: 600 }, SCREEN),
    { x: 100, y: 100, w: 800, h: 600 });
});

test('clampRegion: 右侧越界 → 左移使 x+w 恰好等于屏宽', () => {
  const r = clampRegion({ x: 1900, y: 0, w: 400, h: 300 }, SCREEN);
  assert.equal(r.x + r.w, 1920, '不得越出右边界');
  assert.equal(r.w, 400);
});

test('clampRegion: 底部越界 → 上移使 y+h 恰好等于屏高', () => {
  const r = clampRegion({ x: 0, y: 1000, w: 200, h: 200 }, SCREEN);
  assert.equal(r.y + r.h, 1080, '不得越出下边界');
});

test('clampRegion: 宽/高超过屏幕 → 缩到屏幕尺寸（保持偶数）', () => {
  const r = clampRegion({ x: 0, y: 0, w: 9999, h: 5000 }, SCREEN);
  assert.equal(r.w, 1920);
  assert.equal(r.h, 1080);
});

test('clampRegion: 奇数屏幕尺寸时向内取偶（不越界）', () => {
  const r = clampRegion({ x: 0, y: 0, w: 3000, h: 2000 }, { width: 1921, height: 1081 });
  assert.equal(r.w % 2, 0);
  assert.equal(r.h % 2, 0);
  assert.ok(r.w <= 1921 && r.h <= 1081);
});

test('clampRegion: 屏幕未知（null）时只做原有规范化', () => {
  const r = clampRegion({ x: -10, y: 0, w: 801, h: 601 }, null);
  assert.deepEqual(r, { x: 0, y: 0, w: 802, h: 602 });
});

test('clampRegion: null 区域 → null', () => {
  assert.equal(clampRegion(null, SCREEN), null);
});

test('不传 region 时录制整个桌面', () => {
  const args = buildRecorderArgs(base);
  assert.ok(args.includes('-f') && args.includes('gdigrab'));
  assert.ok(!args.includes('-offset_x'), '全屏录制不应带偏移');
  assert.ok(!args.includes('-video_size'), '全屏录制不应指定尺寸');
});

test('传 region 时生成偏移与尺寸参数', () => {
  const args = buildRecorderArgs({ ...base, region: { x: 100, y: 200, w: 800, h: 600 } });
  const joined = args.join(' ');
  assert.match(joined, /-offset_x 100/);
  assert.match(joined, /-offset_y 200/);
  assert.match(joined, /-video_size 800x600/);
});

/* ────── 跨进程录制互斥锁（CLI record 与界面 record 不能并发） ────── */

function withTempHome(fn) {
  const base = mkdtempSync(path.join(tmpdir(), 'rec-lock-'));
  const old = process.env.CAM_TO_BG_HOME;
  process.env.CAM_TO_BG_HOME = base;
  try { return fn(base); } finally {
    if (old === undefined) delete process.env.CAM_TO_BG_HOME;
    else process.env.CAM_TO_BG_HOME = old;
    try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
}

test('录制锁：获得后重复获取被拒（持有者存活 = 真在录）', () => {
  withTempHome(() => {
    assert.equal(acquireRecordLock(), true, '首次应获得锁');
    const lock = recordLockPath();
    assert.equal(fs.readFileSync(lock, 'utf8'), String(process.pid), '锁内容应为持有者 pid');
    assert.equal(acquireRecordLock(), false, '持有者存活（自己）→ 第二次必须被拒（防双录）');
    releaseRecordLock();
    assert.ok(!fs.existsSync(lock), '释放后锁文件消失');
    assert.equal(acquireRecordLock(), true, '释放后可再次获得（顺序录制不受阻）');
    releaseRecordLock();
  });
});

test('录制锁：陈旧锁（持有者已死）被抢占', () => {
  withTempHome(() => {
    const lock = recordLockPath();
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, '4294967295', 'utf8'); // 不可能存活的 pid → 崩溃遗留
    assert.equal(acquireRecordLock(), true, '持有者已死的陈旧锁必须被抢占，否则录制永久卡死');
    assert.equal(fs.readFileSync(lock, 'utf8'), String(process.pid), '抢占后持有者应为本进程');
    releaseRecordLock();
  });
});

test('录制锁：release 只删自己的锁（不误删他人）', () => {
  withTempHome(() => {
    const lock = recordLockPath();
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, '4294967294', 'utf8'); // 他人（虽已死，但不是我）
    releaseRecordLock();
    assert.ok(fs.existsSync(lock), '持有者不是自己 → 不得删除');
    // 随后 acquire 会因持有者已死而抢占（与上一测试一致）
    assert.equal(acquireRecordLock(), true);
    releaseRecordLock();
  });
});

test('录制锁：可注入自定义锁路径（recorder-file 单测隔离依赖它）', () => {
  withTempHome(() => {
    const custom = path.join(path.dirname(recordLockPath()), 'custom-test.lock');
    assert.equal(acquireRecordLock(custom), true, '应使用注入的路径而非默认');
    assert.equal(fs.readFileSync(custom, 'utf8'), String(process.pid));
    assert.ok(!fs.existsSync(recordLockPath()), '未给默认路径 → 默认 rec.lock 不应被创建（隔离生效）');
    releaseRecordLock(custom);
    assert.ok(!fs.existsSync(custom), '注入路径应被释放');
    // 默认路径的 acquire/release 仍可用（向后兼容）
    assert.equal(acquireRecordLock(), true);
    releaseRecordLock();
  });
});

test('非法 region 被规范化后再生成参数', () => {
  const args = buildRecorderArgs({ ...base, region: { x: -10, y: 0, w: 801, h: 601 } });
  const joined = args.join(' ');
  assert.match(joined, /-offset_x 0/);
  assert.match(joined, /-video_size 802x602/);
});

test('无音频设备时不生成音频输入与编码参数', () => {
  const args = buildRecorderArgs(base);
  assert.ok(args.includes('-an'), '应显式禁用音频');
  assert.ok(!args.some((a) => a.startsWith('audio=')), '不应有音频输入');
  assert.ok(!args.includes('aac'));
});

test('有音频设备时使用 dshow + AAC', () => {
  const args = buildRecorderArgs({ ...base, audioDevice: '麦克风 (USB)' });
  const joined = args.join(' ');
  assert.match(joined, /-f dshow/);
  assert.match(joined, /audio=麦克风 \(USB\)/);
  assert.match(joined, /-c:a aac/);
  assert.match(joined, /-b:a 192k/);
});

test('音频输入不带 -audio_buffer_size（官方单位=毫秒，32ms 过小会欠载爆音；默认=设备默认）', () => {
  const args = buildRecorderArgs({ ...base, audioDevice: '麦克风 (USB)' });
  assert.ok(!args.includes('-audio_buffer_size'), '历史值 32ms 缓冲过小，录制场景应取设备默认');
});

test('所有实时输入都带 -thread_queue_size 512（官方输入选项，吸收调度抖动防丢帧）', () => {
  const noAudio = buildRecorderArgs({ ...base });
  const i = noAudio.indexOf('-thread_queue_size');
  assert.ok(i >= 0, 'gdigrab 输入应带 thread_queue_size');
  assert.equal(noAudio[i + 1], '512');
  assert.ok(noAudio.indexOf('-i') > i, '输入选项必须位于 -i 之前');

  const withAudio = buildRecorderArgs({ ...base, audioDevice: 'mic' });
  const counts = withAudio.filter((a) => a === '-thread_queue_size').length;
  assert.equal(counts, 2, '视频与音频输入各自都要有');
});

test('AMF 录制映射到 CQP（实测：CBR 下 qp_i/qp_p 无效=画质滑杆空操作）', () => {
  const args = buildRecorderArgs({ ...base, quality: 25 });
  const joined = args.join(' ');
  assert.match(joined, /-rc cqp/);
  assert.match(joined, /-qp_i 25/);
  assert.match(joined, /-qp_p 25/);
  assert.doesNotMatch(joined, /-rc cbr/, 'CBR 下 QP 不生效，必须 CQP');
  assert.match(joined, /-usage transcoding/, '文件场景用官方 transcoding usage');
});

test('NVENC 录制映射到 VBR+CQ（官方：-cq 属 VBR 质量参数，配 cbr 被忽略）', () => {
  const args = buildRecorderArgs({ ...base, encoder: NVENC, quality: 20 });
  const joined = args.join(' ');
  assert.match(joined, /-rc vbr/);
  assert.match(joined, /-cq 20/);
  assert.match(joined, /-tune hq/, '文件场景用 hq 而非壁管的低延迟 tune');
  assert.match(joined, /-b:v 10M/, 'NVENC VBR 以码率为目标');
});

test('AV1-AMF 录制用 qvbr（av1 无 cqp 枚举）+ high_quality usage', () => {
  const args = buildRecorderArgs({ ...base, encoder: AV1AMF, quality: 20 });
  const joined = args.join(' ');
  assert.match(joined, /-rc qvbr/);
  assert.match(joined, /-qvbr_quality_level 20/);
  assert.match(joined, /-usage high_quality/, 'av1_amf 没有 transcoding usage');
  assert.doesNotMatch(joined, /-preanalysis/, 'av1_amf 没有 -preanalysis 官方选项');
});

test('MF 录制走 g_vbr + 目标码率（文件体积可预期）', () => {
  const args = buildRecorderArgs({ ...base, encoder: MF, bitrate: 12 });
  const joined = args.join(' ');
  assert.match(joined, /-rate_control g_vbr/);
  assert.match(joined, /-b:v 12M/);
});

test('libx264 录制：crf 生效、无 -b:v（实测 b:v 被 crf 覆盖）、maxrate 封顶', () => {
  const args = buildRecorderArgs({ ...base, encoder: X264, quality: 18, bitrate: 12.5 });
  const i = args.indexOf('-crf');
  assert.ok(i >= 0 && args[i + 1] === '18');
  assert.ok(!args.includes('-b:v'), '实测 -b:v 会被 -crf 覆盖，不应下发死参数');
  const j = args.indexOf('-maxrate');
  assert.ok(j >= 0 && args[j + 1] === '12.5M', '码率以 maxrate 作为 VBV 上限参与');
});

test('录制不再禁用 B 帧（历史 -bf 0 白损文件压缩率）', () => {
  for (const enc of [AMF, X264, NVENC, MF]) {
    const args = buildRecorderArgs({ ...base, encoder: enc });
    assert.ok(!args.includes('-bf'), `${enc.name} 不应下发 -bf 0`);
  }
});

test('maxDuration → ffmpeg -t 时长安全阀（防长录制吃满磁盘）', () => {
  const args = buildRecorderArgs({ ...base, maxDuration: 300 });
  const i = args.indexOf('-t');
  assert.ok(i >= 0, '应包含 -t');
  assert.equal(args[i + 1], '300');
});

test('maxDuration 缺省/非法时不发 -t（用户可无限录制，靠 Ctrl+C 停）', () => {
  const noDur = buildRecorderArgs(base);
  assert.ok(!noDur.includes('-t'), '不传 maxDuration 不应发 -t');
  const badDur = buildRecorderArgs({ ...base, maxDuration: 'abc' });
  assert.ok(!badDur.includes('-t'), '非法值不应发 -t');
  const zeroDur = buildRecorderArgs({ ...base, maxDuration: 0 });
  assert.ok(!zeroDur.includes('-t'), '0 秒不应发 -t');
});

test('libx264 编码器映射到 crf 参数', () => {
  const args = buildRecorderArgs({ ...base, encoder: X264, quality: 18 });
  const joined = args.join(' ');
  assert.match(joined, /-crf 18/);
});

test('quality=0 合法（最高画质），不能被 || 兜底吞成 23', () => {
  const args = buildRecorderArgs({ ...base, encoder: X264, quality: 0 });
  const joined = args.join(' ');
  assert.match(joined, /-crf 0/);
  assert.doesNotMatch(joined, /-crf 23/);
});

test('输出路径是最后一个参数', () => {
  const args = buildRecorderArgs(base);
  assert.equal(args[args.length - 1], base.outputPath);
});

test('输出带分片 MP4 标志：强杀后仍可播放（修复：moov 不落盘）', () => {
  const args = buildRecorderArgs(base);
  const i = args.indexOf('-movflags');
  assert.ok(i >= 0, '应包含 -movflags');
  assert.equal(args[i + 1], 'frag_keyframe+empty_moov+default_base_moof',
    '必须是分片 MP4：Windows 硬杀 ffmpeg 时普通 MP4 的 moov 不落盘，文件不可播放');
  assert.ok(!args.includes('+faststart'), 'faststart 与分片互斥且无意义（moov 本就在头部）');
});

test('输出带 flush_packets：静态画面下数据滞留 avio 缓冲会导致强杀后文件只剩头', () => {
  const args = buildRecorderArgs(base);
  const i = args.indexOf('-flush_packets');
  assert.ok(i >= 0, '必须 -flush_packets 1（实测：frame=109 时文件仍 28B）');
  assert.equal(args[i + 1], '1');
});

test('不带 -nostdin：停止时要能向 stdin 写 q 优雅收尾', () => {
  const args = buildRecorderArgs(base);
  assert.ok(!args.includes('-nostdin'), '-nostdin 会挡住优雅退出通道');
});

test('GOP 等于帧率（1 秒）：缩短强杀时的分片损失', () => {
  const args = buildRecorderArgs({ ...base, fps: 30 });
  const i = args.indexOf('-g');
  assert.ok(i >= 0);
  assert.equal(args[i + 1], '30');
});

test('像素格式固定为 yuv420p', () => {
  const args = buildRecorderArgs(base);
  const i = args.indexOf('-pix_fmt');
  assert.ok(i >= 0);
  assert.equal(args[i + 1], 'yuv420p');
});

test('NVENC 码率参数正确换算为 M 单位', () => {
  const args = buildRecorderArgs({ ...base, encoder: NVENC, bitrate: 12.5 });
  const joined = args.join(' ');
  assert.match(joined, /-b:v 12\.5M/);
  assert.match(joined, /-maxrate 12\.5M/);
});

test('defaultOutputPath 生成 .mp4 且带毫秒时间戳', () => {
  const p = defaultOutputPath('C:/videos');
  assert.match(p, /\.mp4$/);
  assert.match(p, /cam-to-bg_rec_\d{8}_\d{6}_\d{3}\.mp4$/);
});

test('defaultOutputPath 连续调用绝不重名（历史缺陷：同秒覆盖丢录像）', () => {
  const paths = new Set();
  for (let i = 0; i < 5; i += 1) paths.add(defaultOutputPath('C:/videos'));
  assert.equal(paths.size, 5, '连续 5 次调用应产生 5 个不同路径（毫秒 + 单调递增兜底）');
});

test('defaultOutputPath 自动创建输出目录（目录缺失时 ffmpeg 打开即失败）', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'recdir-'));
  const nested = path.join(base, 'a', 'b', 'rec');
  const p = defaultOutputPath(nested);
  assert.ok(existsSync(nested), `应自动创建目录: ${nested}`);
  assert.ok(p.startsWith(nested));
  rmSync(base, { recursive: true, force: true });
});

test('resolveVideosDir 返回绝对路径（Known Folder MyVideos，失败回退 homedir/Videos）', async () => {
  const dir = await resolveVideosDir();
  assert.ok(path.isAbsolute(dir), `应为绝对路径: ${dir}`);
  assert.match(dir.replace(/\\/g, '/'), /Videos$/, '应指向「视频」文件夹');
});
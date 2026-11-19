/**
 * filters.test.js — 滤镜图生成的单元测试
 *
 * 新设计：色彩滤镜始终出现在链里（即使默认值），
 * 通过 sendcmd 命令文件运行期动态调整参数，不重启 ffmpeg。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildColorFilters,
  buildSendcmdContent,
  buildGeometryFilters,
  buildScaleFilter,
  buildFilterChain,
  buildFfmpegArgs,
  buildInputArgs,
  latencyProfile,
} from '../src/filters.js';
import { ENCODER_CANDIDATES } from '../src/encoder-probe.js';

const TARGET = { width: 1920, height: 1080 };

test('色彩滤镜始终出现在链里（即使默认值）', () => {
  const parts = buildColorFilters({});
  assert.ok(parts.length >= 4, '应至少包含 eq/exposure/colorbalance/hue 四个滤镜');
  assert.ok(parts.some((p) => p.startsWith('eq=')), '应包含 eq');
  assert.ok(parts.some((p) => p.startsWith('exposure=')), '应包含 exposure');
  assert.ok(parts.some((p) => p.startsWith('colorbalance=')), '应包含 colorbalance');
  assert.ok(parts.some((p) => p.startsWith('hue=')), '应包含 hue');
});

test('eq 滤镜带 eval=frame 以支持逐帧求值', () => {
  const parts = buildColorFilters({});
  const eq = parts.find((p) => p.startsWith('eq='));
  assert.ok(eq.includes('eval=frame'), 'eq 需要 eval=frame 让 sendcmd 能动态修改参数');
});

test('sendcmd 命令文件包含所有色彩参数', () => {
  const content = buildSendcmdContent({ brightness: 0.2, contrast: 1.5, exposure: 0.5, hue: 30 });
  assert.match(content, /eq brightness 0\.2/);
  assert.match(content, /eq contrast 1\.5/);
  assert.match(content, /exposure exposure 0\.5/);
  assert.match(content, /hue h 30/);
});

test('sendcmd 命令格式正确（时间 滤镜 命令 值;）', () => {
  const content = buildSendcmdContent({ brightness: 0.1 });
  const lines = content.split('\n');
  assert.ok(lines.every((l) => /^\d+\.\d+\s+\w+\s+\w+\s+[\d.-]+;$/.test(l.trim())),
    '每行应为 "时间 滤镜 命令 值;" 格式');
});

test('sendcmd 色温正值加红减蓝', () => {
  const content = buildSendcmdContent({ temperature: 0.5 });
  assert.match(content, /colorbalance rs 0\.15/);
  assert.match(content, /colorbalance bs -0\.15/);
});

test('sendcmd 色温负值加蓝减红', () => {
  const content = buildSendcmdContent({ temperature: -0.5 });
  assert.match(content, /colorbalance rs -0\.15/);
  assert.match(content, /colorbalance bs 0\.15/);
});

test('sendcmd 曝光值被夹到 -3..3', () => {
  assert.match(buildSendcmdContent({ exposure: 99 }), /exposure exposure 3/);
  assert.match(buildSendcmdContent({ exposure: -99 }), /exposure exposure -3/);
});

test('buildFilterChain 在有 cmdFile 时插入 sendcmd', () => {
  const chain = buildFilterChain({}, TARGET, 'cmd.txt');
  assert.match(chain, /sendcmd=f=cmd\.txt/);
  assert.match(chain, /eq=/);
  assert.match(chain, /format=yuv420p/);
});

test('buildFilterChain 无 cmdFile 时不插入 sendcmd', () => {
  const chain = buildFilterChain({}, TARGET);
  assert.doesNotMatch(chain, /sendcmd/);
});

test('buildFilterChain 中 sendcmd 在色彩滤镜之前', () => {
  const chain = buildFilterChain({}, TARGET, 'cmd.txt');
  const scIdx = chain.indexOf('sendcmd');
  const eqIdx = chain.indexOf('eq=');
  assert.ok(scIdx < eqIdx, 'sendcmd 应在 eq 之前');
});

test('旋转角度映射到正确的 transpose', () => {
  assert.deepEqual(buildGeometryFilters({ rotate: '0' }), []);
  assert.deepEqual(buildGeometryFilters({ rotate: '90' }), ['transpose=1']);
  assert.deepEqual(buildGeometryFilters({ rotate: '180' }), ['transpose=1,transpose=1']);
  assert.deepEqual(buildGeometryFilters({ rotate: '270' }), ['transpose=2']);
});

test('水平翻转产生 hflip', () => {
  assert.deepEqual(buildGeometryFilters({ flipHorizontal: true }), ['hflip']);
});

test('垂直翻转产生 vflip', () => {
  assert.deepEqual(buildGeometryFilters({ flipVertical: true }), ['vflip']);
});

test('水平与垂直翻转可同时启用', () => {
  assert.deepEqual(buildGeometryFilters({ flipHorizontal: true, flipVertical: true }), ['hflip', 'vflip']);
});

test('旧的 mirror 字段仍被识别', () => {
  assert.deepEqual(buildGeometryFilters({ mirror: true }), ['hflip']);
});

test('fill 模式裁切铺满', () => {
  const s = buildScaleFilter({ scaleMode: 'fill' }, TARGET);
  assert.match(s, /force_original_aspect_ratio=increase/);
  assert.match(s, /crop=1920:1080/);
});

test('fit 模式等比缩放并补黑边', () => {
  const s = buildScaleFilter({ scaleMode: 'fit' }, TARGET);
  assert.match(s, /force_original_aspect_ratio=decrease/);
  assert.match(s, /pad=1920:1080/);
});

test('stretch 模式直接拉伸', () => {
  assert.equal(buildScaleFilter({ scaleMode: 'stretch' }, TARGET), 'scale=1920:1080');
});

test('输出尺寸强制为偶数', () => {
  const s = buildScaleFilter({ scaleMode: 'stretch' }, { width: 1921, height: 1081 });
  assert.match(s, /scale=1922:1082/);
});

test('完整滤镜链以 format=yuv420p 收尾', () => {
  const chain = buildFilterChain({}, TARGET, 'cmd.txt');
  assert.ok(chain.endsWith('format=yuv420p'));
});

test('buildFfmpegArgs 传入 cmdFile', () => {
  const amf = ENCODER_CANDIDATES.find((e) => e.name === 'h264_amf');
  const args = buildFfmpegArgs(
    { width: 1920, height: 1080, fps: 30, bitrate: 8, quality: 23 },
    { deviceName: 'cam', encoder: amf, target: TARGET, port: 12345, cmdFileName: 'cmd.txt' },
  );
  const vfIdx = args.indexOf('-vf');
  assert.ok(vfIdx >= 0);
  assert.match(args[vfIdx + 1], /sendcmd/);
  assert.match(args[vfIdx + 1], /eq=/);
});

/* ── 性能优化：色彩/缩放顺序与缩放算法按面积方向选择 ── */

test('放大（采集<屏幕）：先色彩后缩放，缩放用 bilinear', () => {
  const cfg = { width: 1280, height: 720, scaleMode: 'stretch' };
  const chain = buildFilterChain(cfg, { width: 2560, height: 1440 }, 'cmd.txt');
  const eqIdx = chain.indexOf('eq=');
  const scaleIdx = chain.indexOf('scale=');
  assert.ok(eqIdx >= 0 && scaleIdx >= 0);
  assert.ok(eqIdx < scaleIdx, '放大时应先在小图上做色彩再插值');
  assert.match(chain, /scale=2560:1440:flags=bilinear\+accurate_rnd/, '放大用 bilinear（4K 逐像素三次插值是 CPU 热点）');
});

test('缩小（采集>屏幕）：先缩放后色彩，色彩在目标分辨率上算', () => {
  const cfg = { width: 3840, height: 2160, scaleMode: 'stretch' };
  const chain = buildFilterChain(cfg, { width: 1920, height: 1080 }, 'cmd.txt');
  const eqIdx = chain.indexOf('eq=');
  const scaleIdx = chain.indexOf('scale=');
  assert.ok(scaleIdx >= 0 && eqIdx >= 0);
  assert.ok(scaleIdx < eqIdx, '缩小时应先缩到目标分辨率，逐像素色彩运算量按面积摊薄');
  assert.match(chain, /scale=1920:1080:flags=bicubic\+accurate_rnd/, '缩小编码质量优先 bicubic');
});

test('缩小顺序下 sendcmd 仍紧贴色彩滤镜之前（运行期调色契约）', () => {
  const cfg = { width: 3840, height: 2160, scaleMode: 'stretch' };
  const chain = buildFilterChain(cfg, { width: 1920, height: 1080 }, 'cmd.txt');
  const scIdx = chain.indexOf('sendcmd');
  const eqIdx = chain.indexOf('eq=');
  assert.ok(scIdx >= 0 && scIdx < eqIdx, 'sendcmd 必须在 eq 之前');
  assert.ok(chain.endsWith('format=yuv420p'), '仍以 format=yuv420p 收尾');
});

test('来源尺寸未知或与目标相同：不加缩放算法 flags', () => {
  const unknown = buildScaleFilter({}, TARGET);
  assert.doesNotMatch(unknown, /flags=/, '来源未知时不强加算法（保持既有行为）');
  const same = buildScaleFilter({ width: 1920, height: 1080 }, TARGET);
  assert.doesNotMatch(same, /flags=/, '同尺寸无需插值');
});

/* ─────────────── 率控：官方选项表 + 本机实测的行为契约 ─────────────── */

const CFG = { width: 1920, height: 1080, fps: 30, bitrate: 8, quality: 23 };
const enc = (name) => ENCODER_CANDIDATES.find((e) => e.name === name);
const pipe = (name, over = {}) => buildFfmpegArgs(
  { ...CFG, ...over },
  { deviceName: 'cam', encoder: enc(name), target: TARGET, port: 12345, cmdFileName: 'cmd.txt' },
);

test('候选表只带 -c:v：调优归使用方，杜绝 preset/tune 互相覆盖', () => {
  for (const e of ENCODER_CANDIDATES) {
    assert.deepEqual(e.args, ['-c:v', e.name], `${e.name} 的候选参数应只有 -c:v`);
  }
});

test('壁管 AMF 用 CQP（实测 CBR 下 QP 完全无效），且不下发无效/强制降质参数', () => {
  const a = pipe('h264_amf');
  const j = a.join(' ');
  assert.match(j, /-rc cqp/);
  assert.match(j, /-qp_i 23/);
  assert.doesNotMatch(j, /-rc cbr/, 'CBR 下画质滑杆是空操作');
  assert.doesNotMatch(j, /-preanalysis|-vbaq/, '不再强制关闭 AMF 分析特性');
  assert.doesNotMatch(j, /-b:v/, 'CQP 下码率参数不参与');
});

test('壁管 NVENC 用 VBR+CQ 且 -tune 只出现一次（历史 ll 被 ull 覆盖）', () => {
  const j = pipe('h264_nvenc').join(' ');
  assert.match(j, /-rc vbr/, '官方：-cq 属 VBR 质量参数');
  assert.match(j, /-cq 23/);
  assert.match(j, /-tune ull/);
  const tunes = pipe('h264_nvenc').filter((x) => x === '-tune');
  assert.equal(tunes.length, 1, '-tune 不应重复下发');
  const presets = pipe('h264_nvenc').filter((x) => x === '-preset');
  assert.equal(presets.length, 1, '-preset 不应重复下发');
});

test('壁管 av1_nvenc 也有画质分支（历史：该编码器滑杆静默失效）', () => {
  const j = pipe('av1_nvenc').join(' ');
  assert.match(j, /-rc vbr/);
  assert.match(j, /-cq 23/);
});

test('壁管 libx264：crf 生效、无 -b:v 死参数、maxrate 作 VBV 上限', () => {
  const a = pipe('libx264');
  const j = a.join(' ');
  assert.match(j, /-crf 23/);
  assert.ok(!a.includes('-b:v'), '实测 -b:v 被 -crf 覆盖，不应下发');
  assert.match(j, /-maxrate 8M/);
  assert.match(j, /-bufsize 16M/, 'bufsize 应为 2×码率（VBV 更平滑）');
});

test('壁管 av1_amf 用 qvbr（官方无 cqp 枚举）且不带其没有的选项', () => {
  const j = pipe('av1_amf').join(' ');
  assert.match(j, /-rc qvbr/);
  assert.match(j, /-qvbr_quality_level 23/);
  assert.doesNotMatch(j, /-preanalysis|-vbaq/);
});

test('壁管 h264_mf 走质量模式且方向反向映射（实测值越大画质越高）', () => {
  const a = pipe('h264_mf');
  const i = a.indexOf('-rate_control');
  assert.ok(i >= 0, '应包含 -rate_control');
  assert.deepEqual(a.slice(i, i + 4), ['-rate_control', 'quality', '-quality', '55'],
    'q=23 → mfQ=round((1-23/51)*100)=55');
  assert.match(pipe('h264_mf', { quality: 0 }).join(' '), /-quality 100/, '滑杆 0(最好) → MF 100');
  assert.match(pipe('h264_mf', { quality: 51 }).join(' '), /-quality 0/, '滑杆 51(最差) → MF 0');
});

test('壁管 QSV 用 ICQ：不下发 -b:v（历史上与 global_quality 同给、生效模式含糊）', () => {
  const a = pipe('h264_qsv');
  const j = a.join(' ');
  assert.match(j, /-global_quality 23/);
  assert.ok(!a.includes('-b:v'));
});

test('quality 超范围被夹到 0–51（官方各编码器上限）', () => {
  assert.match(pipe('libx264', { quality: 99 }).join(' '), /-crf 51/);
  assert.match(pipe('h264_amf', { quality: -5 }).join(' '), /-qp_i 0/);
});

/* ─────────────── 延迟档位：latencyMode 编码侧兑现 ─────────────── */

test('latencyProfile 三档 B 帧数 + 未知值回退 ultra-low', () => {
  assert.deepEqual(latencyProfile('ultra-low'), { mode: 'ultra-low', bf: 0 });
  assert.deepEqual(latencyProfile('balanced'), { mode: 'balanced', bf: 1 });
  assert.deepEqual(latencyProfile('smooth'), { mode: 'smooth', bf: 2 });
  assert.deepEqual(latencyProfile('nonsense'), { mode: 'ultra-low', bf: 0 });
  assert.deepEqual(latencyProfile(undefined), { mode: 'ultra-low', bf: 0 });
});

test('输入侧带 -thread_queue_size 512 与 -rtbufsize 100M 且位于 -i 之前', () => {
  const a = pipe('libx264');
  const i = a.indexOf('-thread_queue_size');
  assert.ok(i >= 0, 'dshow 输入应带 thread_queue_size');
  assert.equal(a[i + 1], '512');
  assert.ok(a.indexOf('-i') > i, '必须在 -i 之前才作用于该输入');

  const j = a.indexOf('-rtbufsize');
  assert.ok(j >= 0, '1440p+ 下默认 rtbufsize 会触发 real-time buffer too full → frame dropped（真机日志实证）');
  assert.equal(a[j + 1], '100M');
  assert.ok(a.indexOf('-i') > j, '输入选项必须在 -i 之前');
});

test('-framerate 不做四舍五入：29.97 等协商值必须原样下发', () => {
  // Math.round(29.97)=30 会让 dshow 匹配不到该模式（Could not set video options）
  const a = buildInputArgs({ fps: 29.97, width: 1920.4, height: 1080.6 }, 'cam');
  assert.equal(a[a.indexOf('-framerate') + 1], '29.97');
  assert.equal(a[a.indexOf('-video_size') + 1], '1920x1081');
  const b = buildInputArgs({ fps: 30, width: 1920, height: 1080 }, 'cam');
  assert.equal(b[b.indexOf('-framerate') + 1], '30');
});

const bfOf = (name, mode) => {
  const a = pipe(name, { latencyMode: mode });
  return a[a.indexOf('-bf') + 1];
};

test('-bf 随延迟档位变化：ultra-low 0 / balanced 1 / smooth 2', () => {
  assert.equal(bfOf('libx264', 'ultra-low'), '0');
  assert.equal(bfOf('libx264', 'balanced'), '1');
  assert.equal(bfOf('libx264', 'smooth'), '2');
  assert.equal(bfOf('h264_amf', 'smooth'), '2');
  assert.equal(bfOf('libx264', 'nonsense'), '0', '未知档位按最低延迟');
});

test('x264 档位：ultra-low 带 zerolatency；smooth 不带（它会把 bframes 打回0）且 lookahead=15', () => {
  const ultra = pipe('libx264', { latencyMode: 'ultra-low' }).join(' ');
  assert.match(ultra, /-tune zerolatency/);
  assert.match(ultra, /rc-lookahead=0:bframes=0/);

  const smooth = pipe('libx264', { latencyMode: 'smooth' }).join(' ');
  assert.doesNotMatch(smooth, /zerolatency/, 'zerolatency tune 与 B 帧互斥');
  assert.match(smooth, /rc-lookahead=15:bframes=2/);
  assert.match(smooth, /-preset veryfast/, 'smooth 允许稍慢的预设换画质');

  const bal = pipe('libx264', { latencyMode: 'balanced' }).join(' ');
  assert.match(bal, /rc-lookahead=8:bframes=1/);
  assert.doesNotMatch(bal, /zerolatency/);
});

test('NVENC 档位：preset/lookahead 递进，非 ultra-low 不带低延迟 tune', () => {
  const bal = pipe('h264_nvenc', { latencyMode: 'balanced' });
  const balJ = bal.join(' ');
  assert.match(balJ, /-preset p2/);
  assert.match(balJ, /-rc-lookahead 8/);
  assert.ok(!bal.includes('-tune'), '低延迟 tune 会关掉前瞻，与 balanced 冲突');
  assert.ok(!bal.includes('-zerolatency'));

  const smooth = pipe('h264_nvenc', { latencyMode: 'smooth' }).join(' ');
  assert.match(smooth, /-preset p4/);
  assert.match(smooth, /-rc-lookahead 15/);
});

test('AMF-H264 档位：ultra-low=lowlatency+speed；smooth=transcoding+high_quality', () => {
  const ultra = pipe('h264_amf', { latencyMode: 'ultra-low' }).join(' ');
  assert.match(ultra, /-usage lowlatency/);
  assert.match(ultra, /-quality speed/);
  assert.match(ultra, /-latency 0/);

  const smooth = pipe('h264_amf', { latencyMode: 'smooth' }).join(' ');
  assert.match(smooth, /-usage transcoding/, 'smooth 走官方通用转码 profile');
  assert.match(smooth, /-quality high_quality/, 'high_quality 是 h264/hevc/av1 三者枚举交集');
  assert.doesNotMatch(smooth, /-latency 0/, 'smooth 不强推低延迟模式');
});

test('AMF-HEVC smooth 枚举合法（hevc 的 quality 只有 quality/high_quality，无 speed）', () => {
  const smooth = pipe('hevc_amf', { latencyMode: 'smooth' }).join(' ');
  assert.match(smooth, /-usage transcoding/);
  assert.match(smooth, /-quality high_quality/);
  const ultra = pipe('hevc_amf', { latencyMode: 'ultra-low' }).join(' ');
  assert.doesNotMatch(ultra, /-quality speed/, 'hevc_amf 没有 speed 枚举，省略交给驱动');
});

test('AV1-AMF 档位：latency 是 0..3 档位（3=lowest_latency）且无 transcoding usage', () => {
  const ultra = pipe('av1_amf', { latencyMode: 'ultra-low' }).join(' ');
  assert.match(ultra, /-usage lowlatency/);
  assert.match(ultra, /-latency 3/, 'av1 的 latency 枚举：3=lowest_latency');
  assert.doesNotMatch(ultra, /transcoding/, 'av1_amf 没有 transcoding usage');

  const bal = pipe('av1_amf', { latencyMode: 'balanced' }).join(' ');
  assert.doesNotMatch(bal, /-latency 3/, '仅 ultra-low 拉满延迟档');

  const smooth = pipe('av1_amf', { latencyMode: 'smooth' }).join(' ');
  assert.match(smooth, /-usage high_quality/);
  assert.match(smooth, /-quality high_quality/);
});

test('QSV 档位：preset 分析深度 veryfast → faster → medium', () => {
  assert.match(pipe('h264_qsv', { latencyMode: 'ultra-low' }).join(' '), /-preset veryfast/);
  assert.match(pipe('h264_qsv', { latencyMode: 'balanced' }).join(' '), /-preset faster/);
  assert.match(pipe('h264_qsv', { latencyMode: 'smooth' }).join(' '), /-preset medium/);
});

test('缺省（无 latencyMode 字段）按 ultra-low：与历史默认行为一致', () => {
  const a = pipe('libx264'); // CFG 不含 latencyMode
  assert.equal(a[a.indexOf('-bf') + 1], '0');
  assert.match(a.join(' '), /-tune zerolatency/);
});

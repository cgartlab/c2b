/**
 * filters.js — 把配置翻译成 ffmpeg 滤镜图
 *
 * 本文件刻意写成纯函数（无 IO、无副作用），便于单元测试，
 * 也保证"界面参数 → 实际画面效果"的映射可被独立验证。
 */

/** 数字格式化：避免出现 1.0000000000000002 这种浮点噪声。 */
function num(v, digits = 4) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '0';
  const fixed = Number(n.toFixed(digits));
  return String(fixed);
}

/**
 * 构建色彩校正滤镜。
 *
 * 关键设计：色彩参数（亮度/对比度/饱和度/Gamma/曝光/色温/色相）通过
 * sendcmd 命令文件动态控制，运行期改文件内容即可生效，无需重启 ffmpeg。
 *
 * ffmpeg 启动时滤镜图固定为：
 *   sendcmd + eq(默认值) + exposure(默认值) + colorbalance(默认值) + hue(默认值)
 * 运行期通过写命令文件来调整这些滤镜的参数。
 *
 * 注意：ffmpeg 9 的 eq 滤镜没有 exposure 选项，曝光用独立的 exposure 滤镜。
 *
 * @param {object} cfg 当前配置（仅用于判断是否需要这些滤镜，实际值通过命令文件设置）
 * @returns {string[]} 滤镜片段数组
 */
export function buildColorFilters(cfg) {
  // 色彩滤镜始终出现在链里，即使全为默认值。
  // 这样运行期改参数时，滤镜已经就位，sendcmd 能直接下命令。
  return [
    'eq=brightness=0:contrast=1:saturation=1:gamma=1:eval=frame',
    'exposure=exposure=0',
    'colorbalance=rs=0:gs=0:bs=0:rm=0:gm=0:bm=0:rh=0:gh=0:bh=0',
    'hue=h=0',
  ];
}

/**
 * 生成 sendcmd 命令文件的内容。
 *
 * sendcmd 命令格式：时间 滤镜名 命令 值;
 * 时间 0 表示"立即执行"，sendcmd 每帧重新读文件，所以改了就生效。
 *
 * 命令文件被 ffmpeg 读取后，eq/exposure/colorbalance/hue 的参数
 * 会被覆盖为文件里指定的值。
 *
 * @param {object} cfg
 * @returns {string} 命令文件内容
 */
export function buildSendcmdContent(cfg) {
  const brightness = num(Number(cfg.brightness ?? 0));
  const contrast = num(Number(cfg.contrast ?? 1));
  const saturation = num(Number(cfg.saturation ?? 1));
  const gamma = num(Number(cfg.gamma ?? 1));
  const exposure = num(Math.max(-3, Math.min(3, Number(cfg.exposure ?? 0))));
  const hue = num(Number(cfg.hue ?? 0));

  const temperature = Math.max(-1, Math.min(1, Number(cfg.temperature ?? 0)));
  const warm = temperature > 0;
  const tAmount = num(Math.abs(temperature) * 0.3);
  const rs = warm ? tAmount : `-${tAmount}`;
  const bs = warm ? `-${tAmount}` : tAmount;

  // sendcmd 语法：[时间] [滤镜索引或名字] [命令] [参数]=[值];
  // 这里用滤镜名（eq/exposure/colorbalance/hue）作为目标
  const lines = [
    `0.0 eq brightness ${brightness};`,
    `0.0 eq contrast ${contrast};`,
    `0.0 eq saturation ${saturation};`,
    `0.0 eq gamma ${gamma};`,
    `0.0 exposure exposure ${exposure};`,
    `0.0 colorbalance rs ${rs};`,
    `0.0 colorbalance bs ${bs};`,
    `0.0 colorbalance rm ${rs};`,
    `0.0 colorbalance bm ${bs};`,
    `0.0 colorbalance rh ${rs};`,
    `0.0 colorbalance bh ${bs};`,
    `0.0 hue h ${hue};`,
  ];

  return lines.join('\n');
}

/**
 * 构建几何变换滤镜（旋转、水平翻转、垂直翻转）。
 *
 * 顺序：先旋转（会改变宽高），再翻转。
 * 旋转与翻转的组合是等价的数学变换，这里的顺序保证结果可预期：
 * 翻转始终相对"旋转之后的画面"进行，符合用户在界面上的直观理解。
 *
 * 兼容性：早期配置使用单个 mirror 字段表示水平翻转，
 * 这里同时接受 mirror 与 flipHorizontal，避免旧配置失效。
 *
 * @param {object} cfg
 * @returns {string[]}
 */
export function buildGeometryFilters(cfg) {
  const parts = [];
  const rotate = String(cfg.rotate ?? '0');

  if (rotate === '90') parts.push('transpose=1');
  else if (rotate === '180') parts.push('transpose=1,transpose=1');
  else if (rotate === '270') parts.push('transpose=2');

  // 水平翻转（左右镜像）
  const flipH = cfg.flipHorizontal === true || cfg.mirror === true;
  if (flipH) parts.push('hflip');

  // 垂直翻转（上下镜像）
  if (cfg.flipVertical === true) parts.push('vflip');

  return parts;
}

/**
 * 构建缩放到目标分辨率的滤镜。
 *
 * 性能设计（缩放是逐像素热点，算法按方向选择）：
 *  · **放大**（采集 < 屏幕）：用 bilinear。摄像头实时画面要铺满整屏时，
 *    每帧都要对目标分辨率全像素做三次插值（bicubic），4K 下是纯 CPU 热点；
 *    bilinear 成本约省一半以上，对摄像头画面视觉差异可忽略。
 *  · **缩小**（采集 > 屏幕）：用 bicubic+accurate_rnd，质量优先；
 *    缩小时输出像素本来就少，成本天然低。
 *  · 尺寸相同/来源未知：不加 flags（scale 退化为近乎零成本的拷贝）。
 *
 * @param {object} cfg
 * @param {{width:number, height:number}} target 输出尺寸（通常是屏幕分辨率）
 * @returns {string|null}
 */
export function buildScaleFilter(cfg, target) {
  const tw = Math.max(2, Math.round(target.width));
  const th = Math.max(2, Math.round(target.height));
  const mode = cfg.scaleMode || 'fill';

  // 宽高都取偶数，规避 yuv420p 的奇数尺寸问题
  const even = (n) => {
    const v = Math.max(2, Math.round(n));
    return v % 2 === 0 ? v : v + 1;
  };

  // 方向判定：来源面积 vs 目标面积（面积在旋转下不变，忽略 transpose 影响）
  const srcW = Math.round(Number(cfg.width) || 0);
  const srcH = Math.round(Number(cfg.height) || 0);
  let flags = '';
  if (srcW > 0 && srcH > 0) {
    const srcArea = srcW * srcH;
    const dstArea = even(tw) * even(th);
    if (srcArea < dstArea) flags = ':flags=bilinear+accurate_rnd';
    else if (srcArea > dstArea) flags = ':flags=bicubic+accurate_rnd+full_chroma_int';
  }

  if (mode === 'stretch') {
    return `scale=${even(tw)}:${even(th)}${flags}`;
  }

  if (mode === 'fit') {
    // 等比缩放至完全装入，再用黑边补齐
    return `scale=${even(tw)}:${even(th)}:force_original_aspect_ratio=decrease${flags},`
      + `pad=${even(tw)}:${even(th)}:(ow-iw)/2:(oh-ih)/2:color=black`;
  }

  // fill（默认）：等比放大到覆盖整个画面，再多余部分居中裁掉
  return `scale=${even(tw)}:${even(th)}:force_original_aspect_ratio=increase${flags},`
    + `crop=${even(tw)}:${even(th)}`;
}

/**
 * 组装完整的 -vf 滤镜串。
 *
 * 结构：几何变换(旋转/翻转) → [可选先缩放] → sendcmd → 色彩 → [可选后缩放] → 格式
 *
 * 色彩与缩放的先后按面积择优（性能关键项，逐像素运算应发生在更小的那张图上）：
 *  · 采集 ≥ 屏幕（缩小）：**先缩后色** —— eq/colorbalance/hue 在目标分辨率上算，
 *    每帧运算面积从采集面积降到屏幕面积；
 *  · 采集 < 屏幕（放大）：**先色后缩**（原顺序）—— 色彩在小图上算完再插值放大，
 *    避免在放大后的图上做逐像素运算。
 * 两种顺序下 sendcmd 都紧贴在色彩滤镜之前——这是运行期调色的契约，不可破坏。
 *
 * sendcmd 从命令文件读取色彩参数，运行期改文件即可动态调整，
 * 无需重启 ffmpeg（这是避免死机的核心设计）。
 *
 * ⚠️ cmdFile 必须是**不含路径分隔符的纯文件名**。
 * 原因：ffmpeg 的滤镜参数以 `:` 分隔，而 Windows 绝对路径形如 `C:/x/y.txt`，
 * 其中的冒号会被解析成"下一个选项名"，导致：
 *     No option name near '/x/y.txt'
 *     Error parsing a filter description
 * 实测绝对路径（正/反斜杠、转义冒号）全部失败，只有纯文件名可用。
 * 因此调用方需把 ffmpeg 的工作目录设为该文件所在目录（见 pipeline.js）。
 *
 * @param {object} cfg 配置
 * @param {{width:number, height:number}} target 输出分辨率（屏幕）
 * @param {string} [cmdFileName] sendcmd 命令文件的**文件名**（不含目录）
 * @returns {string} 滤镜串
 */
export function buildFilterChain(cfg, target, cmdFileName) {
  // 色彩段（sendcmd 紧贴其前）
  const colorSeg = [...buildColorFilters(cfg)];
  if (cmdFileName) colorSeg.unshift(`sendcmd=f=${cmdFileName}`);

  const scale = buildScaleFilter(cfg, target);

  // 面积择优（见函数头说明）
  const srcW = Math.round(Number(cfg.width) || 0);
  const srcH = Math.round(Number(cfg.height) || 0);
  const srcArea = srcW * srcH;
  const dstArea = Math.round(target.width) * Math.round(target.height);
  const scaleFirst = !!scale && srcArea > dstArea;

  const parts = [...buildGeometryFilters(cfg)];
  if (scaleFirst) parts.push(scale);
  parts.push(...colorSeg);
  if (scale && !scaleFirst) parts.push(scale);

  parts.push('format=yuv420p');

  return parts.join(',');
}

/**
 * 构建 ffmpeg 输入参数（dshow 采集）。
 *
 * `-thread_queue_size` 是官方通用输入选项（"set the maximum number of queued
 * packets from the demuxer"）：实时源默认队列很小，一次 GC/调度抖动就可能
 * 溢出丢帧。调大只影响"卡顿时能缓冲多少"，稳态下队列近空、不增加延迟。
 *
 * `-framerate` **不做四舍五入**：设备协商可能给出 29.97/59.94 这类非整数
 * 帧率（NTSC 体系），Math.round(29.97)=30 会让 dshow 匹配不到该模式而报
 * "Could not set video options"。官方 dshow 的 -framerate 是字符串、经
 * av_parse_video_rate 解析，小数原样传即可与设备上报值精确对上。
 *
 * @param {object} cfg
 * @param {string} deviceName
 */
export function buildInputArgs(cfg, deviceName) {
  const args = [
    '-f', 'dshow',
    '-thread_queue_size', '512',
    // 实时采集缓冲（官方 AVFormat 输入选项，实测可接受、对照 bogus 选项会报
    // Unrecognized option）：ffmpeg 默认值按小分辨率标定，1440p/4K 下会触发
    // "real-time buffer ... too full → frame dropped!"（真机日志实证：
    // OBS 虚拟摄像头 2560x1440 录制期间出现，181% of rtbufsize）。
    // 100M ≈ 可吸收十余帧的消费端抖动；环形缓冲按需增长，稳态不占满。
    '-rtbufsize', '100M',
    '-framerate', String(cfg.fps),
    '-video_size', `${Math.round(cfg.width)}x${Math.round(cfg.height)}`,
    '-i', `video=${deviceName}`,
  ];
  return args;
}

/**
 * 按延迟模式换算编码侧档位。
 *
 * 历史缺陷：`latencyMode` 只作用于 mpv 渲染侧，编码端恒为最低延迟档
 *（bframes=0、lookahead=0）——配置项承诺的"balanced 折中 / smooth 优先流畅"
 * 在编码端完全没兑现。这里按官方参数语义把三档落到实处：
 *
 *   档位      B帧   x264/x265 lookahead   NVENC preset/lookahead   AMF usage
 *   ultra-low  0    0（+zerolatency tune） p1 + ull + delay 0        lowlatency(+speed)
 *   balanced   1    8（无 zerolatency）    p2 + rc-lookahead 8      lowlatency
 *   smooth     2    15（≈0.5s，平滑缓冲）  p4 + rc-lookahead 15     transcoding+high_quality
 *
 * 注意各编码器同名选项枚举不通用（已按 `ffmpeg -h encoder=` 官方表核对）：
 *   · `-quality`：h264_amf 有 speed/balanced/quality/high_quality；
 *     hevc_amf 只有 quality/high_quality；av1_amf 只有 high_quality/quality。
 *     因此只有 **high_quality 是三者交集**，smooth 档统一用它；
 *     ultra-low 档仅 h264_amf 用 speed，hevc/av1 省略交给驱动默认。
 *   · AMF `-usage`：transcoding 存在于 h264/hevc，av1 没有（av1 用 high_quality）。
 *   · av1_amf `-latency` 是 0..3 的档位（3=lowest_latency），不是布尔。
 *
 * @param {string} mode cfg.latencyMode
 * @returns {{mode:string, bf:number}}
 */
export function latencyProfile(mode) {
  if (mode === 'balanced') return { mode: 'balanced', bf: 1 };
  if (mode === 'smooth') return { mode: 'smooth', bf: 2 };
  return { mode: 'ultra-low', bf: 0 }; // 未知/缺省一律最低延迟
}

/**
 * 构建完整的 ffmpeg 参数字符串数组（壁管实时管线）。
 *
 * ── 率控设计（依据官方选项表与本机实测，见各分支注释） ──
 * 官方选项表来源：`ffmpeg -h encoder=<name>`（本机 ffmpeg 9.0.1 构建）。
 * 核心原则：**画质滑块（quality，0=最好）必须真实生效**，
 * 码率（bitrate）在该编码器的官方语义允许时作为上限/目标。
 *
 * @param {object} cfg 规范化后的配置
 * @param {object} ctx
 * @param {string} ctx.deviceName 摄像头名称
 * @param {object} ctx.encoder ENCODER_CANDIDATES 中的一项
 * @param {{width:number,height:number}} ctx.target 输出分辨率
 * @param {number} ctx.port 本地回环端口
 * @returns {string[]}
 */
export function buildFfmpegArgs(cfg, ctx) {
  const { deviceName, encoder, target, port, cmdFileName } = ctx;
  const mb = Math.max(0.5, Number(cfg.bitrate) || 8);
  const rate = `${mb}M`;
  const buf = `${mb * 2}M`;

  // 画质滑块：0–51（允许 0，不能用 || 兜底）
  const rawQ = Number(cfg.quality);
  const q = Number.isFinite(rawQ) ? Math.min(51, Math.max(0, Math.round(rawQ))) : null;

  // 延迟档位（编码侧，见 latencyProfile 的档位表）
  const prof = latencyProfile(cfg.latencyMode);

  const args = [
    '-hide_banner',
    '-loglevel', 'warning',
    '-nostdin',
    ...buildInputArgs(cfg, deviceName),
    '-vf', buildFilterChain(cfg, target, cmdFileName),
    ...encoder.args,
    '-g', String(Math.max(1, Math.round(Number(cfg.fps) || 30))),
    '-bf', String(prof.bf),
  ];

  if (q !== null) {
    if (encoder.name === 'libx264') {
      // 官方"受限质量"惯用法：-crf + -maxrate + -bufsize（**不带 -b:v**）。
      // 实测：同时给 -crf 与 -b:v 时产物与纯 -crf 完全一致（b:v 被忽略）。
      args.push('-crf', String(q), '-maxrate', rate, '-bufsize', buf, '-preset',
        prof.mode === 'smooth' ? 'veryfast' : 'ultrafast');
      if (prof.mode === 'ultra-low') {
        // zerolatency tune 会强制 bframes=0，与 bf=0 一致
        args.push('-tune', 'zerolatency',
          '-x264-params', 'sync-lookahead=0:rc-lookahead=0:bframes=0');
      } else {
        // 非 ultra-low 不能带 zerolatency（它会把 bframes 打回 0）
        const la = prof.mode === 'smooth' ? 15 : 8;
        args.push('-x264-params', `sync-lookahead=0:rc-lookahead=${la}:bframes=${prof.bf}`);
      }
    } else if (encoder.name === 'libx265') {
      args.push('-crf', String(q), '-maxrate', rate, '-bufsize', buf, '-preset',
        prof.mode === 'smooth' ? 'veryfast' : 'ultrafast');
      if (prof.mode === 'ultra-low') {
        args.push('-tune', 'zerolatency', '-x265-params', 'bframes=0:rc-lookahead=0');
      } else {
        const la = prof.mode === 'smooth' ? 15 : 8;
        args.push('-x265-params', `bframes=${prof.bf}:rc-lookahead=${la}`);
      }
    } else if (encoder.name === 'h264_amf' || encoder.name === 'hevc_amf') {
      // CQP 画质优先（实证见上一轮：CBR 下 qp 无效）。
      // 档位经 usage/quality/latency 体现：三者的枚举各不相同，逐一按官方表核对。
      args.push('-rc', 'cqp', '-qp_i', String(q), '-qp_p', String(q));
      if (prof.mode === 'smooth') {
        args.push('-usage', 'transcoding', '-quality', 'high_quality'); // 两者枚举 hevc/h264 均有
      } else {
        args.push('-usage', 'lowlatency', '-latency', '0');
        if (encoder.name === 'h264_amf') args.push('-quality', 'speed');
        // hevc_amf 的 -quality 枚举只有 quality/high_quality，省略交给驱动默认
      }
    } else if (encoder.name === 'h264_nvenc' || encoder.name === 'hevc_nvenc'
      || encoder.name === 'av1_nvenc') {
      // 官方：-cq 属 VBR 质量参数；档位由 preset + rc-lookahead 体现。
      // 非 ultra-low 不带 -tune/-zerolatency/-delay：低延迟 tune 会关掉
      // 前瞻与 B 帧，与 balanced/smooth 的目标冲突。
      args.push('-rc', 'vbr', '-cq', String(q),
        '-b:v', rate, '-maxrate', rate, '-bufsize', buf);
      if (prof.mode === 'ultra-low') {
        args.push('-preset', 'p1', '-tune', 'ull',
          '-zerolatency', '1', '-delay', '0', '-rc-lookahead', '0');
      } else if (prof.mode === 'balanced') {
        args.push('-preset', 'p2', '-rc-lookahead', '8');
      } else {
        args.push('-preset', 'p4', '-rc-lookahead', '15');
      }
    } else if (encoder.name === 'h264_qsv' || encoder.name === 'hevc_qsv') {
      // ICQ 质量模式；档位由 preset（分析深度）体现。
      // 官方 preset 序：veryfast(7) > faster(6) > fast(5) > medium(4)…
      const qpreset = prof.mode === 'smooth' ? 'medium'
        : prof.mode === 'balanced' ? 'faster' : 'veryfast';
      args.push('-global_quality', String(q), '-preset', qpreset);
    } else if (encoder.name === 'av1_amf') {
      // av1 无 cqp 枚举 → qvbr；无 transcoding usage → high_quality；
      // -latency 是 0..3 档位（3=lowest_latency），仅 ultra-low 拉满。
      args.push('-rc', 'qvbr', '-qvbr_quality_level', String(q),
        '-b:v', rate, '-maxrate', rate, '-bufsize', buf);
      if (prof.mode === 'smooth') {
        args.push('-usage', 'high_quality', '-quality', 'high_quality');
      } else {
        args.push('-usage', 'lowlatency');
        if (prof.mode === 'ultra-low') args.push('-latency', '3');
      }
    } else if (encoder.name === 'h264_mf') {
      // 官方 -rate_control quality；-quality 0–100 值越大画质越高（实测），
      // 滑杆 0=最好 → 反向映射。档位交给通用 -bf。
      const mfQ = Math.round((1 - q / 51) * 100);
      args.push('-rate_control', 'quality', '-quality', String(mfQ));
    } else {
      // 未知编码器：只给通用码率，至少能跑
      args.push('-b:v', rate, '-maxrate', rate, '-bufsize', buf);
    }
  } else {
    // quality 非法时的兜底：纯码率模式
    args.push('-b:v', rate, '-maxrate', rate, '-bufsize', buf);
  }

  args.push('-flush_packets', '1', '-muxdelay', '0', '-muxpreload', '0',
    '-f', 'mpegts', `tcp://127.0.0.1:${port}?listen=1`);

  return args;
}
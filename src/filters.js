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

  if (mode === 'stretch') {
    return `scale=${even(tw)}:${even(th)}`;
  }

  if (mode === 'fit') {
    // 等比缩放至完全装入，再用黑边补齐
    return `scale=${even(tw)}:${even(th)}:force_original_aspect_ratio=decrease,`
      + `pad=${even(tw)}:${even(th)}:(ow-iw)/2:(oh-ih)/2:color=black`;
  }

  // fill（默认）：等比放大到覆盖整个画面，再多余部分居中裁掉
  return `scale=${even(tw)}:${even(th)}:force_original_aspect_ratio=increase,`
    + `crop=${even(tw)}:${even(th)}`;
}

/**
 * 组装完整的 -vf 滤镜串。
 *
 * 结构：几何变换(旋转/翻转) → sendcmd → 色彩(eq/exposure/colorbalance/hue) → 缩放 → 格式
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
  const parts = [...buildColorFilters(cfg)];

  // 在色彩滤镜最前面插入 sendcmd。
  // sendcmd 每帧重新读文件，改文件内容就能实时调整色彩参数。
  if (cmdFileName) {
    parts.unshift(`sendcmd=f=${cmdFileName}`);
  }

  // 几何变换在色彩之前
  parts.unshift(...buildGeometryFilters(cfg));

  const scale = buildScaleFilter(cfg, target);
  if (scale) parts.push(scale);

  parts.push('format=yuv420p');

  return parts.join(',');
}

/**
 * 构建 ffmpeg 输入参数（dshow 采集）。
 * @param {object} cfg
 * @param {string} deviceName
 */
export function buildInputArgs(cfg, deviceName) {
  const args = [
    '-f', 'dshow',
    '-framerate', String(Math.round(cfg.fps)),
    '-video_size', `${Math.round(cfg.width)}x${Math.round(cfg.height)}`,
    '-i', `video=${deviceName}`,
  ];
  return args;
}

/**
 * 构建完整的 ffmpeg 参数字符串数组。
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
  const bitrate = `${Math.max(0.1, Number(cfg.bitrate) || 8)}M`;

  const args = [
    '-hide_banner',
    '-loglevel', 'warning',
    '-nostdin',
    ...buildInputArgs(cfg, deviceName),
    '-vf', buildFilterChain(cfg, target, cmdFileName),
    ...encoder.args,
    '-b:v', bitrate,
    '-maxrate', bitrate,
    '-bufsize', `${Math.max(0.5, Number(cfg.bitrate) || 8)}M`,
    '-g', String(Math.max(1, Math.round(Number(cfg.fps) || 30))),
    '-bf', '0',
  ];

  // 各编码器的画质/低延迟参数
  const q = Number(cfg.quality);
  if (Number.isFinite(q)) {
    if (encoder.name === 'libx264') {
      args.push('-crf', String(Math.round(q)),
        '-preset', 'ultrafast', '-tune', 'zerolatency',
        '-x264-params', 'sync-lookahead=0:rc-lookahead=0:bframes=0');
    } else if (encoder.name === 'h264_amf' || encoder.name === 'hevc_amf') {
      args.push('-rc', 'cbr', '-qp_i', String(Math.round(q)), '-qp_p', String(Math.round(q)),
        '-latency', '0', '-preanalysis', 'false', '-vbaq', 'false');
    } else if (encoder.name === 'h264_nvenc' || encoder.name === 'hevc_nvenc') {
      args.push('-rc', 'cbr', '-cq', String(Math.round(q)),
        '-preset', 'p1', '-tune', 'ull', '-zerolatency', '1', '-delay', '0', '-rc-lookahead', '0');
    } else if (encoder.name === 'h264_qsv' || encoder.name === 'hevc_qsv') {
      args.push('-global_quality', String(Math.round(q)), '-preset', 'veryfast', '-low_power', '1');
    } else if (encoder.name === 'av1_amf') {
      args.push('-rc', 'cbr', '-qp_i', String(Math.round(q)), '-qp_p', String(Math.round(q)),
        '-preanalysis', 'false', '-vbaq', 'false');
    } else if (encoder.name === 'libx265') {
      args.push('-crf', String(Math.round(q)),
        '-preset', 'ultrafast', '-tune', 'zerolatency',
        '-x265-params', 'bframes=0:rc-lookahead=0');
    }
  }

  args.push('-flush_packets', '1', '-muxdelay', '0', '-muxpreload', '0',
    '-f', 'mpegts', `tcp://127.0.0.1:${port}?listen=1`);

  return args;
}
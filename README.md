# C2B (Cam To Background) — 把摄像头画面变成 Windows 桌面壁纸

用 Node.js 把摄像头实时画面作为桌面背景（在桌面图标**之下**），
全程走 GPU 硬件加速，并提供一个本地设置界面，可随时调整色彩、曝光、帧率、码率等参数。

> **C2B = Cam To Background**。项目同时提供屏幕录制功能。

---

## 快速开始

```bash
npm start            # 启动壁纸（同时打开设置界面）
npm run devices      # 列出可用摄像头
npm run probe        # 检测环境、权限、桌面与硬件编码器
npm stop             # 停止并还原桌面
npm test             # 运行单元测试
```

启动后设置界面会自动打开：**http://127.0.0.1:5757/**

按下 `Ctrl+C` 会优雅退出并**还原桌面**，不会留下残留窗口或进程。

---

## 工作原理

```
摄像头 ──dshow──► ffmpeg ──滤镜(色彩/曝光/缩放)──► 硬件编码(AMF) ──TCP──► mpv ──GPU渲染──► 桌面壁纸层
```

关键点在于**最后一步如何把视频窗口变成壁纸**：

1. mpv 先创建一个普通窗口（标题固定为 `cam-to-bg`）
2. 通过 Win32 `EnumWindows` 按标题找到该窗口句柄
3. **把窗口样式从 `WS_POPUP` 改为 `WS_CHILD`**（这一步至关重要，见下文"踩坑记录"）
4. 用 `SetParent` 把窗口挂到桌面宿主窗口下
5. 用 `SetWindowPos` 把窗口铺满整个屏幕

---

## 实测验证记录

以下结论均在本机（Windows 11 build 26200 / AMD Radeon 集显 / ffmpeg 9.0.1 / mpv 0.41.0）实测得出，
不是照搬文档。

| 项目 | 实测结果 |
|---|---|
| 硬件编码器 | `h264_amf`（AMD 硬件编码），逐个真实编码一帧验证通过 |
| 备选编码器 | `h264_mf`、`libx264` 均可作为回退 |
| 桌面宿主窗口 | **Progman (2560×1440)**，非 WorkerW |
| mpv 渲染 | `vo=gpu-next` + `gpu-api=d3d11` + `hwdec=auto-safe` |
| 挂载验证 | mpv 窗口 `parent=65988 (Progman)`、`visible=true`、`rect=0,0,2560,1440` |
| 管线延迟 | 连接 120ms + 缓冲跨度 277ms；mpv 侧缓冲从默认 150MiB 压到 1MiB |

---

## 踩坑记录（这些是本项目的核心价值）

### 1. WorkerW 在 Windows 11 上不是壁纸宿主

网上绝大多数"动态壁纸"教程都教：给 Progman 发 `0x052C`，
然后找一个"不含 `SHELLDLL_DefView` 的 WorkerW"挂上去。

**在本机实测，这条路走不通**：系统里 15 个 WorkerW **全部只有 136×39 且不可见**，
它们是系统内部的小 helper 窗口，根本不是壁纸层。
真正的桌面宿主是 **Progman**（2560×1440、可见、含 `SHELLDLL_DefView`）。

因此本工具按"谁真的承载桌面"来选择宿主：优先找**尺寸接近屏幕**且不含 DefView 的 WorkerW
（Win10 经典情形），找不到则回退到 Progman（Win11 情形），并跳过所有小尺寸窗口。
若不做尺寸判断，把视频挂到 136×39 的窗口上，即使 `SetParent` 成功也只会被裁成一小块。

### 2. SetParent 对 mpv 窗口"返回成功但实际无效"

mpv 创建的是 `WS_POPUP` 风格的顶层窗口。对这种窗口调用 `SetParent`：

- 返回值非 0（成功）
- `GetLastWin32Error()` = 0（无错误）
- 但 `GetParent()` 仍返回 0 —— **父子关系并没有真正建立**，桌面也不会有任何变化

**修复**：在 `SetParent` 之前，先用 `SetWindowLong` 去掉 `WS_POPUP`、加上 `WS_CHILD`。
改完之后 `GetParent()` 立刻返回 Progman 句柄，画面正常显示。

这个问题极难排查，因为所有 API 都"成功"了。

### 3. 受限沙箱下的三个适配

本项目最初在受限沙箱环境中开发，遇到并解决了三个真实限制（这些适配在沙箱外同样兼容）：

**a) 管道 stdio 会抛 EPERM**
`execFile` / `exec` **即使传 `stdio:'ignore'` 也会在内部创建管道**，直接抛 `EPERM`。
只有 `spawn` 配 `stdio:'inherit'` 可用。
因此所有需要捕获输出的子进程调用（ffmpeg 探测、mpv 版本查询）都改为
**把输出重定向到文件再读文件**，完全绕开管道。

**b) Node 无法访问命名管道**
mpv 官方的运行期控制方式是 `--input-ipc-server`（命名管道），
但实测 `net.connect` 与 `fs.openSync` 访问命名管道都返回 `EPERM`；
而该选项在 Windows 上只支持命名管道、不支持 TCP。

因此本工具**不依赖 mpv IPC**，改用：
- 画面类参数（色彩/曝光/缩放）→ 只重启 **ffmpeg**，mpv 与桌面挂载完全不动，画面不闪断
- 结构类参数（分辨率/帧率/编码器）→ 整条管线重启

**c) PowerShell 5.1 会误读 UTF-8 中文脚本**
`win32.ps1` 含中文注释且为无 BOM 的 UTF-8。用 `powershell.exe`（5.1）执行会因按 ANSI 解析而报语法错误。
**必须使用 `pwsh`（PowerShell 7+）**。程序会自动查找 pwsh。

### 4. 摄像头的 DirectShow 接口可能需要管理员权限

实测中遇到过一个 USB 摄像头能被系统枚举、但 ffmpeg 报：

```
Unable to BindToObject for <设备名>
Could not find video device with name [...] among source devices of type video.
```

同一命令**提权后立即成功**（exit=0）。这属于权限问题而非驱动问题。
`npm run probe` 会显示当前是否为管理员权限，并在相机打不开时给出对应提示。

### 5. eq 滤镜没有 exposure 参数

ffmpeg 的 `eq` 滤镜**不支持** `exposure`，传了会报 `Option not found`。
曝光必须使用独立的 `exposure` 滤镜（取值范围 -3..3）。

---

## 参数说明

设置界面里的控件由后端 schema 自动生成（见 `src/config.js`），
因此前后端参数定义不会漂移。主要参数：

### 画面
| 参数 | 说明 |
|---|---|
| 帧率 | 摄像头采集与输出帧率（1–120） |
| 缩放模式 | `fill` 裁切铺满 / `fit` 留黑边 / `stretch` 拉伸 |
| **水平翻转** | 左右镜像（`hflip`）。摄像头画面与真人方向相反时使用 |
| **垂直翻转** | 上下镜像（`vflip`）。摄像头倒装时使用 |
| 旋转 | 0 / 90 / 180 / 270 |

水平与垂直翻转是两个**独立开关**，可同时启用（`hflip,vflip`，等价于旋转 180°）。
执行顺序为「先旋转、再翻转」，即翻转始终相对旋转后的画面进行。

> 兼容性：早期版本的 `mirror` 字段会自动迁移为 `flipHorizontal`，旧配置无需手工修改。

### 色彩
亮度、对比度、饱和度、Gamma、**曝光**、色温（冷暖）、色相。
全部通过 ffmpeg 滤镜实时生效，**不需要重启 mpv**，因此画面不会闪断。

### 编码
| 参数 | 说明 |
|---|---|
| 码率 (Mbps) | 本地回环带宽与画质 |
| 编码器 | `auto` 会自动挑选可用的硬件编码器 |
| 画质 | 越小越好；硬件编码器下映射为 CQ/QP，x264 下为 CRF |

### 延迟
| 模式 | 缓冲策略 | 适用场景 |
|---|---|---|
| `ultra-low`（默认） | 缓冲 1MiB，关闭解码队列，落后立即丢帧 | 追求最低延迟 |
| `balanced` | 缓冲 6MiB，允许丢帧 | 折中 |
| `smooth` | 缓冲 16MiB，禁止丢帧 | 优先画面连续 |

延迟优化的具体做法（均已实测生效）：
- mpv 侧：`--video-sync=desync`、`--untimed=yes`、`--cache=no`、
  `--demuxer-readahead-secs=0`、`--demuxer-max-bytes=1MiB`（默认是 **150MiB**）、
  `--vd-queue-enable=no`、`--framedrop=decoder+vo`、`--video-latency-hacks=yes`
- ffmpeg 侧：`-usage lowlatency`、`-latency 0`、`-preanalysis false`、`-vbaq false`、
  `-bf 0`（无 B 帧）、`-g` 缩短到 1 秒、`-bufsize` 压到 1 倍码率、
  `-flush_packets 1`、`-muxdelay 0`、`-muxpreload 0`

其中 **`--video-sync=audio` 是必须改掉的默认值**：
本管线是 `--no-audio` 的纯视频流，让画面去追一个不存在的音频时钟会导致 mpv 持续缓冲、越积越慢。

---

## 命令行

```bash
cam-to-bg start [--no-ui] [--verbose]   # 启动
cam-to-bg stop                          # 停止并还原桌面
cam-to-bg status                        # 查看运行状态
cam-to-bg devices                       # 列出摄像头及其支持格式
cam-to-bg probe                         # 环境/权限/桌面/编码器检测
cam-to-bg config                        # 打印当前配置
cam-to-bg set <键>=<值> ...              # 修改配置
```

### 环境变量
| 变量 | 用途 |
|---|---|
| `CAM_TO_BG_FFMPEG` | 指定 ffmpeg 路径 |
| `CAM_TO_BG_MPV` | 指定 mpv 路径 |
| `CAM_TO_BG_HOME` | 配置与状态目录（默认 `~/.cam-to-bg`） |
| `CAM_TO_BG_PWSH` | 指定 PowerShell 7+ 路径 |
| `CAM_TO_BG_DEBUG` | 出错时打印堆栈 |

---

## 依赖

- **Node.js ≥ 20**（无任何第三方 npm 依赖）
- **ffmpeg**（需含 dshow 输入与硬件编码器）：`winget install Gyan.FFmpeg`
- **mpv 0.37+**：`winget install mpv.net` 或从 mpv.io 下载
- **PowerShell 7+**（用于 Win32 调用）：`winget install Microsoft.PowerShell`

---

## 实现说明

**为什么用 ffmpeg + mpv，而不是原生模块？**
本机没有 Visual Studio Build Tools，`node-gyp` 原生编译不可用。
因此架构刻意绕开一切需要现场编译的方案，改为编排已安装的二进制。
好处是零 npm 依赖、安装即用；代价是多两个外部程序依赖。

**为什么不做零拷贝直通？**
本地回环本可以传裸帧、跳过编解码以获得更低延迟。
但需求明确要求"码率可调"，这只有在真正编码的前提下才有意义，
因此保留了完整的编码管线。若将来需要极致低延迟，可增加一个直通模式作为选项。

**测试**：`npm test` 运行 55 个单元测试，覆盖滤镜图生成、配置校验、dshow 输出解析、mpv 参数构造。
其中滤镜参数名均已用真实 ffmpeg 验证可被接受。

---

## 已知限制

- 仅支持 Windows 10/11（依赖桌面窗口机制）；平台适配层已隔离在 `src/win32.js` 与 `scripts/win32.ps1`
- 切换显示器后需重启管线
- 部分摄像头（如某些 USB 摄像头）的 DirectShow 接口需要管理员权限才能访问
- 色温调节使用 `colorbalance` 在阴影/中间调/高光上整体偏移红蓝，属于近似实现，非严格的白平衡

---

## 停止时如何确保不留残留

`stop` 命令通过 SIGTERM 通知主进程退出，但**主进程退出不等于子进程已退出** ——
ffmpeg/mpv 是主进程拉起的，若主进程在其退出前就结束，它们会变成孤儿继续占用摄像头，
并在桌面上留下一个看不见的窗口。

因此 `stop` 会在发信号**之前**先记下子进程，主进程退出后按两条依据清理：

1. 按**父进程 pid** 查找 ffmpeg/mpv（最准确）
2. 用 `state.json` 里记录的子进程 pid 兜底（覆盖父子关系已断的情况）

**清理范围严格限定**，绝不按进程名全量匹配 ——
否则会误杀你自己另外启动的 ffmpeg/mpv（例如别的转码、录屏任务）。

`stop` 的最终输出会明确告知清理了几个进程。

### 录制中的停止

录制是一条独立的 ffmpeg 进程。退出时会**先停止录制**再关闭服务，
以确保 MP4 的尾部（moov）被正确写入 —— 否则录出来的文件无法播放。

---

## 参数变更何时生效

| 类别 | 参数 | 生效方式 |
|---|---|---|
| **色彩** | 亮度、对比度、饱和度、Gamma、曝光、色温、色相 | **即时生效**（sendcmd 命令文件，不重启任何进程） |
| **几何** | 水平/垂直翻转、旋转、缩放模式 | 保存后需点「重启」 |
| **结构** | 帧率、采集分辨率、摄像头、编码器、**码率、画质**、延迟模式、界面端口 | 保存后需点「重启」 |

色彩参数走 ffmpeg 的 `sendcmd` 滤镜：ffmpeg 启动时滤镜链就固定包含
`sendcmd + eq + exposure + colorbalance + hue`，运行期只改写命令文件内容，
ffmpeg 下一帧自动读取新值。因此调色**不会**中断画面、不会碰摄像头、零卡死风险。

命令文件采用「先写临时文件再原子改名」，避免 ffmpeg 读到写了一半的内容导致画面闪烁。
若写入失败，界面会如实提示"色彩写入失败"，而不是谎报成功。

> 重启判定曾漏掉 `bitrate` 与 `quality`，导致改码率/画质既不生效也无提示。
> 现已修正并补上回归测试（见 `test/wallpaper.test.js`）。

### sendcmd 文件路径的坑（重要）

ffmpeg 的滤镜参数以 `:` 分隔，而 Windows 绝对路径形如 `C:/Users/.../cmd.txt`，
**其中的冒号会被当成下一个选项名**，导致：

```
No option name near '/Users/.../cmd.txt'
Error parsing a filter description
```

实测绝对路径（正斜杠、反斜杠、转义冒号）**全部失败**，只有**纯文件名**可用。

因此本工具的做法是：
- `buildFilterChain` 只接收**纯文件名**（如 `cam-to-bg-cmd-123.txt`）
- 启动 ffmpeg 时把 `cwd` 设为该文件所在目录（`os.tmpdir()`），让它能找到文件

这条约束由 `test/sendcmd-integration.test.js` 用**真实 ffmpeg** 固化：
既验证纯文件名可用，也验证绝对路径确实失败（回归防护）。

---

## 日志与错误收集

每次 `start` 都会生成一个**独立的运行记录**，所有日志与错误信息集中存放，用于事后排查一切问题。

### 存储位置

```
~/.cam-to-bg/logs/                       ← 配置目录下的 logs 文件夹
├─ 20260922_143055_1234_ab12/            ← 一次运行一个目录（runId = 时间_pid_随机4位）
│  ├─ manifest.json                      ← 启动快照 + 退出码 + 错误摘要
│  ├─ run.jsonl                          ← 结构化日志（JSON Lines）
│  ├─ ffmpeg.log                         ← ffmpeg 子进程输出
│  ├─ mpv.log                            ← mpv 子进程输出
│  └─ recorder.log                       ← 录制子进程输出（若本次录制过）
└─ last-run.json                         ← 最近一次运行的摘要（供 status/UI 快速展示）
```

> runId 末尾带随机 4 位：秒级精度下快速连续启动（如快速点重启）不会互相覆盖日志。

### manifest.json 包含什么

- **启动快照**：runId、启动时间、PID、Node 版本、平台、架构
- **配置快照**：本次运行使用的全部配置（设备、分辨率、码率、编码器等）
- **环境快照**：ffmpeg/mpv 路径与版本、桌面探测结果（Progman/WorkerW/显示器）
- **结束信息**：退出码、结束时间、错误摘要（若有）

### 结构化日志 run.jsonl

每行一条 JSON 记录：`{ ts, level, module, msg, extra }`

- 级别：`debug` / `info` / `warn` / `error`（由配置 `logLevel` 控制，默认 info）
- 模块：`app` / `wallpaper` / `pipeline` / `mpv` / `recorder` / `server` / `cli`
- error 级**立即落盘**，崩溃瞬间已写内容不丢
- 写盘失败绝不抛出 —— 日志机制本身不会成为新的崩溃源

### 收集哪些错误

| 类别 | 覆盖点 |
|---|---|
| 进程级 | `uncaughtException` / `unhandledRejection` / `exit`（带堆栈与摘要） |
| 子进程级 | ffmpeg/mpv/recorder 启动失败、异常退出（退出码 + 日志尾部 + 归因提示） |
| 配置级 | 加载告警、保存失败、非法值夹取、配置变更（旧值→新值） |
| 设备级 | 摄像头枚举/绑定失败、格式协商失败、编码器探测失败 |
| 操作级 | 调色写入失败、重启失败、录制失败、桌面挂载失败 |

### 查看方式

```bash
cam-to-bg logs                      # 列出所有运行（含错误标记）
cam-to-bg logs --last               # 查看最近一次运行详情
cam-to-bg logs <runId>              # 查看指定运行
cam-to-bg status                    # 未运行时显示上次运行失败原因
```

设置界面「高级」区也会显示当前运行 ID 与日志目录；HTTP 端提供
`/api/logs`（列运行）与 `/api/logs/<runId>`（取 manifest 与日志）。

### 保留策略

旧运行按 `logRetainRuns`（默认 10）自动清理，只保留最近 N 次。

---

## 项目结构

```
src/
  cli.js             命令行入口
  index.js           组装各模块
  wallpaper.js       总控：探测桌面 → 启管线 → 挂载 → 还原
  pipeline.js        ffmpeg 进程生命周期
  renderer.js        mpv 进程与延迟策略
  filters.js         配置 → ffmpeg 滤镜图（纯函数，易测试）
  devices.js         dshow 设备枚举与格式解析
  encoder-probe.js   真实编码一帧来挑选硬件编码器
  win32.js           Node ↔ PowerShell 桥
  server.js          设置界面的 HTTP + WebSocket 服务
  config.js          参数定义、校验与持久化
  logger.js          结构化分级日志器（JSONL）
  runs.js            运行会话管理（目录/manifest/清理/崩溃钩子）
  ui/                设置界面（原生 HTML/CSS/JS，无构建步骤）
scripts/
  win32.ps1          全部 Win32 P/Invoke 调用
test/                单元测试
```

## 许可证

MIT
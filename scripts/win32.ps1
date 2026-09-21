<#
  win32.ps1 — Win32 桌面窗口操作桥
  由 Node 通过 -File 调用。

  结果通过 -ResultPath 指定的文件回传（JSON），而不是 stdout。
  原因：受限沙箱下子进程的管道 stdio 会返回 EPERM；写文件可完全绕开该限制。
  若未提供 -ResultPath，则退回向 stdout 输出，方便手工调试。

  避免 node-gyp 原生编译：用 PowerShell Add-Type P/Invoke 完成全部 Win32 调用。
  必须以 PowerShell 7+ (pwsh) 运行：本文件含中文且为无 BOM 的 UTF-8。
#>
param(
  [Parameter(Mandatory=$true)][string]$Action,
  [int]$Hwnd = 0,
  [int]$Monitor = 0,
  [string]$Title = "",
  [string]$ResultPath = ""
)

$ErrorActionPreference = "Stop"

Add-Type -Namespace CamToBg -Name Native -MemberDefinition @"
  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, System.IntPtr lParam);
  public delegate bool EnumWindowsProc(System.IntPtr hWnd, System.IntPtr lParam);

  [DllImport("user32.dll", SetLastError=true, CharSet=System.Runtime.InteropServices.CharSet.Auto)]
  public static extern int GetClassName(System.IntPtr hWnd, System.Text.StringBuilder lpClassName, int nMaxCount);

  [DllImport("user32.dll", SetLastError=true, CharSet=System.Runtime.InteropServices.CharSet.Auto)]
  public static extern int GetWindowText(System.IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);

  [DllImport("user32.dll", SetLastError=true)]
  public static extern System.IntPtr GetParent(System.IntPtr hWnd);

  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool GetWindowRect(System.IntPtr hWnd, ref RECT lpRect);

  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool SetWindowPos(System.IntPtr hWnd, System.IntPtr hWndInsertAfter,
    int X, int Y, int cx, int cy, uint uFlags);

  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool ShowWindow(System.IntPtr hWnd, int nCmdShow);

  [DllImport("user32.dll", SetLastError=true)]
  public static extern int GetWindowLong(System.IntPtr hWnd, int nIndex);

  [DllImport("user32.dll", SetLastError=true)]
  public static extern int SetWindowLong(System.IntPtr hWnd, int nIndex, int dwNewLong);

  [DllImport("user32.dll", SetLastError=true)]
  public static extern System.IntPtr FindWindowEx(System.IntPtr parent, System.IntPtr childAfter, string className, string windowTitle);

  [DllImport("user32.dll", SetLastError=true)]
  public static extern System.IntPtr SetParent(System.IntPtr hWndChild, System.IntPtr hWndNewParent);

  [DllImport("user32.dll", SetLastError=true)]
  public static extern System.IntPtr SendMessageTimeout(System.IntPtr hWnd, uint Msg, System.IntPtr wParam, System.IntPtr lParam, uint fuFlags, uint uTimeout, out System.IntPtr lpdwResult);

  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool IsWindow(System.IntPtr hWnd);

  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool IsWindowVisible(System.IntPtr hWnd);

  [DllImport("user32.dll", SetLastError=true)]
  public static extern int GetSystemMetrics(int nIndex);

  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool EnumDisplayMonitors(System.IntPtr hdc, System.IntPtr lprcClip, MonitorEnumProc lpfnEnum, System.IntPtr dwData);
  public delegate bool MonitorEnumProc(System.IntPtr hMonitor, System.IntPtr hdc, System.IntPtr lprcMonitor, System.IntPtr dwData);

  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool GetMonitorInfo(System.IntPtr hMonitor, ref MONITORINFO lpmi);

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

  [StructLayout(LayoutKind.Sequential)]
  public struct MONITORINFO {
    public int cbSize;
    public RECT rcMonitor;
    public RECT rcWork;
    public uint dwFlags;
  }
"@

function Get-ClassOf([System.IntPtr]$h) {
  $sb = New-Object System.Text.StringBuilder 256
  [void][CamToBg.Native]::GetClassName($h, $sb, 256)
  return $sb.ToString()
}

# 枚举所有顶层窗口，返回 @{ Handle; Class }
function Get-TopLevelWindows {
  $list = New-Object System.Collections.ArrayList
  $cb = [CamToBg.Native+EnumWindowsProc]{
    param([System.IntPtr]$h, [System.IntPtr]$l)
    $cls = Get-ClassOf $h
    [void]$list.Add([pscustomobject]@{ Handle = [int64]$h; Class = $cls })
    return $true
  }
  [void][CamToBg.Native]::EnumWindows($cb, [System.IntPtr]::Zero)
  return $list
}

# 关键：Progman 用 FindWindow 在本机实测返回 0，必须靠 EnumWindows 找。
function Get-Progman {
  $w = Get-TopLevelWindows | Where-Object { $_.Class -eq "Progman" } | Select-Object -First 1
  if ($w) { return [System.IntPtr]$w.Handle }
  return [System.IntPtr]::Zero
}

<#
  选择壁纸宿主窗口。

  背景（本机 Windows 11 build 26200 实测）：
    经典做法是给 Progman 发 0x052C，让系统生成一个全屏的 WorkerW，再挂到它下面。
    但实测本机 15 个 WorkerW **全部只有 136x39 且不可见**——它们是系统内部的小helper 窗口，
    根本不是壁纸层。真正的桌面宿主是 Progman（2560x1440、可见、含 SHELLDLL_DefView）。

  因此这里按"谁真的承载桌面"来选，而不是盲目信任 WorkerW：
    1) 优先：WorkerW 中不含 SHELLDLL_DefView 且尺寸接近屏幕的那个（Win10 经典情形）
    2) 回退：Progman（Win11 情形，也是本机实际情况）

  尺寸判断很关键：把视频挂到 136x39 的窗口上，即使 SetParent 成功也只会被裁成一小块。
#>
function Get-WallpaperHost {
  $screenW = [CamToBg.Native]::GetSystemMetrics(0)
  $screenH = [CamToBg.Native]::GetSystemMetrics(1)
  $minArea = [int64]$screenW * [int64]$screenH * 0.5

  $workers = @()
  foreach ($c in (Get-TopLevelWindows | Where-Object { $_.Class -eq "WorkerW" })) {
    $h = [System.IntPtr]$c.Handle
    $rect = New-Object CamToBg.Native+RECT
    [void][CamToBg.Native]::GetWindowRect($h, [ref]$rect)
    $w = $rect.Right - $rect.Left
    $ht = $rect.Bottom - $rect.Top
    $defView = [CamToBg.Native]::FindWindowEx($h, [System.IntPtr]::Zero, "SHELLDLL_DefView", $null)
    $workers += [pscustomobject]@{
      Handle = $h; W = $w; H = $ht
      Area = ([int64]$w * [int64]$ht)
      HasDefView = ($defView -ne [System.IntPtr]::Zero)
    }
  }

  # 1) 经典 Win10 情形：全屏且不含 DefView 的 WorkerW
  $classic = $workers |
    Where-Object { -not $_.HasDefView -and $_.Area -ge $minArea } |
    Sort-Object -Property Area -Descending |
    Select-Object -First 1
  if ($classic) {
    return [pscustomobject]@{ Handle = $classic.Handle; Mode = "workerw"; W = $classic.W; H = $classic.H }
  }

  # 2) Win11 情形：Progman 本身就是桌面宿主
  $progman = Get-Progman
  if ($progman -ne [System.IntPtr]::Zero) {
    $rect = New-Object CamToBg.Native+RECT
    [void][CamToBg.Native]::GetWindowRect($progman, [ref]$rect)
    return [pscustomobject]@{
      Handle = $progman; Mode = "progman"
      W = ($rect.Right - $rect.Left); H = ($rect.Bottom - $rect.Top)
    }
  }

  # 3) 最后兜底：任意一个 WorkerW（可能被裁切，但至少有地方挂）
  if ($workers.Count -gt 0) {
    $any = $workers | Sort-Object -Property Area -Descending | Select-Object -First 1
    return [pscustomobject]@{ Handle = $any.Handle; Mode = "workerw-small"; W = $any.W; H = $any.H }
  }

  return $null
}

# 向 Progman 发 0x052C，促使系统生成承载壁纸的 WorkerW
function Invoke-SpawnWorkerW {
  $progman = Get-Progman
  if ($progman -eq [System.IntPtr]::Zero) { return $false }
  $result = [System.IntPtr]::Zero
  [void][CamToBg.Native]::SendMessageTimeout($progman, 0x052C, [System.IntPtr]::Zero, [System.IntPtr]::Zero, 0, 1000, [ref]$result)
  # 部分 Windows 版本需要带 wParam=0x0D 再发一次
  [void][CamToBg.Native]::SendMessageTimeout($progman, 0x052C, [System.IntPtr]0x0D, [System.IntPtr]::Zero, 0, 1000, [ref]$result)
  [void][CamToBg.Native]::SendMessageTimeout($progman, 0x052C, [System.IntPtr]0x0D, [System.IntPtr]1, 0, 1000, [ref]$result)
  return $true
}

function Get-Monitors {
  $list = New-Object System.Collections.ArrayList
  $cb = [CamToBg.Native+MonitorEnumProc]{
    param([System.IntPtr]$hMon, [System.IntPtr]$hdc, [System.IntPtr]$rc, [System.IntPtr]$data)
    $mi = New-Object CamToBg.Native+MONITORINFO
    $mi.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($mi)
    if ([CamToBg.Native]::GetMonitorInfo($hMon, [ref]$mi)) {
      [void]$list.Add([pscustomobject]@{
        handle = [int64]$hMon
        left   = $mi.rcMonitor.Left
        top    = $mi.rcMonitor.Top
        right  = $mi.rcMonitor.Right
        bottom = $mi.rcMonitor.Bottom
        width  = $mi.rcMonitor.Right - $mi.rcMonitor.Left
        height = $mi.rcMonitor.Bottom - $mi.rcMonitor.Top
        primary = (($mi.dwFlags -band 1) -eq 1)
      })
    }
    return $true
  }
  [void][CamToBg.Native]::EnumDisplayMonitors([System.IntPtr]::Zero, [System.IntPtr]::Zero, $cb, [System.IntPtr]::Zero)
  return $list
}

function Write-Json($obj) {
  $json = $obj | ConvertTo-Json -Compress -Depth 6
  if ($ResultPath -and $ResultPath.Length -gt 0) {
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($ResultPath, $json, $utf8)
  } else {
    [Console]::Out.WriteLine($json)
  }
}

try {
  switch ($Action) {

    "probe" {
      $top = Get-TopLevelWindows
      $workers = @($top | Where-Object { $_.Class -eq "WorkerW" })
      $workerCount = $workers.Count

      # 报告实际会被选用的宿主，便于排查"挂载了却看不见"
      $hostInfo = Get-WallpaperHost

      Write-Json ([pscustomobject]@{
        ok            = $true
        progman       = [int64](Get-Progman)
        workerWCount  = $workerCount
        hasWorkerW    = ($workerCount -gt 0)
        screenWidth   = [CamToBg.Native]::GetSystemMetrics(0)
        screenHeight  = [CamToBg.Native]::GetSystemMetrics(1)
        hostHwnd      = $(if ($hostInfo) { [int64]$hostInfo.Handle } else { 0 })
        hostMode      = $(if ($hostInfo) { $hostInfo.Mode } else { "none" })
        hostWidth     = $(if ($hostInfo) { $hostInfo.W } else { 0 })
        hostHeight    = $(if ($hostInfo) { $hostInfo.H } else { 0 })
        monitors      = @(Get-Monitors)
      })
    }

    "attach" {
      if ($Hwnd -eq 0) { throw "attach 需要 -Hwnd 参数" }
      $target = [System.IntPtr]$Hwnd
      if (-not [CamToBg.Native]::IsWindow($target)) { throw "无效的窗口句柄: $Hwnd" }

      # 选出真正承载桌面的窗口（见 Get-WallpaperHost 的说明）
      $hostInfo = Get-WallpaperHost

      # 若只找到小尺寸 WorkerW，尝试触发系统生成真正的壁纸层后再选一次
      if (-not $hostInfo -or $hostInfo.Mode -eq "workerw-small") {
        [void](Invoke-SpawnWorkerW)
        Start-Sleep -Milliseconds 400
        $retry = Get-WallpaperHost
        if ($retry -and $retry.Mode -ne "workerw-small") { $hostInfo = $retry }
      }

      if (-not $hostInfo) { throw "找不到可用的桌面宿主窗口" }

      $hostHwnd = [System.IntPtr]$hostInfo.Handle

      # 挂载前先记下原父窗口，便于判断 SetParent 是否真的生效
      $prevParent = [CamToBg.Native]::GetParent($target)

      <#
        关键步骤：把窗口样式从"弹出式顶层窗口"改成"子窗口"。

        mpv 创建的是 WS_POPUP 风格的顶层窗口（实测样式值 349110272 含 WS_POPUP）。
        对这种窗口调用 SetParent 虽然返回成功、Win32 错误码为 0，
        但它不会真正成为宿主的子窗口（GetParent 仍返回 0），
        桌面也就不会把它当壁纸渲染 —— 表现为"挂载成功但桌面没有任何变化"。

        正确做法：去掉 WS_POPUP，加上 WS_CHILD，再 SetParent。
      #>
      $GWL_STYLE = -16
      $WS_CHILD  = 0x40000000
      $WS_POPUP  = 0x80000000

      $style = [CamToBg.Native]::GetWindowLong($target, $GWL_STYLE)
      $styleBefore = $style

      # 转成 Int64 再做位运算，避免 PowerShell 中 32 位有符号数的溢出问题
      $s64 = [int64]$style
      $s64 = $s64 -band (-bnot [int64]$WS_POPUP)
      $s64 = $s64 -bor [int64]$WS_CHILD
      # 保证低 16 位为 0（WS_CHILD 要求不能带顶层窗口的边框样式）
      $s64 = $s64 -band (-bnot [int64]0x00CF0000)
      $newStyle = [int]$s64

      [void][CamToBg.Native]::SetWindowLong($target, $GWL_STYLE, $newStyle)

      $prev = [CamToBg.Native]::SetParent($target, $hostHwnd)
      $lastErr = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()

      # 校验：以"实际父窗口是否已变为宿主"为准
      Start-Sleep -Milliseconds 150
      $nowParent = [CamToBg.Native]::GetParent($target)
      $stuck = ($nowParent -eq $hostHwnd)

      if (-not $stuck -and $lastErr -ne 0 -and $prev -eq [System.IntPtr]::Zero) {
        throw ("SetParent 失败, Win32 错误码 " + $lastErr)
      }

      # 让窗口铺满宿主：SetParent 不会自动调整尺寸
      $hr = New-Object CamToBg.Native+RECT
      [void][CamToBg.Native]::GetWindowRect($hostHwnd, [ref]$hr)
      [void][CamToBg.Native]::SetWindowPos(
        $target, [System.IntPtr]::Zero,
        0, 0,
        ($hr.Right - $hr.Left), ($hr.Bottom - $hr.Top),
        (0x0004 -bor 0x0010 -bor 0x0040)   # SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW
      )

      Write-Json ([pscustomobject]@{
        ok           = $true
        mode         = $hostInfo.Mode
        host         = [int64]$hostHwnd
        hostW        = $hostInfo.W
        hostH        = $hostInfo.H
        child        = [int64]$target
        progman      = [int64](Get-Progman)
        parentBefore = [int64]$prevParent
        parentAfter  = [int64]$nowParent
        parentStuck  = $stuck
        styleBefore  = $styleBefore
        styleAfter   = $newStyle
        foundWorkerW = ($hostInfo.Mode -eq "workerw")
      })
    }

    "setparent-debug" {
      # 诊断用：只做 SetParent 并原样报告 Win32 错误码与前后状态
      if ($Hwnd -eq 0) { throw "setparent-debug 需要 -Hwnd 参数" }
      $child = [System.IntPtr]$Hwnd
      $parentInfo = Get-WallpaperHost
      $parent = $parentInfo.Handle

      $before = [CamToBg.Native]::GetParent($child)

      $ret = [CamToBg.Native]::SetParent($child, $parent)
      $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
      Start-Sleep -Milliseconds 150
      $after = [CamToBg.Native]::GetParent($child)

      Write-Json ([pscustomobject]@{
        ok          = $true
        child       = [int64]$child
        parent      = [int64]$parent
        parentMode  = $parentInfo.Mode
        retPrev     = [int64]$ret
        win32Error  = $err
        parentBefore= [int64]$before
        parentAfter = [int64]$after
        stuck       = ($after -eq $parent)
        childStyle  = [int64][CamToBg.Native]::GetWindowLong($child, -16)
        parentStyle = [int64][CamToBg.Native]::GetWindowLong($parent, -16)
      })
    }

    "findwindow" {
      # 按窗口标题查找顶层窗口（用于定位 mpv 的窗口）
      if (-not $Title -or $Title.Length -eq 0) { throw "findwindow 需要 -Title 参数" }
      $found = [System.IntPtr]::Zero
      $top = Get-TopLevelWindows
      foreach ($w in $top) {
        $h = [System.IntPtr]$w.Handle
        $sb = New-Object System.Text.StringBuilder 512
        [void][CamToBg.Native]::GetWindowText($h, $sb, 512)
        if ($sb.ToString() -eq $Title) { $found = $h; break }
      }
      Write-Json ([pscustomobject]@{ ok = $true; hwnd = [int64]$found; found = ($found -ne [System.IntPtr]::Zero) })
    }

    "windowinfo" {
      # 返回某个窗口的详细状态，用于排查"挂载了但看不见"这类问题
      if ($Hwnd -eq 0) { throw "windowinfo 需要 -Hwnd 参数" }
      $h = [System.IntPtr]$Hwnd
      $exists = [CamToBg.Native]::IsWindow($h)

      $cls = ""
      $title = ""
      if ($exists) {
        $sb = New-Object System.Text.StringBuilder 256
        [void][CamToBg.Native]::GetClassName($h, $sb, 256)
        $cls = $sb.ToString()
        $tb = New-Object System.Text.StringBuilder 256
        [void][CamToBg.Native]::GetWindowText($h, $tb, 256)
        $title = $tb.ToString()
      }

      $parent = [System.IntPtr]::Zero
      $parentClass = ""
      if ($exists) {
        $parent = [CamToBg.Native]::GetParent($h)
        if ($parent -ne [System.IntPtr]::Zero) {
          $pb = New-Object System.Text.StringBuilder 256
          [void][CamToBg.Native]::GetClassName($parent, $pb, 256)
          $parentClass = $pb.ToString()
        }
      }

      $rect = New-Object CamToBg.Native+RECT
      if ($exists) { [void][CamToBg.Native]::GetWindowRect($h, [ref]$rect) }

      Write-Json ([pscustomobject]@{
        ok          = $true
        exists      = $exists
        hwnd        = [int64]$h
        class       = $cls
        title       = $title
        visible     = ($exists -and [CamToBg.Native]::IsWindowVisible($h))
        parent      = [int64]$parent
        parentClass = $parentClass
        rect        = @{ left = $rect.Left; top = $rect.Top; right = $rect.Right; bottom = $rect.Bottom }
      })
    }

    "detach" {
      if ($Hwnd -eq 0) { throw "detach 需要 -Hwnd 参数" }
      $target = [System.IntPtr]$Hwnd
      if ([CamToBg.Native]::IsWindow($target)) {
        [void][CamToBg.Native]::SetParent($target, [System.IntPtr]::Zero)
      }
      Write-Json ([pscustomobject]@{ ok = $true; child = [int64]$target })
    }

    "monitors" {
      Write-Json ([pscustomobject]@{ ok = $true; monitors = @(Get-Monitors) })
    }

    default { throw "未知 action: $Action" }
  }
}
catch {
  Write-Json ([pscustomobject]@{ ok = $false; error = $_.Exception.Message })
  exit 1
}
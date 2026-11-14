import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DesktopUiError, asDesktopUiError } from "../errors.js";
import { createRestrictedProcessRunner, type DesktopProcessRunner } from "../processRunner.js";
import type {
  AccessibilitySnapshot,
  DesktopDiscoveredWindow,
  DesktopUiAdapter,
  DesktopUiCapabilities,
  DesktopWindow,
  DesktopWindowDiscoveryResult,
  DesktopWindowTarget,
  NativeCapture,
  NativeDesktopAction,
} from "../types.js";

const WINDOWS_POWERSHELL = path.win32.join(
  process.env.SystemRoot || process.env.windir || "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);

const PROBE_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes,System.Windows.Forms,System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class DesktopUiDpiProbe {
  [DllImport("user32.dll", SetLastError=true)]
  public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
}
"@
$previous = [DesktopUiDpiProbe]::SetThreadDpiAwarenessContext([IntPtr](-4))
if ($previous -eq [IntPtr]::Zero) {
  throw "DPI_CONTEXT_UNAVAILABLE: PER_MONITOR_AWARE_V2 could not be established"
}
[pscustomobject]@{
  available = [Environment]::UserInteractive
  userInteractive = [Environment]::UserInteractive
  powershell = $PSVersionTable.PSVersion.ToString()
  dpiAware = $true
} | ConvertTo-Json -Compress
`;

const DISCOVERY_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class DesktopUiWindowDiscovery {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
  [DllImport("user32.dll", SetLastError=true)] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder className, int maxCount);
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hWnd);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool GetWindowDisplayAffinity(IntPtr hWnd, out uint affinity);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hWnd, uint attribute, out int value, int size);
}
"@
$previousDpiContext = [DesktopUiWindowDiscovery]::SetThreadDpiAwarenessContext([IntPtr](-4))
if ($previousDpiContext -eq [IntPtr]::Zero) {
  throw "DPI_CONTEXT_UNAVAILABLE: PER_MONITOR_AWARE_V2 could not be established"
}
$payload = ConvertFrom-Json $env:SUPERAGENT_DESKTOP_UI_PAYLOAD
$limit = [int]$payload.limit
if ($limit -lt 1 -or $limit -gt 100) { throw "INVALID_ACTION: discovery limit must be between 1 and 100" }
$foreground = [DesktopUiWindowDiscovery]::GetForegroundWindow()
$items = New-Object System.Collections.Generic.List[object]
$callback = [DesktopUiWindowDiscovery+EnumWindowsProc]{
  param([IntPtr]$hwnd, [IntPtr]$lParam)
  if ($items.Count -gt $limit) { return $false }
  try {
    if (-not [DesktopUiWindowDiscovery]::IsWindowVisible($hwnd)) { return $true }
    if ([DesktopUiWindowDiscovery]::GetAncestor($hwnd, 2) -ne $hwnd) { return $true }
    $classBuffer = New-Object System.Text.StringBuilder 256
    [void][DesktopUiWindowDiscovery]::GetClassName($hwnd, $classBuffer, $classBuffer.Capacity)
    if ($classBuffer.ToString() -in @("Shell_TrayWnd", "Progman", "WorkerW")) { return $true }
    $cloaked = 0
    $cloakResult = [DesktopUiWindowDiscovery]::DwmGetWindowAttribute($hwnd, 14, [ref]$cloaked, 4)
    if ($cloakResult -ne 0 -or $cloaked -ne 0) { return $true }
    [uint32]$affinity = 0
    if (-not [DesktopUiWindowDiscovery]::GetWindowDisplayAffinity($hwnd, [ref]$affinity)) { return $true }
    if ($affinity -ne 0) { return $true }
    [uint32]$ownerPid = 0
    [void][DesktopUiWindowDiscovery]::GetWindowThreadProcessId($hwnd, [ref]$ownerPid)
    if ($ownerPid -le 0) { return $true }
    $rect = New-Object DesktopUiWindowDiscovery+RECT
    if (-not [DesktopUiWindowDiscovery]::GetWindowRect($hwnd, [ref]$rect)) { return $true }
    $width = $rect.Right - $rect.Left
    $height = $rect.Bottom - $rect.Top
    if ($width -le 0 -or $height -le 0) { return $true }
    $titleLength = [DesktopUiWindowDiscovery]::GetWindowTextLength($hwnd)
    if ($titleLength -le 0) { return $true }
    $titleBuffer = New-Object System.Text.StringBuilder ([Math]::Min(513, $titleLength + 1))
    [void][DesktopUiWindowDiscovery]::GetWindowText($hwnd, $titleBuffer, $titleBuffer.Capacity)
    $title = [regex]::Replace($titleBuffer.ToString(), '[\x00-\x1F\x7F]', '')
    if ([string]::IsNullOrWhiteSpace($title)) { return $true }
    if ($title.Length -gt 512) { $title = $title.Substring(0, 512) }
    try { $application = [System.Diagnostics.Process]::GetProcessById([int]$ownerPid).ProcessName } catch { return $true }
    if ([string]::IsNullOrWhiteSpace($application)) { return $true }
    if ($application.Length -gt 256) { $application = $application.Substring(0, 256) }
    $dpi = [DesktopUiWindowDiscovery]::GetDpiForWindow($hwnd)
    if ($dpi -le 0) { return $true }
    $items.Add([pscustomobject]@{
      pid = [int]$ownerPid
      nativeId = $hwnd.ToInt64().ToString()
      title = $title
      application = $application
      active = ($foreground -eq $hwnd)
      scaleFactor = ([double]$dpi / 96.0)
      bounds = [pscustomobject]@{ x=$rect.Left; y=$rect.Top; width=$width; height=$height }
    })
  } catch {}
  return $true
}
[void][DesktopUiWindowDiscovery]::EnumWindows($callback, [IntPtr]::Zero)
$truncated = $items.Count -gt $limit
$windows = @($items | Select-Object -First $limit)
[pscustomobject]@{
  windows = $windows
  limit = $limit
  truncated = $truncated
} | ConvertTo-Json -Depth 6 -Compress
`;

const WINDOW_PREAMBLE = String.raw`
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class DesktopUiNativeWindow {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll", SetLastError=true)] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsChild(IntPtr parent, IntPtr child);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder className, int maxCount);
  [DllImport("user32.dll", SetLastError=true)] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint flags);
}
"@
$previousDpiContext = [DesktopUiNativeWindow]::SetThreadDpiAwarenessContext([IntPtr](-4))
if ($previousDpiContext -eq [IntPtr]::Zero) {
  throw "DPI_CONTEXT_UNAVAILABLE: PER_MONITOR_AWARE_V2 could not be established"
}
$payload = ConvertFrom-Json $env:SUPERAGENT_DESKTOP_UI_PAYLOAD
$requestedPid = [int]$payload.pid
if ($requestedPid -le 0) { throw "TARGET_NOT_FOUND: invalid target PID" }
$process = Get-Process -Id $requestedPid -ErrorAction Stop
if ($payload.nativeId) {
  $hwnd = [IntPtr]([Int64]::Parse([string]$payload.nativeId))
} else {
  $hwnd = $process.MainWindowHandle
}
if ($hwnd -eq [IntPtr]::Zero -or -not [DesktopUiNativeWindow]::IsWindow($hwnd)) {
  throw "TARGET_NOT_FOUND: process has no usable top-level window"
}
$root = [DesktopUiNativeWindow]::GetAncestor($hwnd, 2)
if ($root -eq [IntPtr]::Zero -or $root -ne $hwnd) {
  throw "TARGET_NOT_FOUND: supplied HWND is not a root top-level window"
}
[uint32]$ownerPid = 0
[void][DesktopUiNativeWindow]::GetWindowThreadProcessId($hwnd, [ref]$ownerPid)
if ([int]$ownerPid -ne $requestedPid) {
  throw "TARGET_NOT_FOUND: supplied HWND is not owned by the requested PID"
}
$rect = New-Object DesktopUiNativeWindow+RECT
if (-not [DesktopUiNativeWindow]::GetWindowRect($hwnd, [ref]$rect)) {
  throw "TARGET_NOT_FOUND: GetWindowRect failed"
}
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
if ($width -le 0 -or $height -le 0) {
  throw "TARGET_NOT_FOUND: target window has empty bounds"
}
$titleLength = [DesktopUiNativeWindow]::GetWindowTextLength($hwnd)
$titleBuffer = New-Object System.Text.StringBuilder ([Math]::Max(1, $titleLength + 1))
[void][DesktopUiNativeWindow]::GetWindowText($hwnd, $titleBuffer, $titleBuffer.Capacity)
$windowTitle = [regex]::Replace($titleBuffer.ToString(), '[\x00-\x1F\x7F]', '')
$active = [DesktopUiNativeWindow]::GetForegroundWindow() -eq $hwnd
$dpi = [DesktopUiNativeWindow]::GetDpiForWindow($hwnd)
if ($dpi -le 0) { throw "DPI_CONTEXT_UNAVAILABLE: GetDpiForWindow failed" }
$scaleFactor = [double]$dpi / 96.0
`;

const CAPTURE_SCRIPT = WINDOW_PREAMBLE + String.raw`
$outputPath = [string]$payload.outputPath
$bitmap = New-Object System.Drawing.Bitmap $width, $height, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$hdc = [IntPtr]::Zero
try {
  $hdc = $graphics.GetHdc()
  $ok = [DesktopUiNativeWindow]::PrintWindow($hwnd, $hdc, 2)
  if (-not $ok) { throw "SCREENSHOT_UNAVAILABLE: PrintWindow failed for the scoped HWND" }
} finally {
  if ($hdc -ne [IntPtr]::Zero) { $graphics.ReleaseHdc($hdc) }
  $graphics.Dispose()
}
try {
  $bitmap.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
  $bitmap.Dispose()
}
[uint32]$ownerPidAfter = 0
if (-not [DesktopUiNativeWindow]::IsWindow($hwnd)) { throw "TARGET_NOT_FOUND: HWND disappeared during capture" }
[void][DesktopUiNativeWindow]::GetWindowThreadProcessId($hwnd, [ref]$ownerPidAfter)
if ([int]$ownerPidAfter -ne $requestedPid -or [DesktopUiNativeWindow]::GetAncestor($hwnd, 2) -ne $hwnd) {
  throw "TARGET_NOT_FOUND: HWND ownership changed during capture"
}
[pscustomobject]@{
  pid = $requestedPid
  nativeId = $hwnd.ToInt64().ToString()
  title = $windowTitle
  active = $active
  scaleFactor = $scaleFactor
  bounds = [pscustomobject]@{ x=$rect.Left; y=$rect.Top; width=$width; height=$height }
} | ConvertTo-Json -Compress
`;

const ACCESSIBILITY_SCRIPT = WINDOW_PREAMBLE + String.raw`
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
$rootElement = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
if ($null -eq $rootElement) { throw "ACCESSIBILITY_UNAVAILABLE: AutomationElement.FromHandle returned null" }
$walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
$items = New-Object System.Collections.Generic.List[object]
$stack = New-Object System.Collections.Stack
$stack.Push([pscustomobject]@{ node=$rootElement; depth=0 })
while ($stack.Count -gt 0 -and $items.Count -lt 2000) {
  $entry = $stack.Pop()
  $node = $entry.node
  $depth = [int]$entry.depth
  try {
    $current = $node.Current
    $r = $current.BoundingRectangle
    if (-not $r.IsEmpty -and $r.Width -gt 0 -and $r.Height -gt 0) {
      $role = $current.ControlType.ProgrammaticName -replace '^ControlType\.', ''
      $nativeHandle = [IntPtr]([Int64]$current.NativeWindowHandle)
      if ($role -eq "Pane" -and $nativeHandle -ne [IntPtr]::Zero -and [DesktopUiNativeWindow]::IsWindow($nativeHandle)) {
        [uint32]$nativeOwner = 0
        [void][DesktopUiNativeWindow]::GetWindowThreadProcessId($nativeHandle, [ref]$nativeOwner)
        if ([int]$nativeOwner -eq $requestedPid -and [DesktopUiNativeWindow]::IsChild($hwnd, $nativeHandle)) {
          $classBuffer = New-Object System.Text.StringBuilder 256
          [void][DesktopUiNativeWindow]::GetClassName($nativeHandle, $classBuffer, $classBuffer.Capacity)
          $nativeClass = $classBuffer.ToString()
          if ($nativeClass -match '^WindowsForms10\.BUTTON\.') { $role = "Button" }
          elseif ($nativeClass -match '^WindowsForms10\.EDIT\.') { $role = "Edit" }
        }
      }
      $name = [regex]::Replace([string]$current.Name, '[\x00-\x1F\x7F]', '')
      $help = [regex]::Replace([string]$current.HelpText, '[\x00-\x1F\x7F]', '')
      $automationId = [regex]::Replace([string]$current.AutomationId, '[\x00-\x1F\x7F]', '')
      $runtimeId = ""
      try { $runtimeId = (($node.GetRuntimeId()) -join ".") } catch {}
      $actionableRoles = @("Button","Edit","Hyperlink","MenuItem","CheckBox","RadioButton","ComboBox","ListItem","TabItem","Slider","Spinner")
      $hasFocus = $false
      try { $hasFocus = [bool]$current.HasKeyboardFocus } catch {}
      $items.Add([pscustomobject]@{
        role = $role.ToLowerInvariant()
        label = if ([string]::IsNullOrWhiteSpace($name)) { $null } else { $name }
        description = if ([string]::IsNullOrWhiteSpace($help)) { $null } else { $help }
        value = $null
        bounds = [pscustomobject]@{ x=$r.X; y=$r.Y; width=$r.Width; height=$r.Height }
        center = [pscustomobject]@{ x=($r.X + $r.Width/2); y=($r.Y + $r.Height/2) }
        actionable = ([bool]$current.IsEnabled -and -not [bool]$current.IsOffscreen -and ($actionableRoles -contains $role))
        focused = $hasFocus
        nativeRef = if ($automationId) { "automationId:" + $automationId } elseif ($runtimeId) { "runtimeId:" + $runtimeId } else { $null }
      })
    }
  } catch {}
  if ($depth -lt 14) {
    try {
      $children = New-Object System.Collections.Generic.List[object]
      $child = $walker.GetFirstChild($node)
      while ($null -ne $child) {
        $children.Add($child)
        $child = $walker.GetNextSibling($child)
      }
      for ($i=$children.Count-1; $i -ge 0; $i--) {
        $stack.Push([pscustomobject]@{ node=$children[$i]; depth=$depth+1 })
      }
    } catch {}
  }
}
[uint32]$ownerPidAfter = 0
if (-not [DesktopUiNativeWindow]::IsWindow($hwnd)) { throw "TARGET_NOT_FOUND: HWND disappeared during accessibility inspection" }
[void][DesktopUiNativeWindow]::GetWindowThreadProcessId($hwnd, [ref]$ownerPidAfter)
if ([int]$ownerPidAfter -ne $requestedPid -or [DesktopUiNativeWindow]::GetAncestor($hwnd, 2) -ne $hwnd) {
  throw "TARGET_NOT_FOUND: HWND ownership changed during accessibility inspection"
}
[pscustomobject]@{
  window = [pscustomobject]@{
    pid = $requestedPid
    nativeId = $hwnd.ToInt64().ToString()
    title = $windowTitle
    active = $active
    scaleFactor = $scaleFactor
    bounds = [pscustomobject]@{ x=$rect.Left; y=$rect.Top; width=$width; height=$height }
  }
  elements = $items.ToArray()
} | ConvertTo-Json -Depth 7 -Compress
`;

const INPUT_SCRIPT = WINDOW_PREAMBLE + String.raw`
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class DesktopUiNativeInput {
  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)]
  public struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT { public uint type; public InputUnion U; }
  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();

  public static void RequireForeground(IntPtr target) {
    if (target == IntPtr.Zero || GetForegroundWindow() != target)
      throw new InvalidOperationException("TARGET_NOT_ACTIVE: scoped HWND lost foreground focus before input");
  }
  private static INPUT KeyInput(ushort key, uint flags) {
    return new INPUT { type = 1, U = new InputUnion { ki = new KEYBDINPUT { wVk=key, dwFlags=flags } } };
  }
  private static INPUT UnicodeInput(char ch, uint flags) {
    return new INPUT { type = 1, U = new InputUnion { ki = new KEYBDINPUT { wScan=ch, dwFlags=flags | 0x0004 } } };
  }
  private static INPUT MouseInput(uint flag, int data) {
    return new INPUT {
      type = 0, U = new InputUnion {
        mi = new MOUSEINPUT { dwFlags=flag, mouseData=unchecked((uint)data) }
      }
    };
  }
  private static void SendExact(INPUT[] events) {
    if (events.Length == 0) return;
    uint sent = SendInput((uint)events.Length, events, Marshal.SizeOf(typeof(INPUT)));
    if (sent != events.Length) throw new InvalidOperationException("INPUT_UNAVAILABLE: SendInput sent only " + sent + "/" + events.Length + " events");
  }
  public static void Click(IntPtr target) {
    RequireForeground(target);
    SendExact(new [] { MouseInput(0x0002, 0), MouseInput(0x0004, 0) });
  }
  public static void Wheel(IntPtr target, uint flag, int delta) {
    RequireForeground(target);
    SendExact(new [] { MouseInput(flag, delta) });
  }
  public static void TypeUnicode(IntPtr target, string text) {
    foreach (char ch in text) {
      RequireForeground(target);
      SendExact(new [] { UnicodeInput(ch, 0), UnicodeInput(ch, 0x0002) });
    }
  }
  public static void KeyChord(IntPtr target, ushort key, ushort[] modifiers) {
    RequireForeground(target);
    var events = new System.Collections.Generic.List<INPUT>();
    foreach (ushort mod in modifiers) events.Add(KeyInput(mod, 0));
    events.Add(KeyInput(key, 0));
    events.Add(KeyInput(key, 0x0002));
    for (int i = modifiers.Length - 1; i >= 0; i--) events.Add(KeyInput(modifiers[i], 0x0002));
    try {
      SendExact(events.ToArray());
    } catch {
      if (modifiers.Length > 0) {
        var releases = new System.Collections.Generic.List<INPUT>();
        for (int i = modifiers.Length - 1; i >= 0; i--) releases.Add(KeyInput(modifiers[i], 0x0002));
        try { SendExact(releases.ToArray()); } catch { /* best-effort modifier release */ }
      }
      throw;
    }
  }
}
"@
if (-not $active) { throw "TARGET_NOT_ACTIVE: target window must already be foreground before input" }
function Assert-Point([double]$x, [double]$y) {
  if ($x -lt $rect.Left -or $x -ge $rect.Right -or $y -lt $rect.Top -or $y -ge $rect.Bottom) {
    throw "INVALID_ACTION: target point is outside the scoped window"
  }
}
function Move-Point([int]$x, [int]$y) {
  Assert-Point $x $y
  [DesktopUiNativeInput]::RequireForeground($hwnd)
  if (-not [DesktopUiNativeInput]::SetCursorPos($x, $y)) {
    throw "INPUT_UNAVAILABLE: SetCursorPos failed"
  }
  [DesktopUiNativeInput]::RequireForeground($hwnd)
}
function Click-Point([int]$x, [int]$y) {
  Move-Point $x $y
  [DesktopUiNativeInput]::Click($hwnd)
}
$keyMap = @{
  ENTER=0x0D; TAB=0x09; ESCAPE=0x1B; BACKSPACE=0x08; DELETE=0x2E;
  ARROW_UP=0x26; ARROW_DOWN=0x28; ARROW_LEFT=0x25; ARROW_RIGHT=0x27;
  HOME=0x24; END=0x23; PAGE_UP=0x21; PAGE_DOWN=0x22; SPACE=0x20
}
$modifierMap = @{ CTRL=0x11; ALT=0x12; SHIFT=0x10; META=0x5B }
switch ([string]$payload.kind) {
  "click" {
    Click-Point ([int][math]::Round($payload.x)) ([int][math]::Round($payload.y))
  }
  "type" {
    Click-Point ([int][math]::Round($payload.x)) ([int][math]::Round($payload.y))
    [DesktopUiNativeInput]::TypeUnicode($hwnd, [string]$payload.text)
  }
  "key" {
    if (-not $keyMap.ContainsKey([string]$payload.key)) { throw "INVALID_ACTION: unsupported key" }
    $mods = @($payload.modifiers)
    $modifierCodes = New-Object 'System.Collections.Generic.List[UInt16]'
    foreach ($mod in $mods) {
      if (-not $modifierMap.ContainsKey([string]$mod)) { throw "INVALID_ACTION: unsupported modifier" }
      $modifierCodes.Add([UInt16]$modifierMap[[string]$mod])
    }
    $vk = [UInt16]$keyMap[[string]$payload.key]
    [DesktopUiNativeInput]::KeyChord($hwnd, $vk, $modifierCodes.ToArray())
  }
  "scroll" {
    Move-Point ([int][math]::Round($payload.x)) ([int][math]::Round($payload.y))
    if ([int]$payload.deltaY -ne 0) {
      [DesktopUiNativeInput]::Wheel($hwnd, [uint32]0x0800, ([int]$payload.deltaY * 120))
    }
    if ([int]$payload.deltaX -ne 0) {
      [DesktopUiNativeInput]::Wheel($hwnd, [uint32]0x1000, ([int]$payload.deltaX * 120))
    }
  }
  default { throw "INVALID_ACTION: unknown native action" }
}
[uint32]$ownerPidAfter = 0
if (-not [DesktopUiNativeWindow]::IsWindow($hwnd)) { throw "TARGET_NOT_FOUND: HWND disappeared before input completed" }
[void][DesktopUiNativeWindow]::GetWindowThreadProcessId($hwnd, [ref]$ownerPidAfter)
if ([int]$ownerPidAfter -ne $requestedPid -or [DesktopUiNativeWindow]::GetAncestor($hwnd, 2) -ne $hwnd) {
  throw "TARGET_NOT_FOUND: HWND ownership changed during input"
}
[pscustomobject]@{ ok=$true } | ConvertTo-Json -Compress
`;

function encodePowerShell(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

function parseJson<T>(text: string, context: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new DesktopUiError("PROCESS_FAILED", `${context} returned invalid JSON.`);
  }
}

function windowFrom(value: any): DesktopWindow {
  const bounds = value?.bounds;
  if (
    !value
    || typeof value.pid !== "number"
    || typeof value.nativeId !== "string"
    || typeof bounds?.x !== "number"
    || typeof bounds?.y !== "number"
    || typeof bounds?.width !== "number"
    || typeof bounds?.height !== "number"
    || !Number.isFinite(bounds.x)
    || !Number.isFinite(bounds.y)
    || !Number.isFinite(bounds.width)
    || !Number.isFinite(bounds.height)
    || bounds.width <= 0
    || bounds.height <= 0
  ) {
    throw new DesktopUiError("PROCESS_FAILED", "Windows adapter returned an invalid window descriptor.");
  }
  return {
    pid: value.pid,
    nativeId: value.nativeId,
    title: typeof value.title === "string" ? value.title : "",
    active: value.active === true,
    scaleFactor: typeof value.scaleFactor === "number" ? value.scaleFactor : undefined,
    bounds,
  };
}


function requireDiscoveryLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new DesktopUiError("INVALID_ACTION", "Window discovery limit must be an integer between 1 and 100.");
  }
  return limit;
}

function discoveredWindowFrom(value: any): DesktopDiscoveredWindow {
  const window = windowFrom(value);
  if (typeof value?.application !== "string" || !value.application.trim()) {
    throw new DesktopUiError("PROCESS_FAILED", "Windows discovery returned a window without an application name.");
  }
  return { ...window, application: value.application };
}

function discoveryResultFrom(value: any, limit: number): DesktopWindowDiscoveryResult {
  const windows = Array.isArray(value?.windows) ? value.windows.map(discoveredWindowFrom) : [];
  const seen = new Set<string>();
  for (const window of windows) {
    const identity = `${window.pid}:${window.nativeId}`;
    if (seen.has(identity)) {
      throw new DesktopUiError("PROCESS_FAILED", "Windows discovery returned a duplicate native window identity.");
    }
    seen.add(identity);
  }
  return { windows, limit, truncated: value?.truncated === true };
}

function mapWindowsError(error: unknown, fallbackCode: "SCREENSHOT_UNAVAILABLE" | "ACCESSIBILITY_UNAVAILABLE" | "INPUT_UNAVAILABLE", fallbackMessage: string): DesktopUiError {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("TARGET_NOT_FOUND")) {
    return new DesktopUiError("TARGET_NOT_FOUND", message);
  }
  if (message.includes("TARGET_NOT_ACTIVE")) {
    return new DesktopUiError("TARGET_NOT_ACTIVE", message);
  }
  if (message.includes("DPI_CONTEXT_UNAVAILABLE")) {
    return new DesktopUiError("DESKTOP_UI_UNAVAILABLE", message);
  }
  return asDesktopUiError(error, fallbackCode, fallbackMessage);
}

export function createWindowsDesktopUiAdapter(
  runner: DesktopProcessRunner = createRestrictedProcessRunner([WINDOWS_POWERSHELL]),
): DesktopUiAdapter {
  const runPowerShell = async (script: string, payload?: unknown) =>
    runner.run({
      executable: WINDOWS_POWERSHELL,
      args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodePowerShell(script)],
      env: payload === undefined ? undefined : { SUPERAGENT_DESKTOP_UI_PAYLOAD: JSON.stringify(payload) },
      timeoutMs: 15_000,
    });

  return {
    platform: "win32",

    async probe(): Promise<DesktopUiCapabilities> {
      try {
        const result = await runPowerShell(PROBE_SCRIPT);
        const parsed = parseJson<{ available: boolean; dpiAware?: boolean }>(result.stdout, "Windows capability probe");
        const available = parsed.available === true && parsed.dpiAware === true;
        return {
          platform: "win32",
          available,
          screenshot: available,
          accessibility: available,
          input: available,
          scroll: available,
          prerequisites: ["Interactive Windows desktop session", "Windows PowerShell", ".NET UIAutomation and System.Drawing", "per-monitor-v2 DPI context"],
          limitations: [
            "Input requires the exact target root HWND to already be foreground.",
            "Target capture uses PrintWindow and fails closed instead of falling back to an overlap-prone screen-region capture.",
            "Windows UIPI can block automation into higher-integrity/elevated applications.",
          ],
          errors: available ? [] : ["Windows is not running an interactive per-monitor-v2-aware user session."],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          platform: "win32",
          available: false,
          screenshot: false,
          accessibility: false,
          input: false,
          scroll: false,
          prerequisites: ["Interactive Windows desktop session", "Windows PowerShell", ".NET UIAutomation and System.Drawing", "per-monitor-v2 DPI context"],
          limitations: [],
          errors: [message],
        };
      }
    },


    async listWindows(limit: number): Promise<DesktopWindowDiscoveryResult> {
      const boundedLimit = requireDiscoveryLimit(limit);
      try {
        const result = await runPowerShell(DISCOVERY_SCRIPT, { limit: boundedLimit });
        return discoveryResultFrom(parseJson(result.stdout, "Windows window discovery"), boundedLimit);
      } catch (error) {
        throw mapWindowsError(error, "ACCESSIBILITY_UNAVAILABLE", "Windows window discovery failed");
      }
    },

    async getActiveWindow(): Promise<DesktopDiscoveredWindow | null> {
      const discovery = await this.listWindows!(100);
      const active = discovery.windows.filter((window) => window.active);
      return active.length === 1 ? active[0] : null;
    },

    async openVerifiedCapture(window: DesktopDiscoveredWindow) {
      // Only the manually approved Desktop Live viewer uses this native
      // per-session worker. Normal desktop_ui capture and input stay unchanged.
      const { openWindowsVerifiedCapture } = await import("./windowsPreviewWorker.js");
      return openWindowsVerifiedCapture(window);
    },

    async capture(target: DesktopWindowTarget): Promise<NativeCapture> {
      const dir = await mkdtemp(path.join(os.tmpdir(), "superagent-desktop-ui-"));
      const outputPath = path.join(dir, "capture.png");
      try {
        const result = await runPowerShell(CAPTURE_SCRIPT, { ...target, outputPath });
        const targetWindow = windowFrom(parseJson(result.stdout, "Windows screenshot"));
        const image = await readFile(outputPath);
        return {
          image,
          capturedAt: new Date().toISOString(),
          targetWindow,
        };
      } catch (error) {
        throw mapWindowsError(error, "SCREENSHOT_UNAVAILABLE", "Windows target-window capture failed");
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    },

    async inspectAccessibility(target, capture): Promise<AccessibilitySnapshot> {
      try {
        const result = await runPowerShell(ACCESSIBILITY_SCRIPT, {
          ...target,
          nativeId: capture.targetWindow.nativeId,
        });
        const payload = parseJson<any>(result.stdout, "Windows accessibility inspection");
        const window = windowFrom(payload.window);
        const rawElements = Array.isArray(payload.elements) ? payload.elements : [];
        const elements = rawElements
          .filter((element: any) =>
            element
            && typeof element.role === "string"
            && typeof element.bounds?.x === "number"
            && typeof element.bounds?.y === "number"
            && typeof element.bounds?.width === "number"
            && typeof element.bounds?.height === "number")
          .map((element: any) => ({
            role: element.role,
            label: typeof element.label === "string" ? element.label : null,
            description: typeof element.description === "string" ? element.description : null,
            value: typeof element.value === "string" ? element.value : null,
            bounds: element.bounds,
            center: {
              x: element.bounds.x + element.bounds.width / 2,
              y: element.bounds.y + element.bounds.height / 2,
            },
            actionable: element.actionable === true,
            focused: typeof element.focused === "boolean" ? element.focused : undefined,
            nativeRef: typeof element.nativeRef === "string" ? element.nativeRef : undefined,
          }));
        return { window, elements };
      } catch (error) {
        throw mapWindowsError(error, "ACCESSIBILITY_UNAVAILABLE", "Windows UIAutomation inspection failed");
      }
    },

    async dispatch(action: NativeDesktopAction): Promise<void> {
      const payload: Record<string, unknown> = {
        pid: action.target.pid,
        nativeId: action.target.nativeId,
        kind: action.kind,
      };
      if ("point" in action) {
        payload.x = action.point.x;
        payload.y = action.point.y;
      }
      if (action.kind === "type") payload.text = action.text;
      if (action.kind === "key") {
        payload.key = action.key;
        payload.modifiers = action.modifiers;
      }
      if (action.kind === "scroll") {
        payload.deltaX = action.deltaX;
        payload.deltaY = action.deltaY;
      }
      try {
        await runPowerShell(INPUT_SCRIPT, payload);
      } catch (error) {
        throw mapWindowsError(error, "INPUT_UNAVAILABLE", "Windows native input failed");
      }
    },
  };
}

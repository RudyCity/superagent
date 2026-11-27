/**
 * windowsAccessibilityHost.ts — one persistent UIAutomation helper process.
 *
 * One-shot accessibility inspection re-loads the UIAutomation assemblies and
 * re-creates the PowerShell host on every snapshot (~0.9 s). This module keeps a
 * single fixed-script carrier alive and re-validates the HWND, owner PID, root
 * status and visibility for every request, so repeated perception costs only the
 * tree walk.
 *
 * Fail open ONLY to the caller's fallback: any spawn/parse/protocol failure
 * closes the host and rejects, and `windows.ts` then uses the original one-shot
 * script. No executable path, script or argument is accepted from a caller.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import type { AccessibilitySnapshot, DesktopWindow } from "../types.js";
import { DesktopUiError } from "../errors.js";

const POWER_SHELL = path.win32.join(
  process.env.SystemRoot || process.env.windir || "C:\\Windows",
  "System32", "WindowsPowerShell", "v1.0", "powershell.exe",
);
const MAX_LINE = 2 * 1024 * 1024;
const IDLE_CLOSE_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;

const HOST_SCRIPT = String.raw`
$ErrorActionPreference="Stop"
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class AccNative {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint f);
  [DllImport("user32.dll")] public static extern bool IsChild(IntPtr parent, IntPtr child);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder b, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder b, int n);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, uint a, out int v, int s);
  [DllImport("user32.dll")] public static extern bool GetWindowDisplayAffinity(IntPtr h, out uint a);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr v);
}
"@
if ([AccNative]::SetThreadDpiAwarenessContext([IntPtr](-4)) -eq [IntPtr]::Zero) { exit 2 }
$actionableRoles = @("Button","Edit","Hyperlink","MenuItem","CheckBox","RadioButton","ComboBox","ListItem","TabItem","Slider","Spinner")
[Console]::Out.WriteLine('{"type":"ready"}')
[Console]::Out.Flush()
while ($true) {
  $line=[Console]::In.ReadLine()
  if ($null -eq $line -or $line -eq "close") { break }
  try {
    $req=ConvertFrom-Json $line
    $requestedPid=[int]$req.pid
    $hwnd=[IntPtr]([Int64]::Parse([string]$req.nativeId))
    if ($requestedPid -le 0 -or $hwnd -eq [IntPtr]::Zero -or -not [AccNative]::IsWindow($hwnd) -or
        -not [AccNative]::IsWindowVisible($hwnd) -or [AccNative]::GetAncestor($hwnd,2) -ne $hwnd) { throw "target" }
    [uint32]$ownerPid=0
    [void][AccNative]::GetWindowThreadProcessId($hwnd,[ref]$ownerPid)
    if ([int]$ownerPid -ne $requestedPid) { throw "owner" }
    $r=New-Object AccNative+RECT
    if (-not [AccNative]::GetWindowRect($hwnd,[ref]$r)) { throw "bounds" }
    $w=$r.Right-$r.Left
    $ht=$r.Bottom-$r.Top
    $dpi=[AccNative]::GetDpiForWindow($hwnd)
    if ($dpi -le 0 -or $w -le 0 -or $ht -le 0) { throw "geometry" }
    $len=[AccNative]::GetWindowTextLength($hwnd)
    $tb=New-Object System.Text.StringBuilder ([Math]::Max(1,$len+1))
    [void][AccNative]::GetWindowText($hwnd,$tb,$tb.Capacity)
    $title=[regex]::Replace($tb.ToString(),'[\x00-\x1F\x7F]','')
    $rootElement=[System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
    if ($null -eq $rootElement) { throw "uia" }
    $walker=[System.Windows.Automation.TreeWalker]::RawViewWalker
    $items=New-Object System.Collections.Generic.List[object]
    $stack=New-Object System.Collections.Stack
    $stack.Push([pscustomobject]@{ node=$rootElement; depth=0 })
    while ($stack.Count -gt 0 -and $items.Count -lt 2000) {
      $entry=$stack.Pop()
      $node=$entry.node
      $depth=[int]$entry.depth
      try {
        $current=$node.Current
        $rect=$current.BoundingRectangle
        if (-not $rect.IsEmpty -and $rect.Width -gt 0 -and $rect.Height -gt 0) {
          $role=$current.ControlType.ProgrammaticName -replace '^ControlType\.',''
          $name=[regex]::Replace([string]$current.Name,'[\x00-\x1F\x7F]','')
          $help=[regex]::Replace([string]$current.HelpText,'[\x00-\x1F\x7F]','')
          $automationId=[regex]::Replace([string]$current.AutomationId,'[\x00-\x1F\x7F]','')
          $runtimeId=""
          try { $runtimeId=(($node.GetRuntimeId()) -join ".") } catch {}
          $hasFocus=$false
          try { $hasFocus=[bool]$current.HasKeyboardFocus } catch {}
          $items.Add([pscustomobject]@{
            role=$role.ToLowerInvariant()
            label=if ([string]::IsNullOrWhiteSpace($name)) { $null } else { $name }
            description=if ([string]::IsNullOrWhiteSpace($help)) { $null } else { $help }
            value=$null
            bounds=[pscustomobject]@{ x=$rect.X; y=$rect.Y; width=$rect.Width; height=$rect.Height }
            center=[pscustomobject]@{ x=($rect.X + $rect.Width/2); y=($rect.Y + $rect.Height/2) }
            actionable=([bool]$current.IsEnabled -and -not [bool]$current.IsOffscreen -and ($actionableRoles -contains $role))
            focused=$hasFocus
            nativeRef=if ($automationId) { "automationId:" + $automationId } elseif ($runtimeId) { "runtimeId:" + $runtimeId } else { $null }
          })
        }
      } catch {}
      if ($depth -lt 14) {
        try {
          $children=New-Object System.Collections.Generic.List[object]
          $child=$walker.GetFirstChild($node)
          while ($null -ne $child) { $children.Add($child); $child=$walker.GetNextSibling($child) }
          for ($i=$children.Count-1; $i -ge 0; $i--) { $stack.Push([pscustomobject]@{ node=$children[$i]; depth=$depth+1 }) }
        } catch {}
      }
    }
    [uint32]$ownerAfter=0
    if (-not [AccNative]::IsWindow($hwnd)) { throw "gone" }
    [void][AccNative]::GetWindowThreadProcessId($hwnd,[ref]$ownerAfter)
    if ([int]$ownerAfter -ne $requestedPid) { throw "changed" }
    $out=[pscustomobject]@{
      type="elements"
      window=[pscustomobject]@{
        pid=$requestedPid; nativeId=$hwnd.ToInt64().ToString(); title=$title
        active=([AccNative]::GetForegroundWindow() -eq $hwnd)
        scaleFactor=([double]$dpi/96)
        bounds=[pscustomobject]@{ x=$r.Left; y=$r.Top; width=$w; height=$ht }
      }
      elements=$items
      warnings=@()
    }
    [Console]::Out.WriteLine(($out|ConvertTo-Json -Depth 6 -Compress))
    [Console]::Out.Flush()
  } catch {
    [Console]::Out.WriteLine('{"type":"error"}')
    [Console]::Out.Flush()
  }
}
`;

interface Waiter {
  resolve: (line: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

class AccessibilityHost {
  private child: ReturnType<typeof spawn> | null = null;
  private buffer = "";
  private waiter: Waiter | null = null;
  private queue: string[] = [];
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private busy = false;
  private readonly failure = new DesktopUiError(
    "ACCESSIBILITY_UNAVAILABLE", "Persistent accessibility host refused or stopped.",
  );

  private close(): void {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    const child = this.child;
    this.child = null;
    this.buffer = "";
    this.queue.length = 0;
    this.busy = false;
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      clearTimeout(waiter.timer);
      waiter.reject(this.failure);
    }
    if (child) {
      try { child.kill(); } catch { /* ignore */ }
      try { child.stdin?.destroy(); } catch { /* ignore */ }
      try { child.stdout?.destroy(); } catch { /* ignore */ }
    }
  }

  private readLine(): Promise<string> {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift()!);
    if (!this.child) return Promise.reject(this.failure);
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => this.close(), REQUEST_TIMEOUT_MS);
      timer.unref?.();
      this.waiter = { resolve, reject, timer };
    });
  }

  private async ensureStarted(): Promise<void> {
    if (this.child) return;
    const child = spawn(POWER_SHELL, [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
      Buffer.from(HOST_SCRIPT, "utf16le").toString("base64"),
    ], { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    const spawned = child;
    child.stderr?.resume();
    child.stdout?.on("data", (chunk: Buffer) => {
      if (this.child !== spawned) return;
      this.buffer += chunk.toString("utf8");
      if (this.buffer.length > MAX_LINE * 4) { this.close(); return; }
      for (;;) {
        const end = this.buffer.indexOf("\n");
        if (end < 0) break;
        const line = this.buffer.slice(0, end).trim();
        this.buffer = this.buffer.slice(end + 1);
        if (!line) continue;
        if (this.waiter) {
          const waiter = this.waiter;
          this.waiter = null;
          clearTimeout(waiter.timer);
          waiter.resolve(line);
        } else if (this.queue.length < 4) {
          this.queue.push(line);
        } else {
          this.close();
          return;
        }
      }
    });
    child.on("error", () => this.close());
    child.on("exit", () => this.close());
    const ready = JSON.parse(await this.readLine()) as { type?: string };
    if (ready?.type !== "ready") { this.close(); throw this.failure; }
  }

  async inspect(target: { pid: number; nativeId?: string }): Promise<AccessibilitySnapshot> {
    if (this.busy) throw this.failure;
    if (!Number.isSafeInteger(target.pid) || target.pid <= 0 ||
        typeof target.nativeId !== "string" || !/^[0-9]+$/.test(target.nativeId)) {
      throw this.failure;
    }
    this.busy = true;
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    try {
      await this.ensureStarted();
      this.child?.stdin?.write(JSON.stringify({ pid: target.pid, nativeId: target.nativeId }) + "\n");
      const response = JSON.parse(await this.readLine()) as {
        type?: string; window?: DesktopWindow; elements?: unknown[]; warnings?: string[];
      };
      if (response?.type !== "elements" || !response.window || !Array.isArray(response.elements)) {
        this.close();
        throw this.failure;
      }
      return {
        window: response.window,
        elements: response.elements as AccessibilitySnapshot["elements"],
        ...(Array.isArray(response.warnings) ? { warnings: response.warnings } : {}),
      };
    } catch (error) {
      this.close();
      throw error instanceof DesktopUiError ? error : this.failure;
    } finally {
      this.busy = false;
      if (this.child) {
        this.idleTimer = setTimeout(() => this.close(), IDLE_CLOSE_MS);
        this.idleTimer.unref?.();
      }
    }
  }
}

let sharedHost: AccessibilityHost | null = null;

/**
 * Inspect one window through the shared persistent host. Callers must fall back
 * to their one-shot implementation when this rejects.
 */
export async function inspectViaPersistentAccessibilityHost(
  target: { pid: number; nativeId?: string },
): Promise<AccessibilitySnapshot> {
  if (process.platform !== "win32") throw new DesktopUiError("ACCESSIBILITY_UNAVAILABLE", "Windows only.");
  if (!sharedHost) sharedHost = new AccessibilityHost();
  return sharedHost.inspect(target);
}

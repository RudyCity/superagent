/**
 * windowsAccessibilityHost.ts â€” one persistent UIAutomation helper process.
 *
 * One-shot accessibility inspection re-loads the UIAutomation assemblies and
 * re-creates the PowerShell host on every snapshot (~0.9 s). This module keeps a
 * single fixed-script carrier alive and re-validates the HWND, owner PID, root
 * status and visibility for every request, so repeated perception costs only the
 * tree walk.
 *
 * Chromium/Electron exposure (empirically verified on this host):
 * - With accessibility disabled a Chromium window exposes a ~15â€“40 node skeleton.
 *   Renderer accessibility starts only after a UIA client queries the window
 *   (and Chromium builds the real tree asynchronously, ~200â€“400 ms later).
 * - Once enabled, `ControlViewWalker` exposes the semantic control tree
 *   (buttons, list/tree items, text, data items) while `RawViewWalker` exposes a
 *   larger, more structural tree.
 * - Native XAML/Win32 apps behave the opposite way: `ControlView` hides content
 *   that `RawView` keeps (Windows Terminal: ~16 vs ~30 elements).
 *
 * The carrier therefore queries every same-process child window first (cheap
 * warm-up), walks ControlView with a bounded settle/retry for Chromium windows,
 * and only falls back to RawView when ControlView is starved. Raw signal flags
 * travel to TypeScript, where {@link normalizeAccessibilityElements} is the
 * single authority for element retention and the security-relevant
 * `actionable` flag.
 *
 * Fail open ONLY to the caller's fallback: any spawn/parse/protocol failure
 * closes the host and rejects, and `windows.ts` then uses the original one-shot
 * script. No executable path, script or argument is accepted from a caller.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { gzipSync } from "node:zlib";
import type { AccessibilitySnapshot, DesktopBounds, DesktopWindow } from "../types.js";
import { DesktopUiError } from "../errors.js";

const POWER_SHELL = path.win32.join(
  process.env.SystemRoot || process.env.windir || "C:\\Windows",
  "System32", "WindowsPowerShell", "v1.0", "powershell.exe",
);
const MAX_LINE = 2 * 1024 * 1024;
const IDLE_CLOSE_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;

const HOST_SCRIPT_BODY = String.raw`
$ErrorActionPreference="Stop"
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class AccNative {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public delegate bool EnumChildProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint f);
  [DllImport("user32.dll")] public static extern bool IsChild(IntPtr parent, IntPtr child);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumChildProc cb, IntPtr lp);
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

# The console output codepage cannot represent window text (emoji, em dashes)
# and substitutes raw control bytes that would corrupt the JSON line protocol.
# Write UTF-8 bytes directly instead of going through [Console]::Out.
$stdout = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), (New-Object System.Text.UTF8Encoding($false)))
$stdout.AutoFlush = $true
function Write-Line($text) { $stdout.WriteLine([string]$text) }

# Bounds of the walk. Depth 24 keeps Chromium web content reachable; the record
# cap stays bounded so one pathological page cannot flood the snapshot.
$maxDepth = 24
$maxElements = 2000
$maxVisited = 6000
# ControlView starvation threshold: below this, RawView is walked as well.
$controlFallbackMin = 48
# Chromium windows whose ControlView is still a skeleton are re-walked while the
# renderer builds accessibility (observed 15 -> 1019 elements within 400 ms).
$chromiumReadyMin = 24
$chromiumSettleMs = 180
$chromiumAttempts = 3
# Cheap pattern probes only for roles that can actually expose the pattern.
$valueRoles = @("Edit","Document","ComboBox","Spinner","Text")
$maxValueReads = 120
$expandableRoles = @("Custom","Group","Pane","DataItem","TreeItem","ListItem")

function Get-CleanText($value) {
  if ($null -eq $value) { return "" }
  return [regex]::Replace([string]$value,'[\x00-\x1F\x7F]','')
}

function Test-UsableRect($rect) {
  return (-not $rect.IsEmpty -and $rect.Width -gt 0 -and $rect.Height -gt 0)
}

function Get-ChildElements($walker, $node) {
  $children = New-Object System.Collections.ArrayList
  try {
    $child = $walker.GetFirstChild($node)
    while ($null -ne $child) {
      [void]$children.Add($child)
      $child = $walker.GetNextSibling($child)
    }
  } catch {}
  return $children
}

# One bounded depth-first walk. Records are raw UIA signals only: TypeScript
# decides retention and actionability. Children are still traversed for
# elements without a usable rectangle so a zero-size container never hides its
# descendants.
function Invoke-TreeWalk($walker, $rootNode, [int]$requestedPid, $hwnd, [int]$depthLimit, [int]$elementLimit) {
  $records = New-Object System.Collections.ArrayList
  $validCount = 0
  $visited = 0
  $valueReads = 0
  $stack = New-Object System.Collections.Stack
  $stack.Push([pscustomobject]@{ node = $rootNode; depth = 0 })
  while ($stack.Count -gt 0 -and $records.Count -lt $elementLimit -and $visited -lt $maxVisited) {
    $entry = $stack.Pop()
    $node = $entry.node
    $depth = [int]$entry.depth
    $visited++
    try {
      $current = $node.Current
      $rect = $current.BoundingRectangle
      if (Test-UsableRect $rect) {
        $validCount++
        $role = $current.ControlType.ProgrammaticName -replace '^ControlType\.',''
        if ($role -eq "Pane") {
          # Windows Forms recovers Button/Edit roles only from an exact
          # same-process child HWND of the verified root window.
          try {
            $nativeHandle = [IntPtr]([Int64]$current.NativeWindowHandle)
            if ($nativeHandle -ne [IntPtr]::Zero -and [AccNative]::IsWindow($nativeHandle)) {
              [uint32]$nativeOwner = 0
              [void][AccNative]::GetWindowThreadProcessId($nativeHandle, [ref]$nativeOwner)
              if ([int]$nativeOwner -eq $requestedPid -and [AccNative]::IsChild($hwnd, $nativeHandle)) {
                $classBuffer = New-Object System.Text.StringBuilder 256
                [void][AccNative]::GetClassName($nativeHandle, $classBuffer, $classBuffer.Capacity)
                $nativeClass = $classBuffer.ToString()
                if ($nativeClass -match '^WindowsForms10\.BUTTON\.') { $role = "Button" }
                elseif ($nativeClass -match '^WindowsForms10\.EDIT\.') { $role = "Edit" }
              }
            }
          } catch {}
        }
        $name = Get-CleanText $current.Name
        $help = Get-CleanText $current.HelpText
        $automationId = Get-CleanText $current.AutomationId
        $runtimeId = ""
        try { $runtimeId = (($node.GetRuntimeId()) -join ".") } catch {}
        $enabled = $false
        try { $enabled = [bool]$current.IsEnabled } catch {}
        $offscreen = $false
        try { $offscreen = [bool]$current.IsOffscreen } catch {}
        $focusable = $false
        try { $focusable = [bool]$current.IsKeyboardFocusable } catch {}
        $hasFocus = $false
        try { $hasFocus = [bool]$current.HasKeyboardFocus } catch {}
        $expandable = $false
        if ($expandableRoles -contains $role) {
          try {
            $expandPattern = $null
            if ($node.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$expandPattern)) {
              $expandable = $null -ne $expandPattern
            }
          } catch {}
        }
        $value = $null
        if ($valueReads -lt $maxValueReads -and ($valueRoles -contains $role)) {
          $valueReads++
          try {
            $valuePattern = $null
            if ($node.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$valuePattern)) {
              $value = Get-CleanText $valuePattern.Current.Value
            }
          } catch {}
        }
        [void]$records.Add([pscustomobject]@{
          role = $role.ToLowerInvariant()
          label = $name
          description = $help
          value = $value
          bounds = [pscustomobject]@{ x=$rect.X; y=$rect.Y; width=$rect.Width; height=$rect.Height }
          enabled = $enabled
          offscreen = $offscreen
          focusable = $focusable
          expandable = $expandable
          focused = $hasFocus
          automationId = $automationId
          runtimeId = $runtimeId
        })
      }
    } catch {}
    if ($depth -lt $depthLimit) {
      $children = Get-ChildElements $walker $node
      for ($i=$children.Count-1; $i -ge 0; $i--) {
        $stack.Push([pscustomobject]@{ node = $children[$i]; depth = $depth+1 })
      }
    }
  }
  return [pscustomobject]@{ records = $records; validCount = $validCount }
}

Write-Line '{"type":"ready"}'
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
    $rect=New-Object AccNative+RECT
    if (-not [AccNative]::GetWindowRect($hwnd,[ref]$rect)) { throw "bounds" }
    $windowWidth=$rect.Right-$rect.Left
    $windowHeight=$rect.Bottom-$rect.Top
    $dpi=[AccNative]::GetDpiForWindow($hwnd)
    if ($dpi -le 0 -or $windowWidth -le 0 -or $windowHeight -le 0) { throw "geometry" }
    $titleLength=[AccNative]::GetWindowTextLength($hwnd)
    $titleBuffer=New-Object System.Text.StringBuilder ([Math]::Max(1,$titleLength+1))
    [void][AccNative]::GetWindowText($hwnd,$titleBuffer,$titleBuffer.Capacity)
    $title=[regex]::Replace($titleBuffer.ToString(),'[\x00-\x1F\x7F]','')

    # Warm-up: enumerate same-process child windows of the verified root only,
    # then ask each for its UIA element. For Chromium this starts renderer
    # accessibility; for every other app it is a cheap read-only no-op.
    $childHandles = New-Object System.Collections.ArrayList
    $collectChildren = [AccNative+EnumChildProc]{
      param([IntPtr]$childHwnd, [IntPtr]$lParam)
      try {
        if ($childHandles.Count -lt 16) {
          [uint32]$childPid = 0
          [void][AccNative]::GetWindowThreadProcessId($childHwnd, [ref]$childPid)
          if ([int]$childPid -eq $requestedPid -and [AccNative]::IsChild($hwnd, $childHwnd)) {
            $childClass = New-Object System.Text.StringBuilder 256
            [void][AccNative]::GetClassName($childHwnd, $childClass, $childClass.Capacity)
            [void]$childHandles.Add([pscustomobject]@{ handle = $childHwnd; className = $childClass.ToString() })
          }
        }
      } catch {}
      return $true
    }
    [void][AccNative]::EnumChildWindows($hwnd, $collectChildren, [IntPtr]::Zero)
    $chromiumSurface = $false
    foreach ($child in $childHandles) {
      if ($child.className -eq "Chrome_RenderWidgetHostHWND" -or $child.className -like "Chrome_WidgetWin_*") {
        $chromiumSurface = $true
      }
    }
    # Only Chromium needs the child-window UIA query: it starts renderer
    # accessibility. Other apps pay nothing beyond the cheap class enumeration.
    if ($chromiumSurface) {
      foreach ($child in $childHandles) {
        try { [void][System.Windows.Automation.AutomationElement]::FromHandle($child.handle) } catch {}
      }
    }

    $controlWalker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $rootElement = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
    if ($null -eq $rootElement) { throw "uia" }
    $best = Invoke-TreeWalk $controlWalker $rootElement $requestedPid $hwnd $maxDepth $maxElements
    $attempts = 1
    while ($chromiumSurface -and $best.validCount -lt $chromiumReadyMin -and $attempts -lt $chromiumAttempts) {
      Start-Sleep -Milliseconds $chromiumSettleMs
      $rootElement = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
      if ($null -eq $rootElement) { throw "uia" }
      $next = Invoke-TreeWalk $controlWalker $rootElement $requestedPid $hwnd $maxDepth $maxElements
      if ($next.validCount -gt $best.validCount) { $best = $next }
      $attempts++
    }

    $rawRecords = New-Object System.Collections.ArrayList
    if ($best.validCount -lt $controlFallbackMin) {
      $rootElement = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
      if ($null -eq $rootElement) { throw "uia" }
      $rawWalk = Invoke-TreeWalk ([System.Windows.Automation.TreeWalker]::RawViewWalker) $rootElement $requestedPid $hwnd $maxDepth $maxElements
      $rawRecords = $rawWalk.records
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
        bounds=[pscustomobject]@{ x=$rect.Left; y=$rect.Top; width=$windowWidth; height=$windowHeight }
      }
      elements=$best.records
      rawElements=$rawRecords
      warnings=@()
    }
    Write-Line ($out|ConvertTo-Json -Depth 6 -Compress)
  } catch {
    Write-Line '{"type":"error"}'
  }
}
`;

// Windows caps a whole command line at 32,767 characters. The worker script is
// larger than that once UTF-16 base64 encoded (~33K at the time of writing), and
// an over-long spawn fails into the one-shot fallback. Deliver it as a
// gzip+base64 payload to a fixed bootstrap instead: the command line stays near
// 5.5K and keeps headroom for future walk logic. The payload is compiled from
// this module's own constant, so no caller-supplied script or path is involved.
const HOST_PAYLOAD = gzipSync(Buffer.from(HOST_SCRIPT_BODY, "utf8")).toString("base64");

const HOST_BOOTSTRAP = [
  "$ErrorActionPreference='Stop'",
  `$payload=[Convert]::FromBase64String('${HOST_PAYLOAD}')`,
  "$inputStream=New-Object System.IO.MemoryStream(,$payload)",
  "$gzip=New-Object System.IO.Compression.GZipStream($inputStream,[System.IO.Compression.CompressionMode]::Decompress)",
  "$reader=New-Object System.IO.StreamReader($gzip,[System.Text.Encoding]::UTF8)",
  "$script=$reader.ReadToEnd()",
  "$reader.Dispose();$gzip.Dispose();$inputStream.Dispose()",
  ". ([ScriptBlock]::Create($script))",
].join("; ");

/**
 * Roles that accept coordinate input only when the control is enabled, on
 * screen and visible in the snapshot. Kept deliberately narrow: a container or
 * text element must never become clickable merely because it is focusable.
 */
export const ACCESSIBILITY_ACTIONABLE_ROLES: readonly string[] = [
  "button",
  "edit",
  "hyperlink",
  "menuitem",
  "checkbox",
  "radiobutton",
  "combobox",
  "listitem",
  "tabitem",
  "slider",
  "spinner",
];

/** Chromium maps custom ARIA widgets to `custom`; an expandable one is real. */
const EXPANDABLE_ACTIONABLE_ROLES = new Set(["custom"]);
const ACTIONABLE_ROLES = new Set(ACCESSIBILITY_ACTIONABLE_ROLES);

/** Hard bound on one snapshot after merging both UIA views. */
export const ACCESSIBILITY_ELEMENT_LIMIT = 2000;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;
const FORBIDDEN_REF_CHARACTERS = /[\u0000-\u001f\u007f]/;

/**
 * Raw per-node signals emitted by the PowerShell carrier. This is the internal
 * wire shape, not the public snapshot shape; retention and actionability are
 * decided here in TypeScript so they can be unit tested without PowerShell.
 */
export interface RawAccessibilityElement {
  role?: unknown;
  label?: unknown;
  description?: unknown;
  value?: unknown;
  bounds?: { x?: unknown; y?: unknown; width?: unknown; height?: unknown };
  /** UIA `IsEnabled`. */
  enabled?: unknown;
  /** UIA `IsOffscreen`. */
  offscreen?: unknown;
  /** UIA `IsKeyboardFocusable`. */
  focusable?: unknown;
  /** `ExpandCollapse` pattern availability (Chromium widgets). */
  expandable?: unknown;
  /** UIA `HasKeyboardFocus` (legacy one-shot script: `focused`). */
  focused?: unknown;
  automationId?: unknown;
  runtimeId?: unknown;
  /** Legacy one-shot script: actionability computed inside PowerShell. */
  actionable?: unknown;
  /** Legacy one-shot script: pre-computed reference string. */
  nativeRef?: unknown;
}

export interface AccessibilityNormalizationOptions {
  /** Snapshot element bound after merging views. Defaults to {@link ACCESSIBILITY_ELEMENT_LIMIT}. */
  maxElements?: number;
  /**
   * Retain offscreen-but-present elements as read-only context. They can never
   * be actionable, and unlabeled structural nodes are always dropped.
   * Defaults to `true`.
   */
  retainOffscreen?: boolean;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(CONTROL_CHARACTERS, "");
  return cleaned.trim().length === 0 ? null : cleaned;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asBounds(value: unknown): DesktopBounds | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const x = asNumber(candidate.x);
  const y = asNumber(candidate.y);
  const width = asNumber(candidate.width);
  const height = asNumber(candidate.height);
  if (x === null || y === null || width === null || height === null) return null;
  // A zero/negative rectangle cannot be pointed at, so it is not perception.
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

function asRole(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const role = value.replace(CONTROL_CHARACTERS, "").trim().toLowerCase();
  if (!role) return null;
  return role.startsWith("controltype.") ? role.slice("controltype.".length) : role;
}

function asNativeRef(record: RawAccessibilityElement): string | undefined {
  const automationId = asText(record.automationId);
  if (automationId) return `automationId:${automationId}`;
  const runtimeId = asText(record.runtimeId);
  if (runtimeId) return `runtimeId:${runtimeId}`;
  if (typeof record.nativeRef === "string" && record.nativeRef.length > 0 &&
      record.nativeRef.length <= 256 && !FORBIDDEN_REF_CHARACTERS.test(record.nativeRef)) {
    return record.nativeRef;
  }
  return undefined;
}

/**
 * Decide actionability from raw UIA signals. The role allowlist is enforced on
 * every path, including legacy records whose PowerShell-computed flag is kept
 * only as an additional requirement. Offscreen elements are never actionable.
 */
function isActionable(
  role: string,
  record: RawAccessibilityElement,
  enabled: boolean | undefined,
  offscreen: boolean | undefined,
  expandable: boolean | undefined,
): boolean {
  if (enabled !== undefined && offscreen !== undefined) {
    if (!enabled || offscreen) return false;
  } else if (record.actionable !== true || offscreen === true) {
    return false;
  }
  return ACTIONABLE_ROLES.has(role) || (EXPANDABLE_ACTIONABLE_ROLES.has(role) && expandable === true);
}

function identityKey(role: string, nativeRef: string | undefined, bounds: DesktopBounds, label: string | null): string {
  const geometry = `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`;
  return nativeRef ? `${nativeRef}@${geometry}` : `${role}@${geometry}|${label ?? ""}`;
}

/**
 * Normalize raw UIA records from one or more views (ControlView first, then
 * RawView) into the public snapshot element shape.
 *
 * Retention rules:
 * - A usable rectangle is mandatory; unusable/empty rectangles are dropped.
 * - Offscreen elements are retained only while they carry a label, description
 *   or value, and only as read-only context (`actionable` is always false).
 *   Unlabeled offscreen structure is dropped to keep the snapshot signal dense.
 * - Duplicate identities keep the first (ControlView) occurrence.
 * - The merged list is bounded; actionable and focused elements are preserved
 *   first when the bound is exceeded.
 */
export function normalizeAccessibilityElements(
  records: readonly unknown[],
  options: AccessibilityNormalizationOptions = {},
): AccessibilitySnapshot["elements"] {
  const maxElements = Number.isSafeInteger(options.maxElements) && (options.maxElements as number) > 0
    ? (options.maxElements as number)
    : ACCESSIBILITY_ELEMENT_LIMIT;
  const retainOffscreen = options.retainOffscreen !== false;
  const normalized: AccessibilitySnapshot["elements"] = [];
  const seen = new Set<string>();
  const focusableIndexes = new Set<number>();
  for (const raw of records) {
    if (!raw || typeof raw !== "object") continue;
    const record = raw as RawAccessibilityElement;
    const role = asRole(record.role);
    if (!role) continue;
    const bounds = asBounds(record.bounds);
    if (!bounds) continue;
    const label = asText(record.label);
    const description = asText(record.description);
    const value = asText(record.value);
    const enabled = asBoolean(record.enabled);
    const offscreen = asBoolean(record.offscreen);
    const expandable = asBoolean(record.expandable);
    if (offscreen === true) {
      if (!retainOffscreen) continue;
      const labeled = label !== null || description !== null || value !== null;
      if (!labeled || enabled === false) continue;
    }
    const focused = asBoolean(record.focused);
    const focusable = asBoolean(record.focusable);
    const actionable = isActionable(role, record, enabled, offscreen, expandable);
    const nativeRef = asNativeRef(record);
    const key = identityKey(role, nativeRef, bounds, label);
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({
      role,
      label,
      description,
      value,
      bounds,
      center: {
        x: bounds.x + bounds.width / 2,
        y: bounds.y + bounds.height / 2,
      },
      actionable,
      ...(focused === undefined ? {} : { focused }),
      ...(nativeRef === undefined ? {} : { nativeRef }),
    });
    // IsKeyboardFocusable is not part of the public element shape, so it is only
    // used to rank which elements survive the bound (see below).
    if (focusable === true) focusableIndexes.add(normalized.length - 1);
  }
  if (normalized.length <= maxElements) return normalized;
  // Keep document order, but guarantee actionable/focused/focusable controls
  // survive the bound instead of being truncated away by a long structural tail.
  const ranked = normalized.map((element, index) => ({
    element,
    index,
    priority: (element.actionable ? 4 : 0) + (element.focused === true ? 2 : 0) +
      (focusableIndexes.has(index) ? 1 : 0),
  }));
  ranked.sort((left, right) => right.priority - left.priority || left.index - right.index);
  ranked.length = maxElements;
  ranked.sort((left, right) => left.index - right.index);
  return ranked.map((entry) => entry.element);
}

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
      "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", HOST_BOOTSTRAP,
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
        type?: string; window?: DesktopWindow; elements?: unknown[]; rawElements?: unknown[]; warnings?: string[];
      };
      if (response?.type !== "elements" || !response.window || !Array.isArray(response.elements)) {
        this.close();
        throw this.failure;
      }
      // ControlView records come first; RawView is only present when the
      // ControlView walk was starved. Duplicate identities keep ControlView.
      const merged = [
        ...response.elements,
        ...(Array.isArray(response.rawElements) ? response.rawElements : []),
      ];
      return {
        window: response.window,
        elements: normalizeAccessibilityElements(merged),
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


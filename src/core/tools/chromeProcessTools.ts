import os from "os";
import { exec } from "child_process";
import { promisify } from "util";
import { Tool } from "./types.js";
import { detectChromeProfiles } from "./chromeProfileTools.js";
import { runPsEncoded } from "./chromeCommon.js";

const execAsync = promisify(exec);

/**
 * Hard timeouts on every external scan: a process scan must never hang
 * the agent loop (cf. the get_active_browser_tabs incident — one hanging
 * call blocked the entire batch queue for minutes).
 */
const SCAN_TIMEOUT_MS = 30000;
const TABS_TIMEOUT_MS = 20000;

export interface ChromeWindowInfo {
  /** Win32 window handle; 0 when unavailable (non-Windows). */
  hwnd: number;
  /** Visible top-level window title (usually the active tab title + " - Google Chrome"). */
  title: string;
  /** Tab titles inside this window (best-effort via UI Automation; titles only, no URLs). */
  tabs: string[];
  /** False when tab enumeration was unavailable for this window. */
  tabsAvailable: boolean;
}

export interface ChromeBrowserInfo {
  pid: number;
  /** Profile directory name, e.g. "Profile 1". */
  profileDir: string;
  /** Display name from Chrome's Local State (e.g. "Eiyogen.digital"); falls back to profileDir. */
  profileName: string;
  startTime: string;
  /** EVERY visible top-level window of this browser (EnumWindows), not just the main one. */
  windows: ChromeWindowInfo[];
}

/**
 * Extract the --profile-directory value from a Chrome command line.
 * Handles the quoted form (--profile-directory="Profile 1") and the
 * bare form (--profile-directory=Default).
 */
export function extractProfileDir(commandLine: string): string | null {
  const m = commandLine.match(/--profile-directory=(?:"([^"]+)"|(\S+))/);
  if (!m) return null;
  return m[1] ?? m[2] ?? null;
}

/**
 * True when a command line belongs to a Chrome main browser process.
 * Renderers and other child processes carry a --type= flag; the main
 * browser process never does, but always carries --profile-directory=.
 */
export function isChromeBrowserMain(commandLine: string): boolean {
  return (
    commandLine.includes("--profile-directory=") &&
    !commandLine.includes("--type=")
  );
}

/**
 * Exact profile match used before killing: the parsed directory must
 * equal the requested name, so "Profile 1" never matches "Profile 10".
 */
export function isExactProfileMatch(
  commandLine: string,
  profileName: string
): boolean {
  return extractProfileDir(commandLine) === profileName;
}


/** Raw shapes emitted by the Windows scan scripts (unit-test seam). */
interface RawScanWindow {
  hwnd?: unknown;
  title?: unknown;
  tabs?: unknown;
  tabsAvailable?: unknown;
}

interface RawScanBrowser {
  pid?: unknown;
  commandLine?: unknown;
  startTime?: unknown;
  windows?: unknown;
}

/**
 * Parse the JSON emitted by the Windows browser+window scan into
 * ChromeBrowserInfo[]. Pure (no I/O) so it is unit-testable.
 * profileName is left as profileDir; call applyProfileDisplayNames() to enrich it.
 */
export function parseWindowsScanResult(raw: unknown): ChromeBrowserInfo[] {
  const items = (Array.isArray(raw) ? raw : [raw]) as RawScanBrowser[];
  const out: ChromeBrowserInfo[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const cmd = String(item.commandLine ?? "");
    if (!isChromeBrowserMain(cmd)) continue;
    const dir = extractProfileDir(cmd);
    if (!dir) continue;
    const windows: ChromeWindowInfo[] = [];
    const rawWindows = Array.isArray(item.windows)
      ? (item.windows as RawScanWindow[])
      : [];
    for (const w of rawWindows) {
      if (!w || typeof w !== "object") continue;
      const tabs = Array.isArray(w.tabs) ? w.tabs.map((t) => String(t)) : [];
      windows.push({
        hwnd: Number(w.hwnd) || 0,
        title: String(w.title ?? ""),
        tabs,
        tabsAvailable: Boolean(w.tabsAvailable),
      });
    }
    out.push({
      pid: Number(item.pid),
      profileDir: dir,
      profileName: dir,
      startTime: String(item.startTime ?? ""),
      windows,
    });
  }
  return out;
}

/**
 * Fill profileName from a directory-to-display-name map.
 * Falls back to profileDir when the directory is unknown. Pure.
 */
export function applyProfileDisplayNames(
  browsers: ChromeBrowserInfo[],
  names: Map<string, string>
): void {
  for (const b of browsers) {
    const n = names.get(b.profileDir);
    if (n) b.profileName = n;
  }
}

/** Best-effort directory-to-display-name map from Chrome's Local State. Never throws. */
async function loadProfileDisplayNames(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const profiles = await detectChromeProfiles();
    for (const p of profiles) {
      if (p.directoryName && p.name) map.set(p.directoryName, p.name);
    }
  } catch {
    /* Local State unreadable — callers fall back to directory names. */
  }
  return map;
}


/**
 * Scan running Chrome browser processes on Windows: CIM for the browser
 * mains plus a full EnumWindows pass so EVERY visible top-level window
 * per browser is reported. (Get-Process MainWindowTitle only ever returns
 * one window per process — a browser routinely owns several.)
 * String-keyed window map: CIM PIDs are UInt32 while lookups may be Int32,
 * and numeric type mismatch silently misses hashtable keys.
 */
async function scanWindowsBrowsers(): Promise<ChromeBrowserInfo[]> {
  const psScript = [
    `Add-Type @"`,
    `using System;`,
    `using System.Runtime.InteropServices;`,
    `using System.Text;`,
    `public class W32 {`,
    `  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);`,
    `  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);`,
    `  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);`,
    `  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);`,
    `  public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);`,
    `}`,
    `"@`,
    `$winMap = @{}`,
    `$cb = {`,
    `  param($h,$l)`,
    `  if ([W32]::IsWindowVisible($h)) {`,
    `    $sb = New-Object Text.StringBuilder 512`,
    `    [W32]::GetWindowText($h,$sb,512) | Out-Null`,
    `    $t = $sb.ToString()`,
    `    if ($t -ne "") {`,
    `      $procId = 0`,
    `      [W32]::GetWindowThreadProcessId($h,[ref]$procId) | Out-Null`,
    `      $k = "$procId"`,
    `      if (-not $winMap.ContainsKey($k)) { $winMap[$k] = @() }`,
    `      $winMap[$k] += @{ hwnd = [int64]$h; title = $t }`,
    `    }`,
    `  }`,
    `  return $true`,
    `}`,
    `[W32]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null`,
    `$result = @()`,
    `$procs = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'"`,
    `foreach ($p in $procs) {`,
    `  $cl = "$($p.CommandLine)"`,
    `  if ($cl -like '*--profile-directory=*' -and $cl -notlike '*--type=*') {`,
    `    $wins = @()`,
    `    foreach ($w in $winMap["$([int]$p.ProcessId)"]) {`,
    `      $wins += @{ hwnd = $w.hwnd; title = $w.title; tabs = @(); tabsAvailable = $false }`,
    `    }`,
    `    $result += @{ pid = [int]$p.ProcessId; commandLine = $cl; startTime = $p.CreationDate.ToString('yyyy-MM-dd HH:mm:ss'); windows = @($wins) }`,
    `  }`,
    `}`,
    `$result | ConvertTo-Json -Depth 5 -Compress`,
  ].join("\n");
  const stdout = await runPsEncoded(psScript, { maxBuffer: 10 * 1024 * 1024, timeout: SCAN_TIMEOUT_MS });
  const raw = stdout.trim();
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  return parseWindowsScanResult(parsed);
}


/**
 * Decode base64 UTF-8 tab titles produced by the UI Automation scan.
 * Tab titles are arbitrary web content (quotes, emoji, control chars);
 * base64 keeps them intact through PowerShell's ConvertTo-Json, which
 * mishandles some characters (e.g. unescaped quotes breaking JSON.parse).
 * Non-base64 input falls back to the raw string. Pure and testable.
 */
export function decodeTabTitles(raw: unknown[]): string[] {
  const out: string[] = [];
  for (const t of raw) {
    const s = String(t ?? "");
    if (!s) continue;
    try {
      out.push(Buffer.from(s, "base64").toString("utf8"));
    } catch {
      out.push(s);
    }
  }
  return out;
}

/**
 * Best-effort tab titles per window via UI Automation (Windows only).
 * Runs as a SEPARATE scan with its own short timeout so a UI Automation
 * stall can never break the reliable browser/window listing above.
 * On any failure the windows stay listed with tabsAvailable=false.
 * Note: titles only — UI Automation does not expose tab URLs.
 */
async function enrichWindowsTabs(browsers: ChromeBrowserInfo[]): Promise<void> {
  if (os.platform() !== "win32") return;
  const hwnds: number[] = [];
  for (const b of browsers)
    for (const w of b.windows) if (w.hwnd) hwnds.push(w.hwnd);
  if (hwnds.length === 0) return;
  const psScript = [
    `$hwnds = @(${hwnds.join(", ")})`,
    `$uiaOk = $false`,
    `try { Add-Type -AssemblyName UIAutomationClient; $uiaOk = $true } catch {}`,
    `$out = @()`,
    `foreach ($hwnd in $hwnds) {`,
    `  $tabs = @(); $ok = $false`,
    `  if ($uiaOk) {`,
    `    try {`,
    `      $el = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]([int64]$hwnd))`,
    `      if ($null -ne $el) {`,
    `        $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::TabItem)`,
    `        $found = $el.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)`,
    `        foreach ($t in $found) {`,
    `          try { $n = $t.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::NameProperty); if ($n) { $tabs += [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$n)) } } catch {}`,
    `        }`,
    `        if ($tabs.Count -gt 0) { $ok = $true }`,
    `      }`,
    `    } catch {}`,
    `  }`,
    `  $out += @{ hwnd = [int64]$hwnd; tabs = @($tabs); tabsAvailable = $ok }`,
    `}`,
    `$out | ConvertTo-Json -Depth 4 -Compress`,
  ].join("\n");
  try {
    const stdout = await runPsEncoded(psScript, { maxBuffer: 4 * 1024 * 1024, timeout: TABS_TIMEOUT_MS });
    const raw = stdout.trim();
    if (!raw) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const items = (Array.isArray(parsed) ? parsed : [parsed]) as Array<{
      hwnd?: unknown;
      tabs?: unknown;
      tabsAvailable?: unknown;
    }>;
    const byHwnd = new Map<number, { tabs: string[]; tabsAvailable: boolean }>();
    for (const it of items) {
      if (!it || typeof it !== "object") continue;
      byHwnd.set(Number(it.hwnd) || 0, {
        tabs: Array.isArray(it.tabs) ? decodeTabTitles(it.tabs) : [],
        tabsAvailable: Boolean(it.tabsAvailable),
      });
    }
    for (const b of browsers)
      for (const w of b.windows) {
        const hit = byHwnd.get(w.hwnd);
        if (hit) {
          w.tabs = hit.tabs;
          w.tabsAvailable = hit.tabsAvailable;
        }
      }
  } catch {
    /* best-effort: windows stay listed, tabs marked unavailable */
  }
}

/** Scan running Chrome browser processes on macOS/Linux via ps. */
async function scanPosixBrowsers(): Promise<ChromeBrowserInfo[]> {
  const { stdout } = await execAsync("ps -ax -o pid,lstart,command", {
    maxBuffer: 10 * 1024 * 1024,
    timeout: SCAN_TIMEOUT_MS,
  });
  const out: ChromeBrowserInfo[] = [];
  for (const line of stdout.split("\n")) {
    const m = line.match(
      /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/
    );
    if (!m) continue;
    const cmd = m[3];
    const exe = (cmd.trim().split(/\s+/)[0] || "").toLowerCase();
    if (!exe.includes("chrome")) continue;
    if (!isChromeBrowserMain(cmd)) continue;
    const dir = extractProfileDir(cmd);
    if (!dir) continue;
    out.push({
      pid: Number(m[1]),
      profileDir: dir,
      profileName: dir,
      startTime: m[2],
      windows: [],
    });
  }
  return out;
}

/** Platform-dispatched Chrome browser scan. */
async function scanChromeBrowsers(): Promise<ChromeBrowserInfo[]> {
  return os.platform() === "win32"
    ? scanWindowsBrowsers()
    : scanPosixBrowsers();
}

/**
 * scanChromeBrowsers() that never throws: returns the browsers, or an
 * error string the caller returns directly. Dedupe for the identical
 * scan try/catch in every chrome tool.
 */
async function safeScanChromeBrowsers(
  what: string
): Promise<{ browsers: ChromeBrowserInfo[] } | { error: string }> {
  try {
    return { browsers: await scanChromeBrowsers() };
  } catch (err: any) {
    return { error: `Failed to scan Chrome ${what}: ${err?.message || String(err)}` };
  }
}


/** One browser block of the list_running_chrome output. Exported for tests. */
export function formatBrowserBlock(b: ChromeBrowserInfo): string {
  const profileLabel =
    b.profileName && b.profileName !== b.profileDir
      ? `${b.profileDir} ("${b.profileName}")`
      : b.profileDir;
  const lines = [
    `PID ${b.pid} | Profile: ${profileLabel} | Started: ${b.startTime}`,
  ];
  if (b.windows.length === 0) {
    lines.push(`  (no visible windows enumerated)`);
  }
  for (const w of b.windows) {
    lines.push(`  Window: "${w.title}"`);
    if (w.tabsAvailable && w.tabs.length > 0) {
      lines.push(
        `    Tabs (${w.tabs.length}): ${w.tabs.map((t) => `"${t}"`).join(" | ")}`
      );
    } else {
      lines.push(`    Tabs: unavailable`);
    }
  }
  return lines.join("\n");
}

export const listRunningChromeTool: Tool = {
  name: "list_running_chrome",
  description:
    "List currently running Google Chrome browser processes: PID, profile directory + display name, start time, EVERY visible window per browser (full top-level enumeration via EnumWindows, not just the main window), and best-effort tab titles per window (UI Automation; titles only, no URLs; reported as unavailable when inaccessible). One browser process per open profile. All scans run under strict timeouts and never hang.",
  parameters: {
    type: "object",
    properties: {},
  },
  execute: async () => {
    const scanned = await safeScanChromeBrowsers("processes");
    if ("error" in scanned) return scanned.error;
    const browsers = scanned.browsers;
    if (browsers.length === 0) {
      return "No running Chrome browser processes found.";
    }
    try {
      applyProfileDisplayNames(browsers, await loadProfileDisplayNames());
    } catch {
      /* display names are a nicety; directory names still work */
    }
    try {
      await enrichWindowsTabs(browsers);
    } catch {
      /* tabs are best-effort; the window list stands on its own */
    }
    return [
      `### Running Chrome browsers (${browsers.length})`,
      ...browsers.map(formatBrowserBlock),
      ``,
      `_Tabs_: titles only (no URLs). Tab data is UI-Automation best-effort and marked unavailable when inaccessible. Scans run under strict timeouts and never hang._`,
    ].join("\n");
  },
};

export const closeChromeProfileTool: Tool = {
  name: "close_chrome_profile",
  description:
    'Terminate the Chrome browser process whose command line carries exactly --profile-directory="<profileName>" (e.g. "Profile 1"; "Profile 1" will NOT match "Profile 10"). WARNING: Chrome hosts every profile of one instance in a SINGLE shared browser process -- terminating it closes EVERY visible window of EVERY profile using that process, not just the named profile. To close one window gracefully, use close_chrome_window instead.',
  parameters: {
    type: "object",
    properties: {
      profileName: {
        type: "string",
        description:
          'Directory name of the Chrome profile to close (e.g. "Profile 1"). Must match exactly.',
      },
    },
    required: ["profileName"],
  },
  execute: async ({ profileName }: { profileName?: string }) => {
    const target = (profileName || "").trim();
    if (!target) {
      return "profileName is required and must not be empty.";
    }
    const scanned = await safeScanChromeBrowsers("processes");
    if ("error" in scanned) return scanned.error;
    const browsers = scanned.browsers;
    const victims = browsers.filter((b) => b.profileDir === target);
    if (victims.length === 0) {
      return `No running Chrome browser found for profile "${target}". Nothing was closed.`;
    }
    const killed: number[] = [];
    const failed: string[] = [];
    // Windows enumerated BEFORE termination: the honest blast-radius figure.
    const windowCount = victims.reduce((n, b) => n + b.windows.length, 0);
    for (const b of victims) {
      try {
        // b.pid comes from our own scan: always a plain integer, safe for shell.
        if (os.platform() === "win32") {
          await execAsync(`taskkill /F /PID ${b.pid}`);
        } else {
          await execAsync(`kill ${b.pid}`);
        }
        killed.push(b.pid);
      } catch (err: any) {
        failed.push(`PID ${b.pid}: ${err?.message || String(err)}`);
      }
    }
    const parts = [
      `Closed Chrome profile "${target}": ${killed.length} process(es) terminated${
        killed.length > 0 ? ` (PID ${killed.join(", ")})` : ""
      }.`,
      `WARNING: Chrome shares one browser process across profiles -- this closed ${windowCount} visible window(s) across ALL profiles using the terminated process, not just "${target}".`,
    ];
    if (failed.length > 0) parts.push(`Failed: ${failed.join("; ")}`);
    return parts.join("\n");
  },
};
/** A scanned window together with its owning browser. Pure shape. */
export interface ChromeWindowHit {
  browser: ChromeBrowserInfo;
  window: ChromeWindowInfo;
}

/**
 * Find a window by exact HWND across all scanned browsers. Pure.
 * Only windows present in the scan can be targeted -- never send
 * WM_CLOSE to a foreign handle.
 */
export function findWindowByHwnd(
  browsers: ChromeBrowserInfo[],
  hwnd: number
): ChromeWindowHit | null {
  for (const b of browsers) {
    for (const w of b.windows) {
      if (w.hwnd === hwnd) return { browser: b, window: w };
    }
  }
  return null;
}

/**
 * Find windows whose title contains the substring (case-insensitive). Pure.
 */
export function findWindowsByTitle(
  browsers: ChromeBrowserInfo[],
  titleSubstring: string
): ChromeWindowHit[] {
  const q = titleSubstring.toLowerCase();
  const out: ChromeWindowHit[] = [];
  for (const b of browsers) {
    for (const w of b.windows) {
      if (w.title.toLowerCase().includes(q)) out.push({ browser: b, window: w });
    }
  }
  return out;
}

/**
 * Send WM_CLOSE (0x0010) to a top-level window: graceful close, the
 * browser process and every other window stay alive. Windows-only.
 * PowerShell via -EncodedCommand (UTF-16LE base64) avoids quoting pitfalls.
 */
async function sendWmClose(hwnd: number): Promise<void> {
  const ps = [
    `Add-Type @"`,
    `using System;`,
    `using System.Runtime.InteropServices;`,
    `public class W32WmClose {`,
    `  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);`,
    `}`,
    `"@`,
    `[W32WmClose]::SendMessage([IntPtr]${hwnd}, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null`,
  ].join("\n");
  await runPsEncoded(ps, { nonInteractive: true, maxBuffer: 1024 * 1024, timeout: 15000 });
}

export const closeChromeWindowTool: Tool = {
  name: "close_chrome_window",
  description:
    "Gracefully close ONE Chrome window via WM_CLOSE (the window closes normally; the browser process and all other windows stay alive). Identify the window by HWND (from list_running_chrome) or by a title substring. Safer than close_chrome_profile, which terminates the whole shared browser process. Windows only.",
  parameters: {
    type: "object",
    properties: {
      hwnd: {
        type: "number",
        description:
          "Window handle (HWND) from list_running_chrome output. Exact match; must belong to a scanned Chrome window.",
      },
      titleSubstring: {
        type: "string",
        description:
          "Case-insensitive substring of the window title. Must match exactly ONE window; zero or ambiguous matches are rejected without action.",
      },
    },
  },
  execute: async ({
    hwnd,
    titleSubstring,
  }: {
    hwnd?: number;
    titleSubstring?: string;
  }) => {
    if (os.platform() !== "win32") {
      return "close_chrome_window is only supported on Windows.";
    }
    const sub = (titleSubstring || "").trim();
    if (hwnd === undefined && !sub) {
      return "Provide hwnd (from list_running_chrome) or titleSubstring.";
    }
    if (hwnd !== undefined && (!Number.isInteger(hwnd) || hwnd <= 0)) {
      return `Invalid hwnd "${hwnd}": must be a positive integer from list_running_chrome.`;
    }
    const scanned = await safeScanChromeBrowsers("windows");
    if ("error" in scanned) return scanned.error;
    const browsers = scanned.browsers;
    let target: ChromeWindowHit;
    if (hwnd !== undefined) {
      const hit = findWindowByHwnd(browsers, hwnd);
      if (!hit) {
        return `No scanned Chrome window has HWND ${hwnd}. Nothing was closed. Run list_running_chrome to see current windows.`;
      }
      target = hit;
    } else {
      const hits = findWindowsByTitle(browsers, sub);
      if (hits.length === 0) {
        return `No Chrome window title matches "${sub}". Nothing was closed.`;
      }
      if (hits.length > 1) {
        const list = hits
          .map((h) => `HWND ${h.window.hwnd}: "${h.window.title}"`)
          .join("; ");
        return `Title "${sub}" matched ${hits.length} windows -- refusing to guess. Nothing was closed. Be more specific or use hwnd. Matches: ${list}`;
      }
      target = hits[0];
    }
    try {
      await sendWmClose(target.window.hwnd);
    } catch (err: any) {
      return `Failed to close window "${target.window.title}" (HWND ${target.window.hwnd}): ${err?.message || String(err)}`;
    }
    return `Sent WM_CLOSE to window "${target.window.title}" (HWND ${target.window.hwnd}, PID ${target.browser.pid}). The browser process was NOT terminated; other windows are unaffected.`;
  },
};












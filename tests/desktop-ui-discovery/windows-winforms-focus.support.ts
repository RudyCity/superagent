/**
 * Focus capability gate and bounded pre-flight for the native Windows Desktop UI
 * E2E fixture.
 *
 * The WinForms fixture is a real top-level window, but exclusive foreground
 * authority is not something a CI runner (or a developer with any other window
 * in front) can guarantee. This module reports what the machine can actually
 * provide instead of letting the test assert a foreground state that never
 * existed:
 *
 * - `windowExists`, `visible` and `minimized` are hard preconditions. A missing
 *   one fails with a message that names it, not with an assertion diff.
 * - foreground ownership, input-desktop availability and `UserInteractive` are
 *   capability facts. Focus-dependent assertions skip with the concrete reason
 *   unless `SUPERAGENT_E2E_REQUIRE_FOCUS=1` turns them into a strict attended
 *   certification.
 *
 * Never steal focus outside the attended certification: a default CI run must
 * remain invisible to the operator's foreground window.
 */
import path from "node:path";
import { execa } from "execa";

export const isWindows = process.platform === "win32";

/** Attended certification mode. Turns every focus skip into a hard failure. */
export const requireFocus = process.env.SUPERAGENT_E2E_REQUIRE_FOCUS === "1";

const powershell = path.win32.join(
  process.env.SystemRoot || process.env.windir || "C:\\Windows",
  "System32", "WindowsPowerShell", "v1.0", "powershell.exe",
);

const FIXTURE_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class SuperAgentWinformsForeground {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint from, uint to, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hwnd);
  public static bool TryFocusOwnWindow(IntPtr target) {
    if (target == IntPtr.Zero) return false;
    IntPtr current = GetForegroundWindow();
    if (current == target) return true;
    uint currentThread = GetCurrentThreadId();
    uint ignoredPid;
    uint foregroundThread = GetWindowThreadProcessId(current, out ignoredPid);
    bool attached = foregroundThread != 0 && foregroundThread != currentThread
      && AttachThreadInput(currentThread, foregroundThread, true);
    try {
      BringWindowToTop(target);
      SetForegroundWindow(target);
      return GetForegroundWindow() == target;
    } finally {
      if (attached) AttachThreadInput(currentThread, foregroundThread, false);
    }
  }
}
"@
[System.Windows.Forms.Application]::EnableVisualStyles()
$form = New-Object System.Windows.Forms.Form
$form.Text = $env:SUPERAGENT_DESKTOP_UI_DISCOVERY_TITLE
$form.Width = 520
$form.Height = 340
$form.StartPosition = "Manual"
$form.Location = New-Object System.Drawing.Point(120,120)
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$form.ShowInTaskbar = $false
$button = New-Object System.Windows.Forms.Button
$button.Text = "Inspect Me"
$button.AccessibleName = "Inspect Me"
$button.Location = New-Object System.Drawing.Point(30,30)
$button.Size = New-Object System.Drawing.Size(160,45)
$button.TabStop = $false
$button.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
$button.BackColor = [System.Drawing.Color]::LightGray
$button.FlatAppearance.MouseOverBackColor = $button.BackColor
$button.FlatAppearance.MouseDownBackColor = $button.BackColor
$form.Controls.Add($button)
$timeout = New-Object System.Windows.Forms.Timer
$timeout.Interval = 60000
$timeout.Add_Tick({ $timeout.Stop(); $form.Close() })
$timeout.Start()
$form.Add_Shown({
  [void]$form.BeginInvoke([Action]{
    $form.ActiveControl = $null
    $form.Refresh()
    $claimedForeground = "0"
    if ($env:SUPERAGENT_E2E_FOCUS_ATTEMPT -eq "1") {
      try {
        if ([SuperAgentWinformsForeground]::TryFocusOwnWindow($form.Handle)) { $claimedForeground = "1" }
      } catch {
        $claimedForeground = "0"
      }
    }
    [Console]::Out.WriteLine("READY|" + $PID + "|" + $form.Handle.ToInt64() + "|" + $claimedForeground)
    [Console]::Out.Flush()
  })
})
[System.Windows.Forms.Application]::Run($form)
`;

const PROBE_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class SuperAgentWinformsFocusProbe {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll", SetLastError=true)] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint desiredAccess);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool CloseDesktop(IntPtr hDesktop);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool GetUserObjectInformation(IntPtr hObj, int nIndex, StringBuilder pvInfo, int nLength, out int lengthNeeded);
}
"@
$payload = ConvertFrom-Json $env:SUPERAGENT_E2E_FOCUS_PAYLOAD
$requestedPid = [int]$payload.pid
$nativeId = [string]$payload.nativeId
$hwnd = [IntPtr]([Int64]::Parse($nativeId))
$processRunning = $null -ne (Get-Process -Id $requestedPid -ErrorAction SilentlyContinue)
$windowExists = [SuperAgentWinformsFocusProbe]::IsWindow($hwnd)
$visible = $windowExists -and [SuperAgentWinformsFocusProbe]::IsWindowVisible($hwnd)
$minimized = $windowExists -and [SuperAgentWinformsFocusProbe]::IsIconic($hwnd)
$foregroundWindow = [SuperAgentWinformsFocusProbe]::GetForegroundWindow()
$foreground = $null
if ($foregroundWindow -ne [IntPtr]::Zero) {
  [uint32]$foregroundPid = 0
  [void][SuperAgentWinformsFocusProbe]::GetWindowThreadProcessId($foregroundWindow, [ref]$foregroundPid)
  $titleLength = [SuperAgentWinformsFocusProbe]::GetWindowTextLength($foregroundWindow)
  $titleBuffer = New-Object System.Text.StringBuilder ([Math]::Max(1, $titleLength + 1))
  [void][SuperAgentWinformsFocusProbe]::GetWindowText($foregroundWindow, $titleBuffer, $titleBuffer.Capacity)
  $foreground = [pscustomobject]@{
    nativeId = $foregroundWindow.ToInt64().ToString()
    pid = [int]$foregroundPid
    title = [regex]::Replace($titleBuffer.ToString(), '[\x00-\x1F\x7F]', '')
  }
}
$inputDesktop = [SuperAgentWinformsFocusProbe]::OpenInputDesktop(0, $false, 0x0001)
$inputDesktopAvailable = $inputDesktop -ne [IntPtr]::Zero
$desktopName = $null
if ($inputDesktopAvailable) {
  try {
    $nameBuffer = New-Object System.Text.StringBuilder 512
    [int]$nameBytes = 0
    if ([SuperAgentWinformsFocusProbe]::GetUserObjectInformation($inputDesktop, 2, $nameBuffer, 1024, [ref]$nameBytes)) {
      $desktopName = [regex]::Replace($nameBuffer.ToString(), '[\x00-\x1F\x7F]', '')
    }
  } finally {
    [void][SuperAgentWinformsFocusProbe]::CloseDesktop($inputDesktop)
  }
}
[pscustomobject]@{
  pid = $requestedPid
  nativeId = $nativeId
  processRunning = $processRunning
  windowExists = $windowExists
  visible = $visible
  minimized = $minimized
  foreground = $foreground
  fixtureForeground = ($foregroundWindow -ne [IntPtr]::Zero -and $foregroundWindow -eq $hwnd)
  inputDesktopAvailable = $inputDesktopAvailable
  userInteractive = [Environment]::UserInteractive
  desktopName = $desktopName
} | ConvertTo-Json -Depth 5 -Compress
`;

export type FixtureProcess = ReturnType<typeof execa>;

export type FocusProbe = {
  pid: number;
  nativeId: string;
  processRunning: boolean;
  windowExists: boolean;
  visible: boolean;
  minimized: boolean;
  foreground: { nativeId: string; pid: number; title: string } | null;
  fixtureForeground: boolean;
  inputDesktopAvailable: boolean;
  userInteractive: boolean;
  desktopName: string | null;
};

export type FixtureHandle = {
  child: FixtureProcess;
  pid: number;
  nativeId: string;
  title: string;
  /** True when the fixture itself claimed the foreground during an attended run. */
  claimedForeground: boolean;
};

function encodePowerShell(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

function awaitReady(
  child: FixtureProcess,
  timeoutMs: number,
): Promise<{ pid: number; nativeId: string; claimedForeground: boolean }> {
  return new Promise((resolve, reject) => {
    let output = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(
      () => finish(undefined, new Error(
        `Windows discovery fixture did not become ready within ${timeoutMs} ms`
        + `${stderr.trim() ? `. stderr: ${stderr.trim().slice(0, 800)}` : ""}`,
      )),
      timeoutMs,
    );
    const finish = (
      result?: { pid: number; nativeId: string; claimedForeground: boolean },
      error?: Error,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.off("data", onStdout);
      child.stderr?.off("data", onStderr);
      child.off("error", onError);
      child.off("exit", onExit);
      if (error) reject(error);
      else if (result) resolve(result);
    };
    const onError = (error: Error) => finish(undefined, error);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => finish(
      undefined,
      new Error(
        `Windows discovery fixture exited before READY (code ${String(code)}, signal ${String(signal)})`
        + `${stderr.trim() ? `. stderr: ${stderr.trim().slice(0, 800)}` : ""}`,
      ),
    );
    const onStderr = (data: Buffer) => {
      stderr += data.toString();
    };
    const onStdout = (data: Buffer) => {
      output += data.toString();
      const match = output.match(/READY\|(\d+)\|(\d+)\|([01])/);
      if (match) {
        finish({ pid: Number(match[1]), nativeId: match[2], claimedForeground: match[3] === "1" });
      }
    };
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.on("error", onError);
    child.on("exit", onExit);
  });
}

/**
 * Spawn the disposable WinForms fixture. `attemptFocus` is used only by the
 * attended certification so a default run never steals the operator's focus.
 */
export async function startWindowsWinformsFixture(
  title: string,
  options: { attemptFocus?: boolean; readyTimeoutMs?: number } = {},
): Promise<FixtureHandle> {
  const child = execa(
    powershell,
    ["-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", encodePowerShell(FIXTURE_SCRIPT)],
    {
      reject: false,
      buffer: false,
      windowsHide: false,
      env: {
        SUPERAGENT_DESKTOP_UI_DISCOVERY_TITLE: title,
        ...(options.attemptFocus === true ? { SUPERAGENT_E2E_FOCUS_ATTEMPT: "1" } : {}),
      },
    },
  );
  try {
    const ready = await awaitReady(child, options.readyTimeoutMs ?? 12000);
    return { child, title, ...ready };
  } catch (error) {
    await terminateFixture(child);
    throw error;
  }
}

export async function terminateFixture(child: FixtureProcess): Promise<void> {
  child.kill("SIGTERM");
  const exited = await Promise.race([
    child.then(() => true, () => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2500)),
  ]);
  if (!exited) child.kill("SIGKILL");
}

function focusProbeFrom(value: unknown, pid: number, nativeId: string): FocusProbe {
  const raw = value as Record<string, any> | null | undefined;
  if (!raw || typeof raw !== "object") {
    throw new Error(`Fixture pre-flight probe returned no JSON object for pid ${pid} / nativeId ${nativeId}.`);
  }
  const foreground = raw.foreground;
  return {
    pid,
    nativeId,
    processRunning: raw.processRunning === true,
    windowExists: raw.windowExists === true,
    visible: raw.visible === true,
    minimized: raw.minimized === true,
    foreground: foreground && typeof foreground === "object" && typeof foreground.nativeId === "string"
      ? {
        nativeId: foreground.nativeId,
        pid: Number.isFinite(foreground.pid) ? Number(foreground.pid) : -1,
        title: typeof foreground.title === "string" ? foreground.title : "",
      }
      : null,
    fixtureForeground: raw.fixtureForeground === true,
    inputDesktopAvailable: raw.inputDesktopAvailable === true,
    userInteractive: raw.userInteractive === true,
    desktopName: typeof raw.desktopName === "string" ? raw.desktopName : null,
  };
}

/**
 * Read one focus/visibility fact set for the fixture. Bounded to 15 s so a hung
 * Windows API cannot stall the suite.
 */
export async function readFocusProbe(pid: number, nativeId: string): Promise<FocusProbe> {
  let result: Awaited<ReturnType<typeof execa>>;
  try {
    result = await execa(
      powershell,
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(PROBE_SCRIPT)],
      {
        reject: false,
        timeout: 15000,
        windowsHide: true,
        env: { SUPERAGENT_E2E_FOCUS_PAYLOAD: JSON.stringify({ pid, nativeId }) },
      },
    );
  } catch (error) {
    throw new Error(`Fixture pre-flight probe could not run: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (result.exitCode !== 0) {
    const detail = `${result.stderr || ""} ${result.stdout || ""}`.trim();
    throw new Error(
      `Fixture pre-flight probe failed for pid ${pid} / nativeId ${nativeId}: `
      + `${result.timedOut ? "probe timed out after 15000 ms" : detail || `exit code ${String(result.exitCode)}`}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(`Fixture pre-flight probe returned invalid JSON for pid ${pid} / nativeId ${nativeId}.`);
  }
  return focusProbeFrom(parsed, pid, nativeId);
}

function preconditionFailure(probe: FocusProbe, label: string): Error {
  const identity = `${label} fixture window (pid ${probe.pid}, nativeId ${probe.nativeId})`;
  if (!probe.processRunning) {
    return new Error(`Pre-flight failed: ${identity} process is no longer running. The WinForms fixture exited before assertions could run.`);
  }
  if (!probe.windowExists) {
    return new Error(`Pre-flight failed: ${identity} does not exist. The WinForms fixture form was never created or was destroyed.`);
  }
  if (!probe.visible) {
    return new Error(`Pre-flight failed: ${identity} exists but is not visible. The fixture must stay shown for the duration of the test.`);
  }
  return new Error(`Pre-flight failed: ${identity} is minimized. Restore the window (attended) or avoid minimizing it; native capture refuses minimized windows.`);
}

/** Fail with the missing precondition named, instead of an assertion diff. */
export function assertFixturePreconditions(probe: FocusProbe, label: string): void {
  if (probe.processRunning && probe.windowExists && probe.visible && !probe.minimized) return;
  throw preconditionFailure(probe, label);
}

/**
 * Bounded pre-flight: poll until the fixture window is created, visible and not
 * minimized, then return the last capability probe. Fails with the exact
 * missing precondition once the deadline passes.
 */
export async function awaitFixturePreflight(
  fixture: FixtureHandle,
  label: string,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<FocusProbe> {
  const timeoutMs = options.timeoutMs ?? 15000;
  const intervalMs = options.intervalMs ?? 250;
  const deadline = Date.now() + timeoutMs;
  let last: FocusProbe | null = null;
  for (;;) {
    last = await readFocusProbe(fixture.pid, fixture.nativeId);
    if (last.processRunning && last.windowExists && last.visible && !last.minimized) return last;
    if (!last.processRunning && !last.windowExists) throw preconditionFailure(last, label);
    if (Date.now() >= deadline) throw preconditionFailure(last, label);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Human-readable foreground owner for failure and skip messages. */
export function describeForeground(probe: FocusProbe): string {
  if (!probe.foreground) return "no foreground window";
  return `pid ${probe.foreground.pid} (${JSON.stringify(probe.foreground.title)})`;
}

/**
 * Why the fixture cannot prove foreground authority on this machine, or `null`
 * when it can. These are the only conditions that gate focus assertions.
 */
export function focusUnavailableReason(probe: FocusProbe): string | null {
  if (!probe.inputDesktopAvailable) {
    return `no interactive input desktop is available${probe.desktopName ? ` (desktop ${JSON.stringify(probe.desktopName)})` : ""}; the Windows session may be locked, disconnected or headless`;
  }
  if (!probe.userInteractive) return "PowerShell reports Environment.UserInteractive = false";
  if (!probe.foreground) return "Windows reports no foreground window";
  if (!probe.fixtureForeground) {
    return `another window owns the foreground: ${describeForeground(probe)}`;
  }
  return null;
}

/** Attended certification: the fixture must own the foreground. */
export function assertForegroundAuthority(probe: FocusProbe, subject: string): void {
  const reason = focusUnavailableReason(probe);
  if (!reason) return;
  throw new Error(
    `SUPERAGENT_E2E_REQUIRE_FOCUS=1 foreground certification failed for ${subject}: ${reason}. `
    + "Bring the fixture window to the front and re-run attended, or unset SUPERAGENT_E2E_REQUIRE_FOCUS for the focus-gated CI mode.",
  );
}

/**
 * Why background-window behaviour cannot be proven, or `null` when the fixture
 * is not foreground (any other window or no foreground window is enough for the
 * native input refusal path). Gated separately from foreground authority.
 */
export function backgroundUnavailableReason(background: FocusProbe): string | null {
  if (!background.inputDesktopAvailable) {
    return `no interactive input desktop is available${background.desktopName ? ` (desktop ${JSON.stringify(background.desktopName)})` : ""}; the Windows session may be locked, disconnected or headless`;
  }
  if (!background.userInteractive) return "PowerShell reports Environment.UserInteractive = false";
  if (background.fixtureForeground) {
    return `the background fixture itself owns the foreground (${describeForeground(background)}); native input would legitimately be accepted, so background rejection cannot be proven`;
  }
  return null;
}

/** Attended certification: a different fixture window must own the foreground. */
export function assertBackgroundAuthority(background: FocusProbe, occluder: FocusProbe): void {
  if (background.fixtureForeground) {
    throw new Error(
      `SUPERAGENT_E2E_REQUIRE_FOCUS=1 background certification failed: the background fixture (pid ${background.pid}, nativeId ${background.nativeId}) owns the foreground. `
      + "A different window must be in front to certify native input refusal.",
    );
  }
  const reason = focusUnavailableReason(occluder);
  if (!reason) return;
  throw new Error(
    `SUPERAGENT_E2E_REQUIRE_FOCUS=1 background certification failed: the occluder fixture (pid ${occluder.pid}, nativeId ${occluder.nativeId}) did not take the foreground: ${reason}. `
    + "Bring the occluder fixture to the front and re-run attended, or unset SUPERAGENT_E2E_REQUIRE_FOCUS for the focus-gated CI mode.",
  );
}

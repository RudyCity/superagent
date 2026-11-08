import { execa } from "execa";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import {
  DesktopUiConsentManager, DesktopUiSessionManager,
  desktopUiConsentManager,
} from "../../src/core/tools/desktopUiTools.js";
import { dispatchDesktopUiMcpTool } from "../../src/core/mcp/tools/desktopUiMcpTools.js";

const enabled = process.platform === "win32" && process.env.SUPERAGENT_DESKTOP_UI_NATIVE_E2E === "1";
const hostTest = enabled ? it : it.skip;
const readOnlyEnabled = process.platform === "win32"
  && process.env.SUPERAGENT_DESKTOP_UI_READONLY_E2E === "1";
const readOnlyHostTest = readOnlyEnabled ? it : it.skip;

const powershell = path.win32.join(
  process.env.SystemRoot || "C:\Windows",
  "System32", "WindowsPowerShell", "v1.0", "powershell.exe",
);

const fixtureScript = String.raw`
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class FixtureForeground {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint from, uint to, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool HideCaret(IntPtr hwnd);
  public static bool TryFocusOwnWindow(IntPtr target) {
    IntPtr previous = GetForegroundWindow();
    if (previous == target) return true;
    uint currentThread = GetCurrentThreadId();
    uint ignoredPid;
    uint foregroundThread = GetWindowThreadProcessId(previous, out ignoredPid);
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

$form = New-Object System.Windows.Forms.Form
$form.Text = $env:SUPERAGENT_DESKTOP_UI_TEST_TITLE
$form.Width = 540
$form.Height = 340
$form.StartPosition = "Manual"
$form.Location = New-Object System.Drawing.Point(100,100)
$form.TopMost = $true
$form.FormBorderStyle = "FixedSingle"
$form.MaximizeBox = $false

$button = New-Object System.Windows.Forms.Button
$button.Text = "Fixture Click"
$button.AccessibleName = "Fixture Click"
$button.AccessibleRole = [System.Windows.Forms.AccessibleRole]::PushButton
$button.Location = New-Object System.Drawing.Point(20,20)
$button.Size = New-Object System.Drawing.Size(180,45)

$script:textBox = New-Object System.Windows.Forms.TextBox
$script:textBox.AccessibleName = "Fixture Input"
$script:textBox.AccessibleRole = [System.Windows.Forms.AccessibleRole]::Text
$script:textBox.Location = New-Object System.Drawing.Point(20,95)
$script:textBox.Size = New-Object System.Drawing.Size(320,35)
$script:textBox.Text = ""

$label = New-Object System.Windows.Forms.Label
$label.Text = "Click count: 0"
$label.Location = New-Object System.Drawing.Point(20,160)
$label.Size = New-Object System.Drawing.Size(300,30)

$script:clickCount = 0
function Save-FixtureState {
  $state = @{ clicks=$script:clickCount; text=$script:textBox.Text }
  [System.IO.File]::WriteAllText(
    $env:SUPERAGENT_DESKTOP_UI_TEST_STATE,
    ($state | ConvertTo-Json -Compress)
  )
}
$button.Add_Click({
  $script:clickCount += 1
  $label.Text = "Click count: $script:clickCount"
  Save-FixtureState
})
$script:textBox.Add_GotFocus({ [void][FixtureForeground]::HideCaret($script:textBox.Handle) })
$script:textBox.Add_TextChanged({
  [void][FixtureForeground]::HideCaret($script:textBox.Handle)
  Save-FixtureState
})
$form.Controls.AddRange([System.Windows.Forms.Control[]]@($button,$script:textBox,$label))

$timeout = New-Object System.Windows.Forms.Timer
$timeout.Interval = 180000
$timeout.Add_Tick({ $timeout.Stop(); $form.Close() })
$timeout.Start()

Save-FixtureState
$form.Show()
if ($env:SUPERAGENT_DESKTOP_UI_TEST_INPUT_FOCUS -eq "1") {
  $form.BringToFront()
  $form.Activate()
  $focusSucceeded = [FixtureForeground]::TryFocusOwnWindow($form.Handle)
  [Console]::Error.WriteLine("FIXTURE_FOCUS_ATTEMPT=" + $focusSucceeded + " foregroundHWND=" + [FixtureForeground]::GetForegroundWindow().ToInt64())
}

[Console]::Out.WriteLine("READY|" + $PID + "|" + $form.Handle.ToInt64())
[Console]::Out.Flush()
[System.Windows.Forms.Application]::Run($form)
`;

function awaitReady(child: ReturnType<typeof execa>): Promise<{ pid: number; nativeId: string }> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("Windows fixture did not become ready")), 12000);
    const finish = (result?: { pid: number; nativeId: string }, error?: Error) => {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.off("error", onError);
      if (error) reject(error);
      else if (result) resolve(result);
    };
    const onError = (error: Error) => finish(undefined, error);
    const onData = (data: Buffer) => {
      output += data.toString();
      const match = output.match(/READY\|(\d+)\|(\d+)/);
      if (match) finish({ pid: Number(match[1]), nativeId: match[2] });
      if (output.length > 8192) finish(undefined, new Error("Unexpected fixture startup output"));
    };
    child.stdout?.on("data", onData);
    child.on("error", onError);
  });
}

async function waitForState(file: string, predicate: (state: { clicks: number; text: string }) => boolean) {
  let lastState: { clicks: number; text: string } | null = null;
  for (let attempt = 0; attempt < 35; attempt++) {
    const state = JSON.parse(await readFile(file, "utf8")) as { clicks: number; text: string };
    lastState = state;
    if (predicate(state)) return state;
    await Bun.sleep(100);
  }
  throw new Error("Fixture state did not change as expected: " + JSON.stringify(lastState));
}

async function terminateFixture(child: ReturnType<typeof execa>): Promise<void> {
  child.kill("SIGTERM");
  const exited = async () => Promise.race([
    child.then(() => true, () => true),
    Bun.sleep(2500).then(() => false),
  ]);
  if (await exited()) return;
  child.kill("SIGKILL");
  if (!(await exited())) {
    throw new Error("Temporary WinForms process did not exit after termination requests.");
  }
}

async function startFixture(allowTestInput = false) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "superagent-desktop-native-e2e-"));
  const stateFile = path.join(dir, "state.json");
  const title = "SuperAgent Native E2E " + randomUUID();
  const encoded = Buffer.from(fixtureScript, "utf16le").toString("base64");
  const child = execa(powershell, ["-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", encoded], {
    reject: false,
    buffer: false,
    windowsHide: false,
    env: {
      SUPERAGENT_DESKTOP_UI_TEST_TITLE: title,
      SUPERAGENT_DESKTOP_UI_TEST_STATE: stateFile,
      SUPERAGENT_DESKTOP_UI_TEST_INPUT_FOCUS: allowTestInput ? "1" : "0",
    },
  });
  try {
    const target = await awaitReady(child);
    return {
      ...target,
      title,
      stateFile,
      async close() {
        await terminateFixture(child);
        await rm(dir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await terminateFixture(child);
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

readOnlyHostTest("Windows host: real WinForms screenshot and accessibility roles", async () => {
  const fixture = await startFixture();
  const manager = new DesktopUiSessionManager(new DesktopUiConsentManager());
  try {
    const opened = await manager.openSession({
      pid: fixture.pid,
      nativeId: fixture.nativeId,
      title: fixture.title,
      ownerPrincipal: "windows-readonly-e2e",
      allowInput: false,
      enableVision: false,
    });
    expect(opened.inputAllowed).toBe(false);
    const snapshot = await manager.snapshot({
      sessionToken: opened.sessionToken,
      ownerPrincipal: "windows-readonly-e2e",
    });
    expect(snapshot.schema.windows).toHaveLength(1);
    expect(snapshot.schema.screenshot.targetWindow.pid).toBe(fixture.pid);
    expect(snapshot.schema.screenshot.targetWindow.nativeId).toBe(fixture.nativeId);
    expect(snapshot.schema.screenshot.width).toBeGreaterThan(200);
    expect(snapshot.schema.screenshot.height).toBeGreaterThan(100);
    expect(snapshot.schema.elements.some((element) =>
      element.source === "accessibility"
      && element.role === "button"
      && element.label === "Fixture Click"
      && element.actionable,
    )).toBe(true);
    expect(snapshot.schema.elements.some((element) =>
      element.source === "accessibility"
      && element.role === "edit"
      && element.actionable,
    )).toBe(true);
    expect(manager.closeSession(opened.sessionToken, "windows-readonly-e2e").closed).toBe(true);
  } finally {
    manager.clearAllSessions();
    await fixture.close();
  }
}, 30000);

hostTest("Windows host: scoped screenshot, real click, type, key and non-clicking scroll", async () => {
  const fixture = await startFixture(true);
  const { pid, nativeId, title, stateFile } = fixture;
  const consent = new DesktopUiConsentManager();
  const manager = new DesktopUiSessionManager(consent);

  try {
    consent.grantConsent({ pid, nativeId, ttlMs: 60000 });
    const opened = await manager.openSession({
      pid, nativeId, title,
      ownerPrincipal: "windows-fixture-e2e",
      allowInput: true,
      enableVision: false,
    });
    expect(opened.inputAllowed).toBe(true);

    const owner = "windows-fixture-e2e";
    const getSnapshot = async () => (await manager.snapshot({
      sessionToken: opened.sessionToken, ownerPrincipal: owner,
    })).schema;
    const initial = await getSnapshot();
    expect(initial.windows[0].active, "Fixture HWND must be foreground before native input").toBe(true);
    const button = initial.elements.find((element) =>
      element.source === "accessibility" && element.actionable
      && element.label?.includes("Fixture Click"),
    );
    expect(button, "Expected a verified WinForms button: " + JSON.stringify(
      initial.elements.slice(0, 40).map(({ id, role, label, actionable }) =>
        ({ id, role, label, actionable })),
    )).toBeDefined();
    const click = await manager.action({
      sessionToken: opened.sessionToken, ownerPrincipal: owner,
      action: "click", elementId: button!.id,
      expectedRevision: initial.screenshot.revision,
      expectedHash: initial.screenshot.sha256,
    });
    expect(click.dispatched).toBe(true);
    await waitForState(stateFile, (state) => state.clicks === 1);

    const afterClick = await getSnapshot();
    const textboxes = afterClick.elements.filter((element) =>
      element.source === "accessibility"
      && element.role === "edit"
      && element.actionable,
    );
    expect(textboxes, "Fixture must expose exactly one verified editable WinForms child").toHaveLength(1);
    const textbox = textboxes[0];
    const typed = await manager.action({
      sessionToken: opened.sessionToken, ownerPrincipal: owner,
      action: "type", elementId: textbox.id, text: "NativeE2E123",
      expectedRevision: afterClick.screenshot.revision,
      expectedHash: afterClick.screenshot.sha256,
    });
    expect(typed.dispatched).toBe(true);
    await waitForState(stateFile, (state) => state.text === "NativeE2E123");

    // The WinForms text caret can blink between a snapshot and the pre-input
    // SHA check. Refresh only on pre-dispatch STALE_SCREENSHOT, never when the
    // OS may already have received an event.
    let tabDispatched = false;
    for (let attempt = 0; attempt < 6; attempt++) {
      const beforeTab = await getSnapshot();
      try {
        const receipt = await manager.action({
          sessionToken: opened.sessionToken, ownerPrincipal: owner,
          action: "key", key: "TAB",
          expectedRevision: beforeTab.screenshot.revision,
          expectedHash: beforeTab.screenshot.sha256,
        });
        expect(receipt.dispatched).toBe(true);
        tabDispatched = true;
        break;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "STALE_SCREENSHOT")) {
          throw error;
        }
      }
    }
    expect(tabDispatched, "TAB should dispatch after bounded pre-dispatch refreshes").toBe(true);

    const afterKey = await getSnapshot();
    const scrollTarget = afterKey.elements.find((element) =>
      element.source === "accessibility" && element.actionable
      && element.label?.includes("Fixture Click"),
    );
    expect(scrollTarget).toBeDefined();
    await manager.action({
      sessionToken: opened.sessionToken, ownerPrincipal: owner,
      action: "scroll", elementId: scrollTarget!.id, deltaY: -1, deltaX: 0,
      expectedRevision: afterKey.screenshot.revision,
      expectedHash: afterKey.screenshot.sha256,
    });
    const finalState = await waitForState(stateFile, (state) =>
      state.clicks === 1 && state.text === "NativeE2E123",
    );
    expect(finalState.clicks).toBe(1);
    expect(manager.closeSession(opened.sessionToken, owner).closed).toBe(true);
    expect(manager.getSession(opened.sessionToken, owner)).toBeNull();
  } finally {
    manager.clearAllSessions();
    await fixture.close();
  }
}, 150000);


hostTest("Windows host: MCP principal-bound native probe, open, click, snapshot, and close", async () => {
  const fixture = await startFixture(true);
  const principal = "windows-native-mcp-e2e";
  const context = { principalId: principal, workspace: process.cwd() };
  const consentId = desktopUiConsentManager.grantConsent({
    pid: fixture.pid,
    nativeId: fixture.nativeId,
    ttlMs: 60_000,
  });
  let sessionToken: string | null = null;

  const invoke = async (args: Record<string, unknown>) => {
    const result = await dispatchDesktopUiMcpTool("superagent_desktop_ui", args, context);
    expect(result?.isError, JSON.stringify(result?.content)).not.toBe(true);
    const content = result?.content[0];
    expect(content?.type).toBe("text");
    if (content?.type !== "text") throw new Error("MCP tool did not return JSON text.");
    return JSON.parse(content.text);
  };

  try {
    const capabilities = await invoke({ command: "probe" });
    expect(capabilities.success).toBe(true);
    expect(capabilities.capabilities.available).toBe(true);

    const opened = await invoke({
      command: "open",
      pid: fixture.pid, nativeId: fixture.nativeId, title: fixture.title,
      allowInput: true,
    });
    sessionToken = opened.session.sessionToken;
    expect(opened.session.inputAllowed).toBe(true);

    const forbidden = await dispatchDesktopUiMcpTool(
      "superagent_desktop_ui",
      { command: "snapshot", sessionToken },
      { principalId: "different-mcp-principal", workspace: process.cwd() },
    );
    expect(forbidden?.isError).toBe(true);

    const snap = await invoke({
      command: "snapshot", sessionToken, includeScreenshotImage: false,
    });
    const schema = snap.schema;
    const buttons = schema.elements.filter((element: {
      source: string; role: string; label: string | null; actionable: boolean;
    }) => element.source === "accessibility" && element.role === "button"
      && element.label === "Fixture Click" && element.actionable);
    expect(buttons).toHaveLength(1);

    const clicked = await invoke({
      command: "action", action: "click", sessionToken,
      elementId: buttons[0].id,
      expectedRevision: schema.screenshot.revision,
      expectedHash: schema.screenshot.sha256,
    });
    expect(clicked.receipt.dispatched).toBe(true);
    await waitForState(fixture.stateFile, (state) => state.clicks === 1);

    const closed = await invoke({ command: "close", sessionToken });
    expect(closed.closed).toBe(true);
    sessionToken = null;
  } finally {
    if (sessionToken) {
      await dispatchDesktopUiMcpTool("superagent_desktop_ui", {
        command: "close", sessionToken,
      }, context);
    }
    desktopUiConsentManager.revokeConsent(consentId);
    await fixture.close();
  }
}, 90000);

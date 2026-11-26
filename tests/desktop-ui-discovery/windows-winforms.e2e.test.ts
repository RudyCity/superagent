import { randomUUID, createHash } from "node:crypto";
import path from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { createWindowsDesktopUiAdapter } from "../../src/core/desktopUi/adapters/windows.js";
import { resolveNativeDesktopExecutable } from "../../src/core/desktopUi/nativeExecutableIdentity.js";
import { DesktopUiConsentManager, DesktopUiSessionManager } from "../../src/core/tools/desktopUiTools.js";

const isWindows = process.platform === "win32";
const powershell = path.win32.join(
  process.env.SystemRoot || process.env.windir || "C:\Windows",
  "System32", "WindowsPowerShell", "v1.0", "powershell.exe",
);

const fixtureScript = String.raw`
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
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
    [Console]::Out.WriteLine("READY|" + $PID + "|" + $form.Handle.ToInt64())
    [Console]::Out.Flush()
  })
})
[System.Windows.Forms.Application]::Run($form)
`;

function awaitReady(child: ReturnType<typeof execa>): Promise<{ pid: number; nativeId: string }> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("Windows discovery fixture did not become ready")), 12000);
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
    };
    child.stdout?.on("data", onData);
    child.on("error", onError);
  });
}

async function terminate(child: ReturnType<typeof execa>): Promise<void> {
  child.kill("SIGTERM");
  const exited = await Promise.race([
    child.then(() => true, () => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2500)),
  ]);
  if (!exited) child.kill("SIGKILL");
}

describe.skipIf(!isWindows)("Windows native window discovery E2E", () => {
  it("lists and read-only inspects an exact disposable WinForms top-level window", async () => {
    const title = `SuperAgent Discovery ${randomUUID()}`;
    const encoded = Buffer.from(fixtureScript, "utf16le").toString("base64");
    const child = execa(powershell, ["-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", encoded], {
      reject: false,
      buffer: false,
      windowsHide: false,
      env: { SUPERAGENT_DESKTOP_UI_DISCOVERY_TITLE: title },
    });
    try {
      const target = await awaitReady(child);
      const adapter = createWindowsDesktopUiAdapter();
      const listed = await adapter.listWindows!(100);
      const fixture = listed.windows.find((window) =>
        window.pid === target.pid && window.nativeId === target.nativeId && window.title === title,
      );
      expect(fixture).toBeDefined();
      expect(fixture).toMatchObject({
        pid: target.pid,
        nativeId: target.nativeId,
        title,
        application: expect.stringMatching(/powershell/i),
      });
      expect(fixture!.bounds.width).toBeGreaterThan(0);
      expect(fixture!.bounds.height).toBeGreaterThan(0);
      expect(fixture!.scaleFactor).toBeGreaterThan(0);

      const active = await adapter.getActiveWindow!();
      if (fixture!.active) expect(active?.nativeId).toBe(fixture!.nativeId);

      // Establish that this fixture has painted stable pixels before the real
      // session's independent stale-screenshot and window identity checks.
      await expect.poll(async () => {
        const first = await adapter.capture(target);
        const second = await adapter.capture(target);
        return first.targetWindow.nativeId === target.nativeId &&
          second.targetWindow.nativeId === target.nativeId &&
          createHash("sha256").update(first.image).digest("hex") ===
            createHash("sha256").update(second.image).digest("hex");
      }, { timeout: 12000, interval: 100 }).toBe(true);

      const manager = new DesktopUiSessionManager(new DesktopUiConsentManager());
      const inspected = await manager.inspectWindow({
        pid: target.pid,
        nativeId: target.nativeId,
        ownerPrincipal: "windows-discovery-e2e",
        adapter,
      });
      expect(inspected.schema.screenshot.targetWindow.nativeId).toBe(target.nativeId);
      expect(inspected.schema.elements.some((element) =>
        element.source === "accessibility" && element.role === "button" && element.label === "Inspect Me",
      )).toBe(true);
      expect(inspected).not.toHaveProperty("screenshotImage");
      expect(manager.getActiveSessionsCount()).toBe(0);
    } finally {
      await terminate(child);
    }
  }, 45000);

  it("inspects and opens a view-only session on an occluded background window while rejecting background input", async () => {
    const bgTitle = `SuperAgent BgView ${randomUUID()}`;
    const fgTitle = `SuperAgent Occluder ${randomUUID()}`;
    const encoded = Buffer.from(fixtureScript, "utf16le").toString("base64");
    const bgChild = execa(powershell, ["-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", encoded], {
      reject: false,
      buffer: false,
      windowsHide: false,
      env: { SUPERAGENT_DESKTOP_UI_DISCOVERY_TITLE: bgTitle },
    });
    let fgChild: ReturnType<typeof execa> | null = null;
    try {
      const bgTarget = await awaitReady(bgChild);
      fgChild = execa(powershell, ["-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", encoded], {
        reject: false,
        buffer: false,
        windowsHide: false,
        env: { SUPERAGENT_DESKTOP_UI_DISCOVERY_TITLE: fgTitle },
      });
      const fgTarget = await awaitReady(fgChild);
      const adapter = createWindowsDesktopUiAdapter();
      const identity = await resolveNativeDesktopExecutable(bgTarget.pid);
      expect(identity).not.toBeNull();

      let bgListed: Awaited<ReturnType<NonNullable<typeof adapter.listWindows>>>["windows"][number] | undefined;
      await expect.poll(async () => {
        const listed = await adapter.listWindows!(100);
        bgListed = listed.windows.find(
          (w) => w.pid === bgTarget.pid && w.nativeId === bgTarget.nativeId && w.title === bgTitle,
        );
        const fgListed = listed.windows.find(
          (w) => w.pid === fgTarget.pid && w.nativeId === fgTarget.nativeId && w.title === fgTitle,
        );
        return Boolean(bgListed && !bgListed.active && fgListed);
      }, { timeout: 12000, interval: 150 }).toBe(true);

      await expect.poll(async () => {
        const first = await adapter.capture(bgTarget);
        const second = await adapter.capture(bgTarget);
        return !first.targetWindow.active &&
          first.targetWindow.nativeId === bgTarget.nativeId &&
          createHash("sha256").update(first.image).digest("hex") ===
            createHash("sha256").update(second.image).digest("hex");
      }, { timeout: 12000, interval: 100 }).toBe(true);

      const manager = new DesktopUiSessionManager(new DesktopUiConsentManager(), {
        permanentRegistry: () => ({
          version: 2,
          defaultEffect: "deny",
          rules: [{
            id: "e2e-bg-view-input",
            kind: "desktop",
            effect: "allow",
            app: identity!,
            operations: ["view", "input"],
            scope: { windowTitle: bgTitle },
          }],
        }),
      });

      const inspected = await manager.inspectWindow({
        pid: bgTarget.pid,
        nativeId: bgTarget.nativeId,
        ownerPrincipal: "windows-bg-view-e2e",
        includeScreenshotImage: true,
        adapter,
      });
      expect(inspected.window.active).toBe(false);
      expect(inspected.screenshotImage).toBeTruthy();
      expect(inspected.schema.elements.some((element) =>
        element.source === "accessibility" && element.role === "button" && element.label === "Inspect Me",
      )).toBe(true);

      const viewSession = await manager.openSession({
        pid: bgTarget.pid,
        nativeId: bgTarget.nativeId,
        title: bgTitle,
        ownerPrincipal: "windows-bg-view-e2e",
        allowInput: false,
        adapter,
      });
      expect(viewSession.inputAllowed).toBe(false);
      const snap = await manager.snapshot({
        sessionToken: viewSession.sessionToken,
        ownerPrincipal: "windows-bg-view-e2e",
      });
      expect(snap.schema.screenshot.targetWindow.active).toBe(false);
      manager.closeSession(viewSession.sessionToken, "windows-bg-view-e2e");

      await expect(manager.openSession({
        pid: bgTarget.pid,
        nativeId: bgTarget.nativeId,
        title: bgTitle,
        ownerPrincipal: "windows-bg-view-e2e",
        allowInput: true,
        adapter,
      })).rejects.toMatchObject({ code: "TARGET_NOT_ACTIVE" });
    } finally {
      if (fgChild) await terminate(fgChild);
      await terminate(bgChild);
    }
  }, 60000);
});

import { randomUUID } from "node:crypto";
import path from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { NativeWindowPreviewManager } from "../../src/core/desktopUi/livePreview.js";
import { createWindowsDesktopUiAdapter } from "../../src/core/desktopUi/adapters/windows.js";
import { NativeDesktopApprovalGuard } from "../../src/core/desktopUi/nativeApprovalProof.js";
import { RemoteHostCaptureBridge } from "../../src/core/desktopUi/remoteHostCapture.js";
import { RemoteLiveSessionPolicy } from "../../src/core/desktopUi/remoteSessionPolicy.js";
import { RemoteViewerFrameGate } from "../../src/core/desktopUi/remoteViewerFrames.js";

const powershell = path.win32.join(
  process.env.SystemRoot || process.env.windir || "C:\\Windows",
  "System32", "WindowsPowerShell", "v1.0", "powershell.exe",
);
const fixtureScript = String.raw`
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$form = New-Object System.Windows.Forms.Form
$form.Text = $env:SUPERAGENT_REMOTE_HOST_FIXTURE
$form.Width = 420
$form.Height = 310
$form.StartPosition = "Manual"
$form.Location = New-Object System.Drawing.Point(220,180)
$label = New-Object System.Windows.Forms.Label
$label.Text = "Disposable exact-window host capture test"
$label.Location = New-Object System.Drawing.Point(25,25)
$label.Size = New-Object System.Drawing.Size(340,60)
$form.Controls.Add($label)
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 20000
$timer.Add_Tick({ $form.Close() })
$timer.Start()
$form.Show()
[Console]::Out.WriteLine("READY|" + $PID + "|" + $form.Handle.ToInt64())
[Console]::Out.Flush()
[System.Windows.Forms.Application]::Run($form)
`;

function ready(child: ReturnType<typeof execa>): Promise<{ pid: number; nativeId: string }> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => finish(undefined, Error("Disposable WinForms fixture did not start")), 12_000);
    function finish(value?: { pid: number; nativeId: string }, error?: Error) {
      clearTimeout(timeout);
      child.stdout?.off("data", onData);
      child.off("error", onError);
      if (error) reject(error);
      else if (value) resolve(value);
    }
    function onData(chunk: Buffer) {
      output += chunk.toString();
      const match = /READY\|(\d+)\|(\d+)/.exec(output);
      if (match) finish({ pid: Number(match[1]), nativeId: match[2] });
    }
    function onError(error: Error) { finish(undefined, error); }
    child.stdout?.on("data", onData);
    child.on("error", onError);
  });
}

async function closeFixture(child: ReturnType<typeof execa>) {
  child.kill("SIGTERM");
  if (!(await Promise.race([
    child.then(() => true, () => true),
    new Promise<boolean>(resolve => setTimeout(() => resolve(false), 2500)),
  ]))) {
    child.kill("SIGKILL"); // Only this disposable child PID; never a SuperAgent service.
  }
}

describe.skipIf(process.platform !== "win32")("Windows disposable WinForms remote host capture", () => {
  it("captures real approved HWND JPEG and offers it through the private frame gate", async () => {
    const title = "SuperAgent Remote Host Fixture " + randomUUID();
    const child = execa(powershell, [
      "-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand",
      Buffer.from(fixtureScript, "utf16le").toString("base64"),
    ], {
      reject: false, buffer: false, windowsHide: false,
      env: { SUPERAGENT_REMOTE_HOST_FIXTURE: title },
    });
    try {
      const fixture = await ready(child);
      const manager = new NativeWindowPreviewManager(() => createWindowsDesktopUiAdapter());
      const selected = (await manager.discover()).windows.find(
        win => win.pid === fixture.pid && win.nativeId === fixture.nativeId && win.title === title,
      );
      expect(selected).toBeDefined();
      const pin = {
        pid: selected!.pid, nativeId: selected!.nativeId, title: selected!.title,
        application: selected!.application, bounds: selected!.bounds,
      };
      const target = {
        pid: pin.pid, nativeId: pin.nativeId, consent: true,
        expectedTitle: pin.title, expectedApplication: pin.application, expectedBounds: pin.bounds,
      };
      // The production private Tray supplies this proof; only test-generated
      // evidence is used here. This test never installs a Tray or starts a listener.
      const key = Buffer.alloc(32, 7);
      const guard = new NativeDesktopApprovalGuard(() => key);
      const nonce = guard.issue().nonce;
      const preview = await manager.start(guard.consume({
        ...target, approvalProof: {
          nonce, mac: NativeDesktopApprovalGuard.computeProofForTest(key, target, nonce),
        },
      }));
      const sessions = new RemoteLiveSessionPolicy({
        verifyHostApproval: async evidence => evidence.window.nativeId === pin.nativeId,
        verifyViewerProof: async evidence => evidence.connectionId === "fixture-connection-001",
      });
      const transport = {
        connectionId: "fixture-connection-001", authenticatedViewerId: "fixture-viewer-0001",
        origin: "https://private.fixture.example", tlsVerified: true,
        privateIngressVerified: true, publicTunnelDetected: false, forwardedHeadersPresent: false,
      };
      const intent = {
        hostId: "fixture-host-0001", viewerId: transport.authenticatedViewerId,
        expectedOrigin: transport.origin, window: pin,
      };
      const challenge = sessions.beginNativeApproval(intent);
      const host = await sessions.approveNative({
        nonce: challenge.nonce, proof: "attended-native-fixture-proof",
      });
      const viewer = await sessions.attachViewer({
        sessionId: host.sessionId, proof: "independent-fixture-proof", transport,
      });
      const auth = { sessionId: host.sessionId, csrfToken: viewer.csrfToken, transport };
      const bridge = RemoteHostCaptureBridge.claim(manager, preview.token, sessions, auth);
      try {
        const frame = await bridge.capture();
        expect(frame.window).toEqual(pin);
        expect(frame.jpeg.length).toBeGreaterThan(256);
        expect(frame.jpeg.length).toBeLessThanOrEqual(512 * 1024);
        const gate = new RemoteViewerFrameGate(sessions);
        const sent: unknown[] = [];
        const sink = {
          connectionId: transport.connectionId, bufferedBytes: () => 0,
          sendBinary: (packet: unknown) => { sent.push(packet); return true; },
        };
        expect(gate.offer(auth, frame, sink)).toEqual({ sequence: 1 });
        expect(sent).toHaveLength(1);
        expect(gate.receiveViewerMessage(auth, { version: 1, type: "ack", sequence: 1 }))
          .toEqual({ acknowledged: 1 });
      } finally {
        bridge.close();
        expect(manager.stop({ token: preview.token })).toEqual({ stopped: true });
      }
    } finally {
      await closeFixture(child);
    }
  }, 45_000);
});

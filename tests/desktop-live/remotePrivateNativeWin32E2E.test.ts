/**
 * Real Windows native HWND -> private mTLS -> independent viewer integration.
 * Host approval HMAC is TEST-ONLY; no installed Tray, remote bind, or user app.
 */
import { createHash, randomUUID, X509Certificate } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer as createTlsServer } from "node:tls";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NativeWindowPreviewManager } from "../../src/core/desktopUi/livePreview.js";
import { createWindowsDesktopUiAdapter } from "../../src/core/desktopUi/adapters/windows.js";
import { NativeDesktopApprovalGuard } from "../../src/core/desktopUi/nativeApprovalProof.js";
import { RemotePrivateTransportBridge, REMOTE_PRIVATE_ALPN } from "../../src/core/desktopUi/remotePrivateTransport.js";
import { RemotePrivateLiveRuntime } from "../../src/core/desktopUi/remotePrivateLiveRuntime.js";
import { connectRemotePrivateViewerClient } from "../../src/core/desktopUi/remotePrivateViewerClient.js";

const windowsOnly = process.platform === "win32";
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
$label.Text = "Disposable exact-window mTLS viewer test"
$label.Location = New-Object System.Drawing.Point(25,25)
$label.Size = New-Object System.Drawing.Size(340,60)
$form.Controls.Add($label)
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 18000
$timer.Add_Tick({ $form.Close() })
$timer.Start()
$form.Show()
[Console]::Out.WriteLine("READY|" + $PID + "|" + $form.Handle.ToInt64())
[Console]::Out.Flush()
[System.Windows.Forms.Application]::Run($form)
`;
type Child = ReturnType<typeof execa>;
function waitReady(child: Child): Promise<{pid: number; nativeId: string}> {
  return new Promise((resolve, reject) => {
    let value = "";
    let done = false;
    const timer = setTimeout(() => fail(new Error("Disposable window not ready")), 12_000);
    function clean() {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.off("error", fail);
      child.off("exit", exited);
    }
    function fail(error: Error) {
      if (done) return;
      done = true;
      clean();
      reject(error);
    }
    function exited() { fail(new Error("Disposable window exited early")); }
    function onData(data: Buffer) {
      value += data.toString("utf8");
      const match = /READY\|(\d+)\|(\d+)/.exec(value);
      if (!match || done) return;
      done = true;
      clean();
      resolve({ pid: Number(match[1]), nativeId: match[2] });
    }
    child.stdout?.on("data", onData);
    child.on("error", fail);
    child.on("exit", exited);
  });
}
async function endFixture(child: Child) {
  child.kill("SIGTERM");
  const exited = await Promise.race([
    child.then(() => true, () => true),
    new Promise<boolean>(resolve => setTimeout(() => resolve(false), 2200)),
  ]);
  if (!exited) child.kill("SIGKILL"); // Only own disposable child.
}

let folder = "";
let cert!: Buffer;
let key!: Buffer;
let pin = "";
beforeAll(() => {
  if (!windowsOnly) return;
  folder = mkdtempSync(path.join(tmpdir(), "desktop-live-native-mtls-"));
  const gitOpenSsl = "C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe";
  const openssl = existsSync(gitOpenSsl) ? gitOpenSsl : "openssl";
  const result = spawnSync(openssl, [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-days", "1", "-keyout", path.join(folder, "peer.key"),
    "-out", path.join(folder, "peer.crt"),
    "-subj", "/CN=viewer.private.test",
    "-addext", "subjectAltName=DNS:viewer.private.test",
    "-addext", "extendedKeyUsage=serverAuth,clientAuth",
  ], { encoding: "utf8", timeout: 20000, windowsHide: true });
  if (result.status !== 0) throw new Error("Disposable mTLS PKI generation failed");
  cert = readFileSync(path.join(folder, "peer.crt"));
  key = readFileSync(path.join(folder, "peer.key"));
  pin = createHash("sha256").update(new X509Certificate(cert).raw).digest("hex");
});
afterAll(() => {
  key?.fill(0);
  if (folder) rmSync(folder, { recursive: true, force: true });
});
describe.skipIf(!windowsOnly)("real Windows HWND over independent mTLS viewer", () => {
  it("passes native exact-window JPEG through private TLS and revokes on takeover", async () => {
    const title = "SuperAgent Native mTLS Fixture " + randomUUID();
    const child = execa(powershell, [
      "-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand",
      Buffer.from(fixtureScript, "utf16le").toString("base64"),
    ], { reject: false, buffer: false, windowsHide: false,
      env: { SUPERAGENT_REMOTE_HOST_FIXTURE: title } });
    let localToken: string | undefined;
    const manager = new NativeWindowPreviewManager(() => createWindowsDesktopUiAdapter());
    let viewer: Awaited<ReturnType<typeof connectRemotePrivateViewerClient>> | undefined;
    let runtime: RemotePrivateLiveRuntime | undefined;
    let bridge: RemotePrivateTransportBridge | undefined;
    let server: ReturnType<typeof createTlsServer> | undefined;
    try {
      const { pid, nativeId } = await waitReady(child);
      const selected = (await manager.discover()).windows.find(win =>
        win.pid === pid && win.nativeId === nativeId && win.title === title,
      );
      expect(selected, "The isolated test-only exact HWND must be discoverable").toBeDefined();
      const window = {
        pid: selected!.pid, nativeId: selected!.nativeId, title: selected!.title,
        application: selected!.application, bounds: selected!.bounds,
      };
      const localApproval = {
        pid, nativeId, consent: true,
        expectedTitle: window.title, expectedApplication: window.application,
        expectedBounds: window.bounds,
      };
      // This is a TEST-only synthetic approval for disposable fixture. A real
      // production approval must originate in attended native Tray dialog.
      const secret = Buffer.alloc(32, 17);
      const localGuard = new NativeDesktopApprovalGuard(() => secret);
      const localNonce = localGuard.issue().nonce;
      const started = await manager.start(localGuard.consume({
        ...localApproval,
        approvalProof: {
          nonce: localNonce,
          mac: NativeDesktopApprovalGuard.computeProofForTest(secret, localApproval, localNonce),
        },
      }));
      localToken = started.token;
      const intent = {
        hostId: "native-private-host-001", viewerId: "mtls-private-viewer-001",
        expectedOrigin: "https://viewer.private.test", window,
      };
      bridge = new RemotePrivateTransportBridge({
        viewerId: intent.viewerId, expectedOrigin: intent.expectedOrigin,
        pinnedViewerCertSha256: pin,
        verifyNativeApproval: async evidence =>
          evidence.window.nativeId === nativeId && evidence.proof === "test-only-attended-proof",
      });
      const request = bridge.beginNativeApproval(intent);
      const approval = await bridge.approveNative({
        nonce: request.nonce, proof: "test-only-attended-proof",
      });
      server = createTlsServer({
        cert, key, ca: cert, requestCert: true, rejectUnauthorized: true,
        minVersion: "TLSv1.3", maxVersion: "TLSv1.3",
        ALPNProtocols: [REMOTE_PRIVATE_ALPN],
      }, socket => {
        try { bridge?.attachPrivateTlsSocket(socket); }
        catch { socket.destroy(); }
      });
      server.listen(0, "127.0.0.1"); // Never public.
      await once(server, "listening");
      const addr = server.address();
      if (!addr || typeof addr === "string") throw Error("Test-only socket unavailable");
      let completed!: () => void;
      const first = new Promise<void>(resolve => { completed = resolve; });
      const frames: Array<{sequence:number; jpeg:Uint8Array; width:number; height:number}> = [];
      viewer = await connectRemotePrivateViewerClient({
        privateAddress: "127.0.0.1", port: addr.port,
        credential: approval.viewerCredential, clientCert: cert, clientKey: key,
        trustedCa: cert, pinnedServerCertSha256: pin,
        onFrame: frame => { frames.push(frame); completed(); },
      });
      runtime = new RemotePrivateLiveRuntime(manager, bridge);
      runtime.startAfterNativeAndViewerApproval(started.token);
      await Promise.race([
        first,
        new Promise((_resolve, reject) => setTimeout(() => reject(Error("Native frame did not reach viewer")), 10_000)),
      ]);
      expect(frames).toHaveLength(1);
      expect(frames[0].sequence).toBe(1);
      expect(frames[0].jpeg.byteLength).toBeGreaterThan(256);
      expect(frames[0].jpeg.subarray(0,2)).toEqual(Uint8Array.from([255,216]));
      expect(frames[0].width).toBeGreaterThan(100);
      runtime.humanTakeover();
      await expect.poll(() => viewer!.isConnected).toBe(false);
      expect(runtime.isStopped).toBe(true);
      expect(() => runtime!.startAfterNativeAndViewerApproval(started.token)).toThrow();
    } finally {
      runtime?.stop();
      viewer?.close();
      bridge?.close();
      if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
      if (localToken) {
        try { manager.stop({ token: localToken }); }
        catch { /* Remote takeover already revoked test lease. */ }
      }
      await endFixture(child);
    }
  }, 45_000);
});

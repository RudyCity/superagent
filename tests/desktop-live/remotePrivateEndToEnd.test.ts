/**
 * Disposable host -> mTLS -> viewer integration smoke.
 * No active desktop capture, public tunnel, or production keys.
 */
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createServer } from "node:tls";
import type { NativeWindowPreviewManager } from "../../src/core/desktopUi/livePreview.js";
import { RemotePrivateLiveRuntime } from "../../src/core/desktopUi/remotePrivateLiveRuntime.js";
import { RemotePrivateTransportBridge, REMOTE_PRIVATE_ALPN } from "../../src/core/desktopUi/remotePrivateTransport.js";
import { connectRemotePrivateViewerClient } from "../../src/core/desktopUi/remotePrivateViewerClient.js";

let dir = "";
let cert!: Buffer;
let key!: Buffer;
let pin = "";
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "desktop-live-e2e-"));
  const gitOpenssl = "C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe";
  const exe = process.platform === "win32" && existsSync(gitOpenssl) ? gitOpenssl : "openssl";
  const p = spawnSync(exe, ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-keyout", "peer.key", "-out", "peer.crt",
    "-subj", "/CN=viewer.private.test",
    "-addext", "subjectAltName=DNS:viewer.private.test",
    "-addext", "extendedKeyUsage=serverAuth,clientAuth"],
    { cwd: dir, windowsHide: true, encoding: "utf8", timeout: 20_000 });
  if (p.status !== 0) throw new Error("Disposable TLS fixture unavailable");
  key = readFileSync(join(dir, "peer.key"));
  cert = readFileSync(join(dir, "peer.crt"));
  pin = createHash("sha256").update(new X509Certificate(cert).raw).digest("hex");
});
afterAll(() => {
  key?.fill(0);
  if (dir) rmSync(dir, { recursive: true, force: true });
});
const intent = {
  hostId: "native-host-000001", viewerId: "viewer-private-000001",
  expectedOrigin: "https://viewer.private.test",
  window: {
    pid: 2340, nativeId: "hwnd:2340", title: "Only disposable window",
    application: "Test Fixture", bounds: { x: 5, y: 10, width: 400, height: 300 },
  },
};
const localToken = "b".repeat(64);
const rawJpeg = Uint8Array.from([0xff, 0xd8, 0x10, 0x77, 0xff, 0xd9]);

describe("native approved host -> mTLS -> independent private viewer", () => {
  it("sends bounded JPEG, ACKs and revokes host/native lease on takeover", async () => {
    const transport = new RemotePrivateTransportBridge({
      viewerId: intent.viewerId, expectedOrigin: intent.expectedOrigin,
      pinnedViewerCertSha256: pin,
      verifyNativeApproval: async evidence =>
        evidence.window.nativeId === intent.window.nativeId &&
        evidence.proof === "trusted-native-approval",
    });
    const captureJpeg = vi.fn(async () => ({
      jpeg: Buffer.from(rawJpeg).toString("base64"),
      width: 400, height: 300, capturedAt: new Date().toISOString(),
    }));
    const nativeClose = vi.fn();
    const claim = vi.fn((token: string, approved: typeof intent.window) => {
      if (token !== localToken || approved.nativeId !== intent.window.nativeId) {
        throw Error("Native preview permission denied");
      }
      return { window: intent.window, captureJpeg, close: nativeClose };
    });
    const manager = { claimRemoteHostCapture: claim } as unknown as NativeWindowPreviewManager;
    const runtime = new RemotePrivateLiveRuntime(manager, transport);
    const server = createServer({
      key, cert, ca: cert, requestCert: true, rejectUnauthorized: true,
      minVersion: "TLSv1.3", maxVersion: "TLSv1.3",
      ALPNProtocols: [REMOTE_PRIVATE_ALPN],
    }, socket => {
      try { transport.attachPrivateTlsSocket(socket); }
      catch { socket.destroy(); }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw Error("No disposable listener");
    const hostChallenge = transport.beginNativeApproval(intent);
    const grant = await transport.approveNative({
      nonce: hostChallenge.nonce, proof: "trusted-native-approval",
    });
    let notify!: () => void;
    const received = new Promise<void>(resolve => { notify = resolve; });
    const seen: Array<{ sequence: number; width: number; jpeg: Uint8Array }> = [];
    let viewer: Awaited<ReturnType<typeof connectRemotePrivateViewerClient>> | undefined;
    try {
      viewer = await connectRemotePrivateViewerClient({
        privateAddress: "127.0.0.1", port: address.port,
        credential: grant.viewerCredential, pinnedServerCertSha256: pin,
        clientCert: cert, clientKey: key, trustedCa: cert,
        onFrame: frame => {
          seen.push(frame);
          notify();
        },
      });
      expect(viewer.isConnected).toBe(true);
      expect(captureJpeg).not.toHaveBeenCalled();
      runtime.startAfterNativeAndViewerApproval(localToken);
      await Promise.race([
        received,
        new Promise((_resolve, reject) => setTimeout(() => reject(Error("No frame")), 2_000)),
      ]);
      expect(seen[0]).toMatchObject({ sequence: 1, width: 400 });
      expect(seen[0].jpeg).toEqual(rawJpeg);
      expect(claim).toHaveBeenCalledWith(localToken, intent.window);
      expect(nativeClose).not.toHaveBeenCalled();
      runtime.humanTakeover();
      expect(nativeClose).toHaveBeenCalledOnce();
      await vi.waitFor(() => expect(viewer?.isConnected).toBe(false));
      expect(runtime.isStopped).toBe(true);
      expect(() => transport.offerVerifiedFrame({
        jpeg: rawJpeg, width: 400, height: 300,
        capturedAtMs: Date.now(), window: intent.window,
      })).toThrow();
    } finally {
      runtime.stop();
      viewer?.close();
      transport.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }, 10_000);
});

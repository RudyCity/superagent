import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash, X509Certificate } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { NativeWindowPreviewManager, NativeRemotePreviewLease } from "../../src/core/desktopUi/livePreview.js";
import {
  RemotePrivateHostTlsListener,
  type PrivateHostTlsCertificateMaterial,
} from "../../src/core/desktopUi/remotePrivateHostTlsListener.js";
import { RemotePrivateTransportBridge } from "../../src/core/desktopUi/remotePrivateTransport.js";
import { connectRemotePrivateViewerClient } from "../../src/core/desktopUi/remotePrivateViewerClient.js";

const intent = {
  hostId: "attended-host-1000001", viewerId: "pinned-viewer-100001",
  expectedOrigin: "https://viewer.private.test",
  window: { pid: 7810, nativeId: "7810", title: "Disposable preview",
    application: "Fixture App", bounds: { x: 0, y: 0, width: 400, height: 300 } },
};
const token = "a".repeat(64);
let dir = "";
let cert!: Buffer;
let key!: Buffer;
let fingerprint = "";
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "superagent-private-host-listener-"));
  const gitExe = "C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe";
  const exe = process.platform === "win32" && existsSync(gitExe) ? gitExe : "openssl";
  const result = spawnSync(exe, [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-days", "1", "-keyout", "cert.key", "-out", "cert.crt",
    "-subj", "/CN=viewer.private.test",
    "-addext", "subjectAltName=DNS:viewer.private.test",
    "-addext", "extendedKeyUsage=serverAuth,clientAuth",
  ], { cwd: dir, encoding: "utf8", timeout: 20000, windowsHide: true });
  if (result.status !== 0) throw new Error("Disposable mTLS PKI unavailable");
  key = readFileSync(path.join(dir, "cert.key"));
  cert = readFileSync(path.join(dir, "cert.crt"));
  fingerprint = createHash("sha256").update(new X509Certificate(cert).raw).digest("hex");
}, 30000);
afterAll(() => {
  key?.fill(0);
  if (dir) rmSync(dir, { recursive: true, force: true });
});
function fixture(material?: Partial<PrivateHostTlsCertificateMaterial>, allowApproval = true) {
  const captureJpeg = vi.fn(async () => ({
    jpeg: Buffer.from([255,216,1,2,255,217]).toString("base64"),
    width: 400, height: 300, capturedAt: new Date().toISOString(),
  }));
  const close = vi.fn();
  const claim = vi.fn((given: string, pinned: typeof intent.window): NativeRemotePreviewLease => {
    if (given !== token || pinned.nativeId !== intent.window.nativeId) throw Error("not approved");
    return { window: intent.window, captureJpeg, close };
  });
  const preview = { claimRemoteHostCapture: claim } as unknown as NativeWindowPreviewManager;
  const transport = new RemotePrivateTransportBridge({
    expectedOrigin: intent.expectedOrigin, viewerId: intent.viewerId,
    pinnedViewerCertSha256: fingerprint,
    verifyNativeApproval: async proof => allowApproval &&
      proof.proof === "trusted-distinct-native-approval" &&
      proof.window.nativeId === intent.window.nativeId,
  });
  const options: PrivateHostTlsCertificateMaterial = {
    privateAddress: "127.0.0.1", port: 0, serverCertificate: cert,
    serverKey: key, viewerCa: cert, ...material,
  };
  const listener = new RemotePrivateHostTlsListener(preview, transport, options);
  return { listener, transport, captureJpeg, close, claim };
}
async function approvedStart(f: ReturnType<typeof fixture>) {
  return f.listener.start({
    nativeWindow: intent, nativeRemoteProof: "trusted-distinct-native-approval",
    localPreviewToken: token,
  });
}
describe("private host TLS listener (manual, attended, no default port)", () => {
  it("does not bind or capture without a separately verified host native grant", async () => {
    const f = fixture();
    expect(f.captureJpeg).not.toHaveBeenCalled();
    await expect(f.listener.start({
      nativeWindow: intent, nativeRemoteProof: "forged", localPreviewToken: token,
    })).rejects.toThrow();
    expect(f.listener.isStopped).toBe(true);
    expect(f.claim).not.toHaveBeenCalled();
  });

  it("rejects public and wildcard binds before opening any TLS listener", async () => {
    for (const privateAddress of ["0.0.0.0","::","8.8.8.8","169.254.169.254",
      "localhost","192.0.2.3","172.31.255.256"]) {
      const f = fixture({ privateAddress });
      await expect(approvedStart(f)).rejects.toThrow();
      expect(f.listener.isStopped).toBe(true);
      expect(f.captureJpeg).not.toHaveBeenCalled();
    }
  });

  it("requires valid host TLS material and rejects malformed or mismatched certificate", async () => {
    const f = fixture({ serverCertificate: Buffer.from("not a certificate") });
    await expect(approvedStart(f)).rejects.toThrow();
    expect(f.listener.isStopped).toBe(true);
  });

  it("delivers actual JPEG via a real private mTLS socket after host and viewer grant", async () => {
    const f = fixture();
    const start = await approvedStart(f);
    const observed: number[] = [];
    let notified!: () => void;
    const received = new Promise<void>(resolve => { notified = resolve; });
    expect(start.address).toBe("127.0.0.1");
    expect(start.port).toBeGreaterThan(0);
    expect(f.captureJpeg).not.toHaveBeenCalled();
    let viewer: Awaited<ReturnType<typeof connectRemotePrivateViewerClient>> | undefined;
    try {
      viewer = await connectRemotePrivateViewerClient({
        privateAddress: start.address, port: start.port,
        credential: start.viewerCredential, clientCert: cert, clientKey: key,
        trustedCa: cert, pinnedServerCertSha256: fingerprint,
        onFrame: frame => { observed.push(frame.sequence); notified(); },
      });
      await Promise.race([
        received,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("No host-native JPEG received")), 3000)),
      ]);
      expect(observed).toEqual([1]);
      expect(f.captureJpeg).toHaveBeenCalled();
      expect(f.claim).toHaveBeenCalledWith(token, intent.window);
      await vi.waitFor(() => expect(viewer?.deliveredFrames).toBe(1));
      expect(f.listener.isViewing).toBe(true);
      f.listener.humanTakeover();
      await vi.waitFor(() => expect(viewer?.isConnected).toBe(false));
      expect(f.listener.isStopped).toBe(true);
      expect(f.close).toHaveBeenCalled();
      expect(() => f.transport.offerVerifiedFrame({
        jpeg: Uint8Array.from([255,216,1,2,255,217]), width: 400,
        height: 300, capturedAtMs: Date.now(), window: intent.window,
      })).toThrow();
    } finally {
      viewer?.close();
      f.listener.stop();
    }
  }, 10000);

  it("replay or second host start is refused without opening another port", async () => {
    const f = fixture();
    await approvedStart(f);
    try {
      await expect(approvedStart(f)).rejects.toThrow();
    } finally { f.listener.stop(); }
    await expect(approvedStart(f)).rejects.toThrow();
  });
});

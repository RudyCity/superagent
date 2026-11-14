import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { NativeWindowPreviewManager } from "../../src/core/desktopUi/livePreview.js";
import { RemotePrivateLiveRuntime } from "../../src/core/desktopUi/remotePrivateLiveRuntime.js";
import { RemoteHostCaptureBridge } from "../../src/core/desktopUi/remoteHostCapture.js";
import type { RemotePrivateTransportBridge } from "../../src/core/desktopUi/remotePrivateTransport.js";
import { RemoteLiveSessionPolicy, type RemoteHostIntent,
  type RemoteTransportEvidence } from "../../src/core/desktopUi/remoteSessionPolicy.js";
import type { NativeRemotePreviewLease } from "../../src/core/desktopUi/livePreview.js";

const intent: RemoteHostIntent = {
  hostId: "native-host-100",
  viewerId: "mtls-viewer-100",
  expectedOrigin: "https://private-viewer.example.test",
  window: {
    pid: 3456, nativeId: "hwnd:3456", title: "Window 100",
    application: "Fixture App", bounds: { x: 0, y: 0, width: 480, height: 320 },
  },
};
const evidence: RemoteTransportEvidence = {
  connectionId: "tls-bound-viewer-0100",
  authenticatedViewerId: intent.viewerId,
  origin: intent.expectedOrigin,
  tlsVerified: true,
  privateIngressVerified: true,
  publicTunnelDetected: false,
  forwardedHeadersPresent: false,
};
const jpegB64 = Buffer.from([0xff,0xd8,0x22,0x33,0xff,0xd9]).toString("base64");
const token = "d".repeat(64);

async function fixture() {
  let time = 50_000;
  const sessions = new RemoteLiveSessionPolicy({
    verifyHostApproval: async () => true,
    verifyViewerProof: async () => true,
  }, () => time);
  const challenge = sessions.beginNativeApproval(intent);
  const host = await sessions.approveNative({ nonce: challenge.nonce, proof: "host-native-yes" });
  const viewer = await sessions.attachViewer({
    sessionId: host.sessionId, proof: "viewer-independent-yes", transport: evidence,
  });
  const auth = {
    sessionId: host.sessionId, csrfToken: viewer.csrfToken, transport: evidence,
  };
  const closeLease = vi.fn();
  const captureJpeg = vi.fn(async () => ({
    jpeg: jpegB64, width: 480, height: 320, capturedAt: new Date(time).toISOString(),
  }));
  const lease: NativeRemotePreviewLease = { window: intent.window, captureJpeg, close: closeLease };
  const claim = vi.fn((_localToken: string, _window: typeof intent.window) => lease);
  const preview = { claimRemoteHostCapture: claim } as unknown as NativeWindowPreviewManager;
  const close = vi.fn(() => { sessions.terminate(); });
  const offer = vi.fn((_frame: unknown) => ({ sequence: 1 }));
  const transport = {
    sessions, offerVerifiedFrame: offer, close,
    claimNativeCapture: (manager: NativeWindowPreviewManager, localToken: string, now: () => number) => {
      sessions.authorizeViewer(auth);
      return RemoteHostCaptureBridge.claim(manager, localToken, sessions, auth, now);
    },
  } as unknown as RemotePrivateTransportBridge;
  const runtime = new RemotePrivateLiveRuntime(preview, transport, () => time);
  return { runtime, sessions, claim, captureJpeg, closeLease, close, offer,
    host, auth, advance: (ms: number) => { time += ms; } };
}

describe("native operator / private viewer / exact window full composition", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("does not capture or connect without explicit trusted native start", async () => {
    const f = await fixture();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(f.claim).not.toHaveBeenCalled();
    expect(f.captureJpeg).not.toHaveBeenCalled();
    expect(f.offer).not.toHaveBeenCalled();
    f.runtime.stop();
  });

  it("claims one already-approved exact-window lease and sends verified JPEG", async () => {
    const f = await fixture();
    f.runtime.startAfterNativeAndViewerApproval(token);
    expect(f.claim).toHaveBeenCalledWith(token, intent.window);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.captureJpeg).toHaveBeenCalledOnce();
    expect(f.offer).toHaveBeenCalledWith(expect.objectContaining({
      jpeg: Buffer.from(jpegB64,"base64"),
      width:480,height:320,window:intent.window,
    }));
    expect(f.runtime.isActive).toBe(true);
    f.runtime.stop();
    expect(f.closeLease).toHaveBeenCalledOnce();
    expect(f.close).toHaveBeenCalledOnce();
  });

  it("never allows viewer approval alone to create native capture", async () => {
    const f = await fixture();
    expect(() => f.runtime.startAfterNativeAndViewerApproval("invalid"))
      .toThrow();
    expect(f.claim).not.toHaveBeenCalled();
    f.runtime.stop();
  });

  it("host native lease failure burns remote session and never starts frames", async () => {
    const f = await fixture();
    f.claim.mockImplementationOnce(() => { throw Error("Native approval absent"); });
    expect(() => f.runtime.startAfterNativeAndViewerApproval(token)).toThrow();
    expect(f.runtime.isStopped).toBe(true);
    expect(f.close).toHaveBeenCalledOnce();
    expect(f.offer).not.toHaveBeenCalled();
    expect(() => f.sessions.authorizeViewer(f.auth)).toThrow();
  });

  it("revokes native lease and remote TLS immediately on human takeover", async () => {
    const f = await fixture();
    f.runtime.startAfterNativeAndViewerApproval(token);
    f.runtime.humanTakeover();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.captureJpeg).not.toHaveBeenCalled();
    expect(f.closeLease).toHaveBeenCalledOnce();
    expect(f.close).toHaveBeenCalledOnce();
    expect(f.runtime.isStopped).toBe(true);
    expect(() => f.runtime.startAfterNativeAndViewerApproval(token)).toThrow();
  });

  it("closes transport and native lease on disconnect before first frame", async () => {
    const f = await fixture();
    f.runtime.startAfterNativeAndViewerApproval(token);
    f.runtime.transportDisconnected();
    expect(f.close).toHaveBeenCalledOnce();
    expect(f.closeLease).toHaveBeenCalledOnce();
    expect(f.runtime.isActive).toBe(false);
  });

  it("rejects a revoked viewer session without claiming host window", async () => {
    const f = await fixture();
    f.sessions.terminate();
    expect(() => f.runtime.startAfterNativeAndViewerApproval(token)).toThrow();
    expect(f.claim).not.toHaveBeenCalled();
    expect(f.close).toHaveBeenCalledOnce();
  });
});

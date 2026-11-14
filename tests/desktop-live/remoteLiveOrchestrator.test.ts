import { describe, expect, it, vi } from "vitest";
import { RemoteLiveSessionPolicy, RemoteLiveDenied,
  type RemoteHostIntent, type RemoteTransportEvidence } from "../../src/core/desktopUi/remoteSessionPolicy.js";
import { RemoteViewerFrameGate, type RemotePrivateFrameSink,
  type RemoteVerifiedJpegFrame } from "../../src/core/desktopUi/remoteViewerFrames.js";
import { RemoteLiveFrameOrchestrator } from "../../src/core/desktopUi/remoteLiveOrchestrator.js";

const intent: RemoteHostIntent = {
  hostId: "host-private-window-01", viewerId: "viewer-private-01",
  expectedOrigin: "https://local-private.example.test",
  window: {
    pid: 1243, nativeId: "hwnd:8002", title: "Disposable test window",
    application: "Fixture", bounds: { x: 1, y: 2, width: 400, height: 300 },
  },
};
const transport: RemoteTransportEvidence = {
  connectionId: "pinned-tls-connection-01",
  authenticatedViewerId: intent.viewerId,
  origin: intent.expectedOrigin,
  tlsVerified: true, privateIngressVerified: true,
  publicTunnelDetected: false, forwardedHeadersPresent: false,
};
const jpeg = Uint8Array.from([255, 216, 9, 7, 255, 217]);

function fixture() {
  let now = 100_000;
  const onRevoked = vi.fn();
  const sessions = new RemoteLiveSessionPolicy({
    verifyHostApproval: async () => true,
    verifyViewerProof: async () => true,
  }, () => now, onRevoked);
  const gate = new RemoteViewerFrameGate(sessions, () => now);
  const sent = vi.fn(() => true);
  const sink: RemotePrivateFrameSink = {
    connectionId: transport.connectionId,
    bufferedBytes: () => 0,
    sendBinary: sent,
  };
  const close = vi.fn();
  const capture = vi.fn(async (): Promise<RemoteVerifiedJpegFrame> => ({
    jpeg, width: 400, height: 300, capturedAtMs: now,
    window: { ...intent.window, bounds: { ...intent.window.bounds } },
  }));
  const coordinator = new RemoteLiveFrameOrchestrator(sessions, gate, {
    captureExactWindow: capture, close,
  });
  return {
    sessions, coordinator, close, capture, sink, sent, onRevoked,
    advance: (ms: number) => { now += ms; },
    async approved() {
      const challenge = sessions.beginNativeApproval(intent);
      const host = await sessions.approveNative({ nonce: challenge.nonce, proof: "native-attended-proof" });
      const viewer = await sessions.attachViewer({
        sessionId: host.sessionId, proof: "viewer-cryptographic-proof", transport,
      });
      return { host, auth: { sessionId: host.sessionId, csrfToken: viewer.csrfToken, transport } };
    },
  };
}

describe("remote live private host-to-viewer composition", () => {
  it("sends only one approved native frame, requires ACK and obeys rate limits", async () => {
    const f = fixture();
    const { auth } = await f.approved();
    await expect(f.coordinator.offerNextFrame(auth, f.sink)).resolves.toEqual({ sequence: 1 });
    expect(f.sent).toHaveBeenCalledTimes(1);
    expect(f.capture).toHaveBeenCalledWith(intent.window);
    expect(f.sent.mock.calls[0]?.[0]).not.toHaveProperty("hostToken");
    expect(f.sent.mock.calls[0]?.[0]).not.toHaveProperty("csrfToken");
    expect(f.coordinator.receiveViewerAck(auth, { type: "ack", version: 1, sequence: 1 }))
      .toEqual({ acknowledged: 1 });
    await expect(f.coordinator.offerNextFrame(auth, f.sink))
      .rejects.toMatchObject({ code: "BUSY" });
    f.advance(251);
    await expect(f.coordinator.offerNextFrame(auth, f.sink)).resolves.toEqual({ sequence: 2 });
    expect(f.sent).toHaveBeenCalledTimes(2);
  });

  it("denies remote frames until viewer completes a fresh private proof", async () => {
    const f = fixture();
    const challenge = f.sessions.beginNativeApproval(intent);
    const host = await f.sessions.approveNative({ nonce: challenge.nonce, proof: "native-attended-proof" });
    const auth = { sessionId: host.sessionId, csrfToken: host.hostToken, transport };
    await expect(f.coordinator.offerNextFrame(auth, f.sink))
      .rejects.toMatchObject({ code: "SESSION_DENIED" });
    expect(f.capture).not.toHaveBeenCalled();
    expect(f.sent).not.toHaveBeenCalled();
  });

  it("rejects mismatched sink identity before touching host capture", async () => {
    const f = fixture();
    const { auth } = await f.approved();
    await expect(f.coordinator.offerNextFrame(auth, {
      ...f.sink, connectionId: "not-this-private-connection",
    })).rejects.toMatchObject({ code: "TRANSPORT_DENIED" });
    expect(f.capture).not.toHaveBeenCalled();
  });

  it("blocks an overlapping frame request without creating a second capture", async () => {
    const f = fixture();
    const { auth } = await f.approved();
    let resume!: (frame: RemoteVerifiedJpegFrame) => void;
    const waiting = new Promise<RemoteVerifiedJpegFrame>(resolve => { resume = resolve; });
    f.capture.mockImplementationOnce(() => waiting);
    const first = f.coordinator.offerNextFrame(auth, f.sink);
    await expect(f.coordinator.offerNextFrame(auth, f.sink))
      .rejects.toMatchObject({ code: "BUSY" });
    expect(f.capture).toHaveBeenCalledTimes(1);
    resume({
      jpeg, width: 400, height: 300, capturedAtMs: 100_000, window: intent.window,
    });
    await expect(first).resolves.toEqual({ sequence: 1 });
  });

  it("discards a frame completed after host user takeover", async () => {
    const f = fixture();
    const { auth } = await f.approved();
    let resume!: (frame: RemoteVerifiedJpegFrame) => void;
    f.capture.mockImplementationOnce(() => new Promise(resolve => { resume = resolve; }));
    const pending = f.coordinator.offerNextFrame(auth, f.sink);
    f.coordinator.humanTakeover();
    resume({ jpeg, width: 400, height: 300, capturedAtMs: 100_000, window: intent.window });
    await expect(pending).rejects.toMatchObject({ code: "SESSION_DENIED" });
    expect(f.close).toHaveBeenCalledOnce();
    expect(f.sent).not.toHaveBeenCalled();
    expect(f.onRevoked).toHaveBeenCalledOnce();
    await expect(f.coordinator.offerNextFrame(auth, f.sink))
      .rejects.toMatchObject({ code: "SESSION_DENIED" });
  });

  it("revokes a changed window before frame data reaches the private transport", async () => {
    const f = fixture();
    const { auth } = await f.approved();
    f.capture.mockResolvedValueOnce({
      jpeg, width: 400, height: 300, capturedAtMs: 100_000,
      window: { ...intent.window, nativeId: "different-native-window" },
    });
    await expect(f.coordinator.offerNextFrame(auth, f.sink))
      .rejects.toMatchObject({ code: "SESSION_DENIED" });
    expect(f.sent).not.toHaveBeenCalled();
    expect(f.close).toHaveBeenCalledOnce();
  });

  it("revokes if native capture throws; never leaks an OS error to the caller", async () => {
    const f = fixture();
    const { auth } = await f.approved();
    f.capture.mockRejectedValueOnce(new Error("Sensitive window title / private OS path"));
    await expect(f.coordinator.offerNextFrame(auth, f.sink))
      .rejects.toMatchObject({ name: "RemoteLiveDenied", code: "SESSION_DENIED" });
    expect(f.coordinator.isStopped).toBe(true);
    expect(f.sent).not.toHaveBeenCalled();
  });

  it("never accepts viewer control messages on its ACK-only channel", async () => {
    const f = fixture();
    const { auth } = await f.approved();
    await f.coordinator.offerNextFrame(auth, f.sink);
    expect(() => f.coordinator.receiveViewerAck(auth, { type: "click", x: 10, y: 20 }))
      .toThrow(RemoteLiveDenied);
    expect(f.sent).toHaveBeenCalledOnce();
    expect(f.close).toHaveBeenCalledOnce();
  });

  it("revokes through the approved host-only capability and on trusted socket close", async () => {
    const f = fixture();
    const { host, auth } = await f.approved();
    f.coordinator.hostStop({ sessionId: host.sessionId, hostToken: host.hostToken });
    expect(f.close).toHaveBeenCalledOnce();
    await expect(f.coordinator.offerNextFrame(auth, f.sink))
      .rejects.toMatchObject({ code: "SESSION_DENIED" });
    f.coordinator.transportDisconnected();
    expect(f.close).toHaveBeenCalledOnce();
    expect(f.onRevoked).toHaveBeenCalledOnce();
  });
});

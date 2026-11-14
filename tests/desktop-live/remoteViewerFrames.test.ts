import { describe, expect, it, vi } from "vitest";
import {
  RemoteLiveSessionPolicy, type RemoteHostIntent,
  type RemoteTransportEvidence,
} from "../../src/core/desktopUi/remoteSessionPolicy.js";
import {
  RemoteViewerFrameGate, REMOTE_MAX_FRAME_BYTES,
  REMOTE_MAX_FRAMES_PER_MINUTE, REMOTE_FRAME_ACK_TIMEOUT_MS,
  REMOTE_MIN_FRAME_INTERVAL_MS, type RemoteFramePacket,
  type RemotePrivateFrameSink, type RemoteVerifiedJpegFrame,
} from "../../src/core/desktopUi/remoteViewerFrames.js";

const intent: RemoteHostIntent = {
  hostId: "approved-host-1", viewerId: "approved-viewer-1",
  expectedOrigin: "https://owner.example.test",
  window: {
    pid: 1234, nativeId: "hwnd:98", title: "Exact approved window",
    application: "Code editor", bounds: { x: 0, y: 0, width: 1200, height: 800 },
  },
};
const transport: RemoteTransportEvidence = {
  connectionId: "private-tls-peer-01",
  authenticatedViewerId: intent.viewerId, origin: intent.expectedOrigin,
  tlsVerified: true, privateIngressVerified: true,
  publicTunnelDetected: false, forwardedHeadersPresent: false,
};
const jpeg = Uint8Array.from([0xff, 0xd8, 7, 8, 0xff, 0xd9]);
function fixture() {
  let now = 20_000;
  const close = vi.fn();
  const sessions = new RemoteLiveSessionPolicy({
    verifyHostApproval: async () => true,
    verifyViewerProof: async () => true,
  }, () => now, close);
  const gate = new RemoteViewerFrameGate(sessions, () => now);
  const packets: RemoteFramePacket[] = [];
  let buffered = 0;
  let writeOk = true;
  const sink: RemotePrivateFrameSink = {
    connectionId: transport.connectionId,
    bufferedBytes: () => buffered,
    sendBinary: packet => { packets.push(packet); return writeOk; },
  };
  return {
    gate, sessions, packets, close, sink, now: () => now,
    advance: (ms: number) => { now += ms; },
    buffer: (size: number) => { buffered = size; },
    writeResult: (ok: boolean) => { writeOk = ok; },
    frame: (overrides: Partial<RemoteVerifiedJpegFrame> = {}): RemoteVerifiedJpegFrame => ({
      jpeg, width: 1200, height: 800, window: intent.window, capturedAtMs: now,
      ...overrides,
    }),
    async connected() {
      const challenge = sessions.beginNativeApproval(intent);
      const host = await sessions.approveNative({ nonce: challenge.nonce, proof: "host-native-approval" });
      const viewer = await sessions.attachViewer({
        sessionId: host.sessionId, proof: "owner-viewer-crypto", transport,
      });
      return {
        auth: { sessionId: host.sessionId, csrfToken: viewer.csrfToken, transport },
        host,
      };
    },
  };
}

describe("remote viewer stream — no network listener and no input", () => {
  it("sends one bounded verified JPEG only to the bound private sink and ACKs it", async () => {
    const f = fixture();
    const { auth } = await f.connected();
    const first = f.gate.offer(auth, f.frame(), f.sink);
    expect(first.sequence).toBe(1);
    expect(f.packets).toHaveLength(1);
    expect(f.packets[0]).toEqual({
      version: 1, type: "frame", sequence: 1, format: "jpeg",
      jpeg, width: 1200, height: 800, capturedAtMs: f.now(),
    });
    expect(Object.keys(f.packets[0])).not.toContain("csrfToken");
    expect(Object.keys(f.packets[0])).not.toContain("hostToken");
    expect(f.gate.receiveViewerMessage(auth, {
      version: 1, type: "ack", sequence: 1,
    })).toEqual({ acknowledged: 1 });
    f.advance(REMOTE_MIN_FRAME_INTERVAL_MS);
    expect(f.gate.offer(auth, f.frame(), f.sink).sequence).toBe(2);
    expect(f.packets).toHaveLength(2);
  });

  it("never queues frames without ACK or before rate interval", async () => {
    const f = fixture();
    const { auth } = await f.connected();
    f.gate.offer(auth, f.frame(), f.sink);
    expect(() => f.gate.offer(auth, f.frame(), f.sink))
      .toThrow();
    expect(f.packets).toHaveLength(1);
    f.gate.receiveViewerMessage(auth, { version: 1, type: "ack", sequence: 1 });
    expect(() => f.gate.offer(auth, f.frame(), f.sink)).toThrow();
    f.advance(REMOTE_MIN_FRAME_INTERVAL_MS);
    f.gate.offer(auth, f.frame(), f.sink);
    expect(f.packets).toHaveLength(2);
  });

  it("enforces rolling frame budget independent of viewer ACK speed", async () => {
    const f = fixture();
    const { auth } = await f.connected();
    for (let i = 1; i <= REMOTE_MAX_FRAMES_PER_MINUTE; i++) {
      const receipt = f.gate.offer(auth, f.frame(), f.sink);
      expect(receipt.sequence).toBe(i);
      f.gate.receiveViewerMessage(auth, { version: 1, type: "ack", sequence: i });
      f.advance(REMOTE_MIN_FRAME_INTERVAL_MS);
    }
    expect(() => f.gate.offer(auth, f.frame(), f.sink))
      .toThrow();
    expect(f.packets).toHaveLength(REMOTE_MAX_FRAMES_PER_MINUTE);
  });

  it("revokes the session and closes transport when ACK times out", async () => {
    const f = fixture();
    const { auth } = await f.connected();
    f.gate.offer(auth, f.frame(), f.sink);
    f.advance(REMOTE_FRAME_ACK_TIMEOUT_MS);
    expect(() => f.gate.offer(auth, f.frame(), f.sink))
      .toThrow();
    expect(f.close).toHaveBeenCalledOnce();
    expect(f.packets).toHaveLength(1);
  });

  it("rejects oversized, changed-window, stale, and non-JPEG captures before any write", async () => {
    const variations: Array<Partial<RemoteVerifiedJpegFrame>> = [
      { jpeg: new Uint8Array(REMOTE_MAX_FRAME_BYTES + 1) },
      { jpeg: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]) },
      { window: { ...intent.window, pid: 13 } },
      { window: null as never },
      { window: { ...intent.window, bounds: { ...intent.window.bounds, x: 1 } } },
      { capturedAtMs: 0 },
      { width: 9000 },
      { height: 9000 },
    ];
    for (const bad of variations) {
      const f = fixture();
      const { auth } = await f.connected();
      expect(() => f.gate.offer(auth, f.frame(bad), f.sink)).toThrow();
      expect(f.packets).toHaveLength(0);
      expect(f.close).toHaveBeenCalledOnce();
    }
  });

  it("rejects slow sink, failed writes, and sink swapping without broadcasting", async () => {
    const slow = fixture();
    const { auth: a } = await slow.connected();
    slow.buffer(1);
    expect(() => slow.gate.offer(a, slow.frame(), slow.sink)).toThrow();
    expect(slow.packets).toHaveLength(0);
    expect(slow.close).toHaveBeenCalledOnce();

    const fail = fixture();
    const { auth: b } = await fail.connected();
    fail.writeResult(false);
    expect(() => fail.gate.offer(b, fail.frame(), fail.sink)).toThrow();
    expect(fail.packets).toHaveLength(1);
    expect(fail.close).toHaveBeenCalledOnce();

    const swap = fixture();
    const { auth: c } = await swap.connected();
    swap.gate.offer(c, swap.frame(), swap.sink);
    swap.gate.receiveViewerMessage(c, { version: 1, type: "ack", sequence: 1 });
    swap.advance(REMOTE_MIN_FRAME_INTERVAL_MS);
    const other = { connectionId: transport.connectionId,
      bufferedBytes: () => 0, sendBinary: vi.fn(() => true) };
    expect(() => swap.gate.offer(c, swap.frame(), other)).toThrow();
    expect(other.sendBinary).not.toHaveBeenCalled();
    expect(swap.packets).toHaveLength(1);
  });

  it("never writes to a sink belonging to a different connection", async () => {
    const f = fixture();
    const { auth } = await f.connected();
    const wrong = { connectionId: "other-private-socket-01",
      bufferedBytes: () => 0, sendBinary: vi.fn(() => true) };
    expect(() => f.gate.offer(auth, f.frame(), wrong)).toThrow();
    expect(wrong.sendBinary).not.toHaveBeenCalled();
    expect(f.packets).toHaveLength(0);
  });

  it("rejects all viewer control/input messages, unknown fields and replayed ACK", async () => {
    for (const payload of [
      { version: 1, type: "click", x: 4, y: 4 },
      { version: 1, type: "keyboard", text: "secret" },
      { version: 1, type: "clipboard", value: "hello" },
      { version: 1, type: "resize", width: 1920 },
      { version: 1, type: "ack", sequence: 1, extra: "unsolicited" },
      { version: 1, type: "ack", sequence: 99 },
      { version: 1, type: "ack", sequence: 0 },
    ]) {
      const f = fixture();
      const { auth } = await f.connected();
      f.gate.offer(auth, f.frame(), f.sink);
      expect(() => f.gate.receiveViewerMessage(auth, payload)).toThrow();
      expect(f.close).toHaveBeenCalledOnce();
    }

    const f = fixture();
    const { auth } = await f.connected();
    f.gate.offer(auth, f.frame(), f.sink);
    const ack = { version: 1, type: "ack", sequence: 1 };
    f.gate.receiveViewerMessage(auth, ack);
    expect(() => f.gate.receiveViewerMessage(auth, ack)).toThrow();
    expect(f.close).toHaveBeenCalledOnce();
  });

  it("keeps owner CSRF + session + TLS binding on every frame and ACK", async () => {
    const f = fixture();
    const { auth, host } = await f.connected();
    for (const forged of [
      { ...auth, csrfToken: host.hostToken },
      { ...auth, sessionId: "0".repeat(64) },
      { ...auth, transport: { ...transport, privateIngressVerified: false } },
      { ...auth, transport: { ...transport, publicTunnelDetected: true } },
      { ...auth, transport: { ...transport, origin: "https://attacker.test" } },
      { ...auth, transport: { ...transport, connectionId: "swapped-connection-01" } },
      { ...auth, transport: { ...transport, tlsVerified: false } },
    ]) {
      expect(() => f.gate.offer(forged, f.frame(), f.sink)).toThrow();
      expect(() => f.gate.receiveViewerMessage(forged, { version: 1, type: "ack", sequence: 1 }))
        .toThrow();
    }
    expect(f.packets).toHaveLength(0);
    expect(f.gate.offer(auth, f.frame(), f.sink)).toEqual({ sequence: 1 });
  });

  it("disconnect and host revocation prevent any further frame release", async () => {
    const f = fixture();
    const { auth } = await f.connected();
    f.gate.onTransportDisconnected();
    expect(f.close).toHaveBeenCalledOnce();
    expect(() => f.gate.offer(auth, f.frame(), f.sink)).toThrow();
    expect(f.packets).toHaveLength(0);
  });
});

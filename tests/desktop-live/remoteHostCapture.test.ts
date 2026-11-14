import { createCanvas } from "@napi-rs/canvas";
import { describe, expect, it, vi } from "vitest";
import { NativeDesktopApprovalGuard } from "../../src/core/desktopUi/nativeApprovalProof.js";
import { NativeWindowPreviewManager } from "../../src/core/desktopUi/livePreview.js";
import { RemoteHostCaptureBridge } from "../../src/core/desktopUi/remoteHostCapture.js";
import { RemoteLiveSessionPolicy, type RemoteWindowPin } from "../../src/core/desktopUi/remoteSessionPolicy.js";
import { RemoteViewerFrameGate } from "../../src/core/desktopUi/remoteViewerFrames.js";
import type { DesktopDiscoveredWindow, DesktopUiAdapter } from "../../src/core/desktopUi/types.js";

const pin: RemoteWindowPin = {
  pid: 8731, nativeId: "0x04af12", title: "Private Test Form", application: "WinForms",
  bounds: { x: 90, y: 110, width: 480, height: 320 },
};
const window: DesktopDiscoveredWindow = { ...pin, active: true };
const key = Buffer.alloc(32, 3);
const transport = {
  connectionId: "private-connection-001", authenticatedViewerId: "viewer-test-0001",
  origin: "https://viewer.private.example", tlsVerified: true,
  privateIngressVerified: true, publicTunnelDetected: false,
  forwardedHeadersPresent: false,
};
const intent = {
  hostId: "host-test-0001", viewerId: "viewer-test-0001",
  expectedOrigin: transport.origin, window: pin,
};

async function fixture(options: { verified?: boolean; backend?: string; slow?: boolean } = {}) {
  let time = Date.parse("2026-11-14T14:20:00.000Z");
  let captureCount = 0;
  let closeCount = 0;
  let capturedWindow = window;
  let captureStarted!: () => void;
  let resolveCapture!: () => void;
  const entered = new Promise<void>(resolve => { captureStarted = resolve; });
  const pending = new Promise<void>(resolve => { resolveCapture = resolve; });
  const canvas = createCanvas(pin.bounds.width, pin.bounds.height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ab6633";
  ctx.fillRect(0, 0, pin.bounds.width, pin.bounds.height);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(40, 40, 150, 100);
  const png = await canvas.encode("png");
  const nativeCapture = async () => {
    captureCount++;
    if (options.slow) { captureStarted(); await pending; }
    return { image: png, targetWindow: capturedWindow, capturedAt: new Date(time).toISOString() };
  };
  const adapter: DesktopUiAdapter = {
    platform: "win32",
    probe: async () => ({
      platform: "win32", available: true, screenshot: true, accessibility: true,
      input: false, scroll: false, prerequisites: [], limitations: [], errors: [],
    }),
    listWindows: async limit => ({ windows: [capturedWindow], limit, truncated: false }),
    capture: nativeCapture,
    ...(options.verified === false ? {} : {
      openVerifiedCapture: async () => ({
        backend: options.backend ?? "win32-persistent-exact-hwnd",
        verifiedInsideCapture: true as const, capture: nativeCapture,
        close: () => { closeCount++; },
      }),
    }),
    inspectAccessibility: async () => { throw Error("No accessibility use allowed"); },
    dispatch: async () => { throw Error("No remote input allowed"); },
  };
  const manager = new NativeWindowPreviewManager(() => adapter, () => time);
  const guard = new NativeDesktopApprovalGuard(() => key, () => time);
  const approval = {
    pid: pin.pid, nativeId: pin.nativeId, consent: true,
    expectedTitle: pin.title, expectedApplication: pin.application, expectedBounds: pin.bounds,
  };
  const localChallenge = guard.issue();
  const proof = {
    ...approval, approvalProof: { nonce: localChallenge.nonce,
      mac: NativeDesktopApprovalGuard.computeProofForTest(key, approval, localChallenge.nonce) },
  };
  const local = await manager.start(guard.consume(proof));
  const revoked = vi.fn();
  const sessions = new RemoteLiveSessionPolicy({
    verifyHostApproval: async evidence => evidence.window.nativeId === pin.nativeId,
    verifyViewerProof: async evidence => evidence.connectionId === transport.connectionId,
  }, () => time, revoked);
  async function approved() {
    const pending = sessions.beginNativeApproval(intent);
    const host = await sessions.approveNative({ nonce: pending.nonce, proof: "native-attended-proof" });
    const attached = await sessions.attachViewer({
      sessionId: host.sessionId, proof: "independent-viewer-proof", transport,
    });
    return { host, auth: { sessionId: host.sessionId, csrfToken: attached.csrfToken, transport } };
  }
  return {
    manager, local, sessions, approved, revoked, get time() { return time; },
    advance(ms: number) { time += ms; },
    release: () => resolveCapture(), entered,
    changeWindow(value: DesktopDiscoveredWindow) { capturedWindow = value; },
    get captures() { return captureCount; },
    get closes() { return closeCount; },
  };
}

describe("P0 approved remote host capture bridge", () => {
  it("reuses signed local-native approval and separate viewer authorization, then feeds the private ACK gate", async () => {
    const f = await fixture();
    const { auth } = await f.approved();
    const bridge = RemoteHostCaptureBridge.claim(f.manager, f.local.token, f.sessions, auth, () => f.time);
    expect(JSON.stringify(bridge)).not.toContain(f.local.token);
    expect(JSON.stringify(bridge)).not.toContain(auth.csrfToken);
    const frame = await bridge.capture();
    expect(frame.window).toEqual(pin);
    expect(frame.jpeg.byteLength).toBeGreaterThan(100);
    expect(frame.jpeg.byteLength).toBeLessThanOrEqual(512 * 1024);
    expect(frame.jpeg.subarray(0, 2)).toEqual(Buffer.from([255, 216]));
    const gate = new RemoteViewerFrameGate(f.sessions, () => f.time);
    const packets: unknown[] = [];
    const sink = {
      connectionId: transport.connectionId, bufferedBytes: () => 0,
      sendBinary: (packet: unknown) => { packets.push(packet); return true; },
    };
    expect(gate.offer(auth, frame, sink)).toEqual({ sequence: 1 });
    expect(packets).toHaveLength(1);
    expect(JSON.stringify(packets)).not.toContain(f.local.token);
    expect(gate.receiveViewerMessage(auth, { version: 1, type: "ack", sequence: 1 }))
      .toEqual({ acknowledged: 1 });
    bridge.close();
    expect(f.revoked).toHaveBeenCalledOnce();
    await expect(bridge.capture()).rejects.toThrow();
    expect(f.manager.stop({ token: f.local.token })).toEqual({ stopped: true });
  });

  it("refuses to claim before attended remote approval and viewer attach", async () => {
    const f = await fixture();
    const forged = { sessionId: "a".repeat(64), csrfToken: "b".repeat(64), transport };
    expect(() => RemoteHostCaptureBridge.claim(
      f.manager, f.local.token, f.sessions, forged, () => f.time,
    )).toThrow();
    const challenge = f.sessions.beginNativeApproval(intent);
    expect(challenge.nonce).toMatch(/^[a-f0-9]{64}$/);
    expect(() => RemoteHostCaptureBridge.claim(
      f.manager, f.local.token, f.sessions, forged, () => f.time,
    )).toThrow();
    expect(f.captures).toBe(0);
  });

  it("denies the unverified screenshot backend without switching to monitor capture", async () => {
    for (const backend of [undefined, "desktop-screenshot-fallback", "wayland-portal-unbound"]) {
      const f = await fixture(backend === undefined ? { verified: false } : { backend });
      const { auth } = await f.approved();
      expect(() => RemoteHostCaptureBridge.claim(
        f.manager, f.local.token, f.sessions, auth, () => f.time,
      )).toThrow();
      expect(f.captures).toBe(0);
      // The original local preview API still works independently.
      const png = await f.manager.frame({ token: f.local.token });
      expect(png.format).toBe("png");
      expect(f.captures).toBe(1);
    }
  });

  it("rejects changed approved PID, title, app, bounds or native ID before any remote pixels", async () => {
    for (const changed of [
      { ...pin, pid: pin.pid + 1 }, { ...pin, nativeId: "other-window" },
      { ...pin, title: "Changed" }, { ...pin, application: "Another app" },
      { ...pin, bounds: { ...pin.bounds, width: 481 } },
    ]) {
      const f = await fixture();
      const sessions = new RemoteLiveSessionPolicy({
        verifyHostApproval: async () => true, verifyViewerProof: async () => true,
      }, () => f.time);
      const approval = sessions.beginNativeApproval({ ...intent, window: changed });
      const host = await sessions.approveNative({ nonce: approval.nonce, proof: "attended-challenge" });
      const { csrfToken } = await sessions.attachViewer({
        sessionId: host.sessionId, proof: "independent-proof", transport,
      });
      expect(() => RemoteHostCaptureBridge.claim(f.manager, f.local.token, sessions,
        { sessionId: host.sessionId, csrfToken, transport }, () => f.time)).toThrow();
      expect(f.captures).toBe(0);
    }
  });

  it("enforces one owner, min frame interval and revokes on host close", async () => {
    const f = await fixture();
    const { auth } = await f.approved();
    const bridge = RemoteHostCaptureBridge.claim(f.manager, f.local.token, f.sessions, auth, () => f.time);
    expect(() => RemoteHostCaptureBridge.claim(f.manager, f.local.token, f.sessions, auth,
      () => f.time)).toThrow();
    // First capture remains possible while competing claim was refused.
    await expect(bridge.capture()).rejects.toThrow();
  });

  it("rate-limits sequential frames without taking a desktop fallback", async () => {
    const f = await fixture();
    const { auth } = await f.approved();
    const bridge = RemoteHostCaptureBridge.claim(f.manager, f.local.token, f.sessions, auth, () => f.time);
    await bridge.capture();
    await expect(bridge.capture()).rejects.toMatchObject({ code: "BUSY" });
    expect(f.captures).toBe(1);
    f.advance(250);
    await bridge.capture();
    expect(f.captures).toBe(2);
    bridge.close();
  });

  it("terminates both capture and viewer when the native identity changes", async () => {
    const f = await fixture();
    const { auth } = await f.approved();
    const bridge = RemoteHostCaptureBridge.claim(f.manager, f.local.token, f.sessions, auth, () => f.time);
    f.changeWindow({ ...window, title: "Sensitive Other Window" });
    await expect(bridge.capture()).rejects.toMatchObject({ code: "SESSION_DENIED" });
    expect(f.revoked).toHaveBeenCalledOnce();
    await expect(f.manager.frame({ token: f.local.token })).rejects.toThrow(/revoked/);
  });

  it("discards a delayed frame after native stop even if the source resolves", async () => {
    const f = await fixture({ slow: true });
    const { auth } = await f.approved();
    const bridge = RemoteHostCaptureBridge.claim(f.manager, f.local.token, f.sessions, auth, () => f.time);
    const pending = bridge.capture();
    await f.entered;
    expect(f.manager.stop({ token: f.local.token })).toEqual({ stopped: true });
    f.release();
    await expect(pending).rejects.toMatchObject({ code: "SESSION_DENIED" });
    expect(f.revoked).toHaveBeenCalledOnce();
  });

  it("discards delayed pixels after remote approval is revoked", async () => {
    const f = await fixture({ slow: true });
    const { auth } = await f.approved();
    const bridge = RemoteHostCaptureBridge.claim(f.manager, f.local.token, f.sessions, auth, () => f.time);
    const pending = bridge.capture();
    await f.entered;
    f.sessions.terminate();
    f.release();
    await expect(pending).rejects.toMatchObject({ code: "SESSION_DENIED" });
    expect(f.revoked).toHaveBeenCalledOnce();
    expect(f.manager.stop({ token: f.local.token })).toEqual({ stopped: true });
  });

  it("caps capture attempts per minute even when every interval is otherwise allowed", async () => {
    const f = await fixture();
    const { auth } = await f.approved();
    const nativeJpeg = Buffer.from([255, 216, 42, 255, 217]).toString("base64");
    const close = vi.fn();
    const lease = {
      window: pin, close,
      captureJpeg: async () => ({ jpeg: nativeJpeg, width: 480, height: 320,
        capturedAt: new Date(f.time).toISOString() }),
    };
    vi.spyOn(f.manager, "claimRemoteHostCapture").mockReturnValue(lease);
    const bridge = RemoteHostCaptureBridge.claim(f.manager, f.local.token, f.sessions, auth, () => f.time);
    for (let i = 0; i < 120; i++) {
      await bridge.capture();
      f.advance(250);
    }
    await expect(bridge.capture()).rejects.toMatchObject({ code: "BUSY" });
    expect(close).not.toHaveBeenCalled();
    f.advance(30_000);
    await bridge.capture();
    bridge.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it("refuses malformed JPEG, oversized frame, stale timestamp, and monotonic timestamp replay", async () => {
    for (const kind of ["jpeg", "size", "age", "replay"] as const) {
      const f = await fixture();
      const { auth } = await f.approved();
      const good = Buffer.from([255, 216, 42, 255, 217]).toString("base64");
      const close = vi.fn();
      let captures = 0;
      vi.spyOn(f.manager, "claimRemoteHostCapture").mockReturnValue({
        window: pin, close,
        captureJpeg: async () => {
          captures++;
          return {
            jpeg: kind === "jpeg" ? Buffer.from("wrong").toString("base64") : good,
            width: kind === "size" ? 5000 : 480, height: 320,
            capturedAt: new Date(kind === "age" ? f.time - 6_000 :
              kind === "replay" ? f.time - (captures > 1 ? 250 : 0) : f.time).toISOString(),
          };
        },
      });
      const bridge = RemoteHostCaptureBridge.claim(f.manager, f.local.token, f.sessions, auth, () => f.time);
      if (kind === "replay") {
        await bridge.capture();
        f.advance(250);
      }
      await expect(bridge.capture()).rejects.toMatchObject({ code: "SESSION_DENIED" });
      expect(close).toHaveBeenCalledOnce();
      expect(f.revoked).toHaveBeenCalledOnce();
    }
  });

  it("revokes viewer authorization even if a native source fails to close", async () => {
    const f = await fixture();
    const { auth } = await f.approved();
    vi.spyOn(f.manager, "claimRemoteHostCapture").mockReturnValue({
      window: pin, captureJpeg: async () => { throw Error("Never capture"); },
      close: () => { throw Error("Native teardown error"); },
    });
    const bridge = RemoteHostCaptureBridge.claim(f.manager, f.local.token, f.sessions, auth, () => f.time);
    expect(() => bridge.close()).not.toThrow();
    expect(f.revoked).toHaveBeenCalledOnce();
    expect(() => f.sessions.authorizeViewer(auth)).toThrow();
    await expect(bridge.capture()).rejects.toMatchObject({ code: "SESSION_DENIED" });
  });

  it("refuses a forged local preview bearer without invoking a capture", async () => {
    const f = await fixture();
    const { auth } = await f.approved();
    expect(() => RemoteHostCaptureBridge.claim(f.manager, "0".repeat(64), f.sessions, auth,
      () => f.time)).toThrow();
    expect(f.captures).toBe(0);
  });
});

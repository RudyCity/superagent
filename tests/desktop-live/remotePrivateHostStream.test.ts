import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RemoteLiveDenied, type RemoteWindowPin } from "../../src/core/desktopUi/remoteSessionPolicy.js";
import { RemotePrivateHostStream } from "../../src/core/desktopUi/remotePrivateHostStream.js";
import type { RemoteVerifiedJpegFrame } from "../../src/core/desktopUi/remoteViewerFrames.js";

const windowPin: RemoteWindowPin = {
  pid: 1420, nativeId: "hwnd:42", title: "Authorized window",
  application: "Fixture", bounds: { x: 0, y: 0, width: 400, height: 300 },
};
const frame = (): RemoteVerifiedJpegFrame => ({
  jpeg: Uint8Array.from([255, 216, 3, 4, 255, 217]), width: 400, height: 300,
  capturedAtMs: 20_000, window: windowPin,
});
function fixture() {
  let sequence = 0;
  const capture = vi.fn(async () => frame());
  const offerVerifiedFrame = vi.fn(() => ({ sequence: ++sequence }));
  const nativeClose = vi.fn();
  const viewerClose = vi.fn();
  const host = new RemotePrivateHostStream(
    { capture, close: nativeClose }, { offerVerifiedFrame, close: viewerClose },
  );
  return { host, capture, offerVerifiedFrame, nativeClose, viewerClose };
}

describe("attended private host frame stream", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("never starts implicitly; one native frame is sent only after explicit host start", async () => {
    const f = fixture();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(f.capture).not.toHaveBeenCalled();
    expect(f.offerVerifiedFrame).not.toHaveBeenCalled();
    f.host.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.capture).toHaveBeenCalledOnce();
    expect(f.offerVerifiedFrame).toHaveBeenCalledWith(frame());
    expect(f.host.deliveredFrames).toBe(1);
    expect(() => f.host.start()).toThrow(RemoteLiveDenied);
    f.host.stop();
    expect(f.nativeClose).toHaveBeenCalledOnce();
    expect(f.viewerClose).toHaveBeenCalledOnce();
  });

  it("does not overlap native capture even when async capture is slow", async () => {
    const f = fixture();
    let resume!: (v: RemoteVerifiedJpegFrame) => void;
    const waiting = new Promise<RemoteVerifiedJpegFrame>(resolve => { resume = resolve; });
    f.capture.mockImplementationOnce(() => waiting);
    f.host.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.capture).toHaveBeenCalledTimes(1);
    expect(f.offerVerifiedFrame).not.toHaveBeenCalled();
    resume(frame());
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.offerVerifiedFrame).toHaveBeenCalledOnce();
    f.host.stop();
  });

  it("always discards an in-flight frame after human takeover", async () => {
    const f = fixture();
    let resume!: (v: RemoteVerifiedJpegFrame) => void;
    f.capture.mockImplementationOnce(() =>
      new Promise<RemoteVerifiedJpegFrame>(resolve => { resume = resolve; }));
    f.host.start();
    await vi.advanceTimersByTimeAsync(0);
    f.host.humanTakeover();
    resume(frame());
    await vi.advanceTimersByTimeAsync(3_000);
    expect(f.offerVerifiedFrame).not.toHaveBeenCalled();
    expect(f.nativeClose).toHaveBeenCalledOnce();
    expect(f.viewerClose).toHaveBeenCalledOnce();
    expect(f.host.isStopped).toBe(true);
    expect(() => f.host.start()).toThrow(RemoteLiveDenied);
  });

  it("retries bounded BUSY but treats all other viewer failures as revocation", async () => {
    const f = fixture();
    f.offerVerifiedFrame.mockImplementationOnce(() => {
      throw new RemoteLiveDenied("BUSY");
    });
    f.host.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.host.isActive).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(f.host.deliveredFrames).toBe(1);
    f.offerVerifiedFrame.mockImplementationOnce(() => {
      throw new RemoteLiveDenied("SESSION_DENIED");
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(f.host.isStopped).toBe(true);
    expect(f.nativeClose).toHaveBeenCalledOnce();
    expect(f.viewerClose).toHaveBeenCalledOnce();
  });

  it("terminates on changed/unsafe native frame and cannot restart", async () => {
    const f = fixture();
    f.capture.mockRejectedValueOnce(new Error("Native capture failed"));
    f.host.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.offerVerifiedFrame).not.toHaveBeenCalled();
    expect(f.host.isStopped).toBe(true);
    expect(() => f.host.start()).toThrow();
  });

  it("does not allow a misbehaving sender to replay a frame sequence", async () => {
    const f = fixture();
    f.offerVerifiedFrame.mockImplementationOnce(() => ({ sequence: 0 }));
    f.host.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.host.isStopped).toBe(true);
  });

  it("cleans up both sides even if native close throws", async () => {
    const native = { capture: vi.fn(async () => frame()),
      close: vi.fn(() => { throw new Error("native close unavailable"); }) };
    const viewer = { offerVerifiedFrame: vi.fn(() => ({ sequence: 1 })), close: vi.fn() };
    const host = new RemotePrivateHostStream(native, viewer);
    host.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(() => host.stop()).not.toThrow();
    expect(viewer.close).toHaveBeenCalledOnce();
  });
});

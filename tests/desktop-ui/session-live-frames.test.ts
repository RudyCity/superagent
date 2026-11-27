import { describe, expect, it, vi } from "vitest";
import { deflateSync } from "node:zlib";
import {
  createDesktopUiSession,
  type AccessibilitySnapshot,
  type DesktopUiAdapter,
  type DesktopUiCapabilities,
  type DesktopWindow,
  type NativeCapture,
} from "../../src/core/desktopUi/index.js";

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function png(width: number, height: number, paint: (x: number, y: number) => [number, number, number]): Buffer {
  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = paint(x, y);
      const index = y * (stride + 1) + 1 + x * 3;
      raw[index] = r;
      raw[index + 1] = g;
      raw[index + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A live editor frame: same layout, blinking caret at a different offset. */
const animatedFrame = (markerX: number) =>
  png(240, 160, (x, y) => (x >= markerX && x < markerX + 6 && y >= 10 && y < 16
    ? [20, 20, 20] : [250, 250, 250]));

/** A materially different frame, e.g. a modal dialog covering the window. */
const replacedFrame = () => png(240, 160, (x) => (x < 120 ? [250, 250, 250] : [20, 20, 120]));

const window: DesktopWindow = {
  pid: 42,
  nativeId: "window-42",
  title: "Live editor",
  active: true,
  bounds: { x: 0, y: 0, width: 240, height: 160 },
};

const capabilities: DesktopUiCapabilities = {
  platform: "win32",
  available: true,
  screenshot: true,
  accessibility: true,
  input: true,
  scroll: true,
  prerequisites: [],
  limitations: [],
  errors: [],
};

function accessibilitySnapshot(): AccessibilitySnapshot {
  return {
    window,
    elements: [{
      role: "button",
      label: "Save",
      description: null,
      value: null,
      bounds: { x: 10, y: 10, width: 20, height: 20 },
      center: { x: 20, y: 20 },
      actionable: true,
      nativeRef: "native-save",
    }],
  };
}

function mockAdapter(frames: Uint8Array[]): {
  adapter: DesktopUiAdapter;
  dispatch: ReturnType<typeof vi.fn>;
  inspectAccessibility: ReturnType<typeof vi.fn>;
} {
  let index = 0;
  const dispatch = vi.fn(async () => undefined);
  const inspectAccessibility = vi.fn(async () => accessibilitySnapshot());
  const adapter: DesktopUiAdapter = {
    platform: "win32",
    probe: async () => capabilities,
    capture: async (): Promise<NativeCapture> => ({
      image: frames[Math.min(index++, frames.length - 1)],
      capturedAt: "2026-11-27T00:00:00.000Z",
      targetWindow: window,
    }),
    inspectAccessibility,
    dispatch,
  };
  return { adapter, dispatch, inspectAccessibility };
}

describe("DesktopUiSession live-window tolerance", () => {
  it("assembles a schema while the target keeps animating", async () => {
    const { adapter } = mockAdapter([animatedFrame(10), animatedFrame(40)]);
    const session = createDesktopUiSession({
      adapter,
      target: { pid: 42, nativeId: "window-42" },
    });

    const schema = await session.snapshot();

    expect(schema.screenshot.revision).toBe(1);
    expect(schema.elements).toHaveLength(1);
  });

  it("assembles a plain schema from one frame even when the next frame would differ", async () => {
    const { adapter } = mockAdapter([animatedFrame(10), replacedFrame()]);
    const session = createDesktopUiSession({
      adapter,
      target: { pid: 42, nativeId: "window-42" },
    });

    const schema = await session.snapshot();

    // The removed confirmation capture used to reject this; a plain snapshot
    // now trusts the capture+UIA identity fence and defers motion checks to the
    // pre-action verification. wait_ready keeps the strict check below.
    expect(schema.screenshot.revision).toBe(1);
    expect(schema.screenshot.changeRatio).toBeUndefined();
  });

  it("dispatches a click on an animating window while the element stays put", async () => {
    const { adapter, dispatch } = mockAdapter([
      animatedFrame(10), animatedFrame(20),
      animatedFrame(30), animatedFrame(40),
      animatedFrame(50), animatedFrame(60),
    ]);
    const session = createDesktopUiSession({
      adapter,
      target: { pid: 42, nativeId: "window-42" },
      allowInput: true,
    });
    const schema = await session.snapshot();

    const receipt = await session.click({
      elementId: "a1",
      expectedRevision: schema.screenshot.revision,
      expectedHash: schema.screenshot.sha256,
    });

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(receipt.dispatched).toBe(true);
    expect(receipt.after.revision).toBe(2);
  });

  it("rejects input when the selected control moved, even if the window merely animates", async () => {
    const frames = Array.from({ length: 6 }, (_, i) => animatedFrame(10 + i * 10));
    const { adapter, dispatch, inspectAccessibility } = mockAdapter(frames);
    const original = accessibilitySnapshot();
    const moved: AccessibilitySnapshot = {
      ...original,
      elements: [{
        ...original.elements[0],
        bounds: { x: 120, y: 60, width: 20, height: 20 },
        center: { x: 130, y: 70 },
      }],
    };
    inspectAccessibility
      .mockResolvedValueOnce(original)
      .mockResolvedValueOnce(moved);
    const session = createDesktopUiSession({
      adapter,
      target: { pid: 42, nativeId: "window-42" },
      allowInput: true,
    });
    const schema = await session.snapshot();

    await expect(session.click({
      elementId: "a1",
      expectedRevision: schema.screenshot.revision,
      expectedHash: schema.screenshot.sha256,
    })).rejects.toMatchObject({ code: "STALE_SCREENSHOT" });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("rejects input when the window is replaced after perception", async () => {
    const { adapter, dispatch } = mockAdapter([
      animatedFrame(10), animatedFrame(20),
      replacedFrame(), replacedFrame(),
    ]);
    const session = createDesktopUiSession({
      adapter,
      target: { pid: 42, nativeId: "window-42" },
      allowInput: true,
    });
    const schema = await session.snapshot();

    await expect(session.click({
      elementId: "a1",
      expectedRevision: schema.screenshot.revision,
      expectedHash: schema.screenshot.sha256,
    })).rejects.toMatchObject({ code: "STALE_SCREENSHOT" });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("rejects input when the selected control is visually replaced at the same bounds", async () => {
    const base = animatedFrame(10);
    // Same layout elsewhere, but the Save control area is repainted dark.
    const replacedControl = png(240, 160, (x, y) =>
      x >= 10 && x < 30 && y >= 10 && y < 30
        ? [15, 15, 140]
        : (x >= 10 && x < 16 && y >= 10 && y < 16 ? [20, 20, 20] : [250, 250, 250]));
    const { adapter, dispatch } = mockAdapter([base, replacedControl, replacedControl, replacedControl]);
    const session = createDesktopUiSession({
      adapter,
      target: { pid: 42, nativeId: "window-42" },
      allowInput: true,
    });
    const schema = await session.snapshot();

    await expect(session.click({
      elementId: "a1",
      expectedRevision: schema.screenshot.revision,
      expectedHash: schema.screenshot.sha256,
    })).rejects.toMatchObject({ code: "STALE_SCREENSHOT" });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("records the perception change ratio for auditing when wait_ready asks for it", async () => {
    const { adapter } = mockAdapter([animatedFrame(10), animatedFrame(40)]);
    const session = createDesktopUiSession({
      adapter,
      target: { pid: 42, nativeId: "window-42" },
    });

    const schema = await session.snapshot({ measureChangeRatio: true });

    expect(schema.screenshot.changeRatio).toBeGreaterThan(0);
    expect(schema.screenshot.changeRatio).toBeLessThan(0.12);
    expect(schema.warnings.join(" ")).toMatch(/sampled pixels changed/);
  });

  it("fails closed in the wait_ready settle check when the second frame is a replacement", async () => {
    const { adapter } = mockAdapter([animatedFrame(10), replacedFrame()]);
    const session = createDesktopUiSession({
      adapter,
      target: { pid: 42, nativeId: "window-42" },
    });

    await expect(session.snapshot({ measureChangeRatio: true }))
      .rejects.toMatchObject({ code: "STALE_SCREENSHOT" });
  });

  it("keeps accepting an animating window in the wait_ready settle check within budget", async () => {
    const { adapter } = mockAdapter([animatedFrame(10), animatedFrame(40)]);
    const session = createDesktopUiSession({
      adapter,
      target: { pid: 42, nativeId: "window-42" },
    });

    const schema = await session.snapshot({ measureChangeRatio: true });

    expect(schema.screenshot.revision).toBe(1);
    expect(schema.screenshot.changeRatio).toBeLessThanOrEqual(0.12);
  });

  it("prefers a persistent verified capture source over one-shot captures", async () => {
    const frames = [animatedFrame(10), animatedFrame(10), animatedFrame(20)];
    let index = 0;
    const sourceCapture = vi.fn(async (): Promise<NativeCapture> => ({
      image: frames[Math.min(index++, frames.length - 1)],
      capturedAt: "2026-11-27T00:00:00.000Z",
      targetWindow: window,
    }));
    const close = vi.fn();
    const adapterCapture = vi.fn(async () => {
      throw new Error("one-shot capture must not be used while the source is healthy");
    });
    const adapter: DesktopUiAdapter = {
      platform: "win32",
      probe: async () => capabilities,
      capture: adapterCapture,
      inspectAccessibility: async () => accessibilitySnapshot(),
      dispatch: vi.fn(async () => undefined),
    };
    const session = createDesktopUiSession({
      adapter,
      target: { pid: 42, nativeId: "window-42" },
      captureSource: { backend: "test-source", verifiedInsideCapture: true, capture: sourceCapture, close },
    });

    await session.snapshot();
    session.close();

    expect(adapterCapture).not.toHaveBeenCalled();
    expect(sourceCapture).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("falls back to one-shot capture when the verified source refuses", async () => {
    const stable = animatedFrame(10);
    const adapterCapture = vi.fn(async (): Promise<NativeCapture> => ({
      image: stable,
      capturedAt: "2026-11-27T00:00:00.000Z",
      targetWindow: window,
    }));
    const adapter: DesktopUiAdapter = {
      platform: "win32",
      probe: async () => capabilities,
      capture: adapterCapture,
      inspectAccessibility: async () => accessibilitySnapshot(),
      dispatch: vi.fn(async () => undefined),
    };
    const close = vi.fn();
    const session = createDesktopUiSession({
      adapter,
      target: { pid: 42, nativeId: "window-42" },
      captureSource: {
        backend: "test-source", verifiedInsideCapture: true,
        capture: async () => { throw new Error("title changed"); },
        close,
      },
    });

    const schema = await session.snapshot();

    expect(schema.elements).toHaveLength(1);
    expect(schema.warnings.join(" ")).toMatch(/Native capture source refused/);
    expect(adapterCapture).toHaveBeenCalled();
  });

  it("allows clipped control bounds within two device pixels", async () => {
    const frames = Array.from({ length: 6 }, (_, i) => animatedFrame(10 + i * 10));
    const { adapter, dispatch, inspectAccessibility } = mockAdapter(frames);
    const original = accessibilitySnapshot();
    const jittered: AccessibilitySnapshot = {
      ...original,
      elements: [{
        ...original.elements[0],
        bounds: { x: 11, y: 10, width: 20, height: 21 },
        center: { x: 21, y: 20.5 },
      }],
    };
    inspectAccessibility
      .mockResolvedValueOnce(original)
      .mockResolvedValueOnce(jittered);
    const session = createDesktopUiSession({
      adapter,
      target: { pid: 42, nativeId: "window-42" },
      allowInput: true,
    });
    const schema = await session.snapshot();

    const receipt = await session.click({
      elementId: "a1",
      expectedRevision: schema.screenshot.revision,
      expectedHash: schema.screenshot.sha256,
    });

    expect(receipt.dispatched).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  createDesktopUiSession,
  DesktopUiError,
  type AccessibilitySnapshot,
  type DesktopUiAdapter,
  type DesktopUiCapabilities,
  type DesktopWindow,
  type NativeCapture,
  type NativeDesktopAction,
} from "../../src/core/desktopUi/index.js";

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

function fakePng(width: number, height: number, marker: number): Uint8Array {
  const bytes = Buffer.alloc(25);
  Buffer.from(PNG_SIGNATURE).copy(bytes, 0);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes[24] = marker;
  return bytes;
}

const window: DesktopWindow = {
  pid: 42,
  nativeId: "window-42",
  title: "Fixture",
  active: true,
  bounds: { x: 0, y: 0, width: 100, height: 50 },
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

function accessibilitySnapshot(targetWindow: DesktopWindow = window): AccessibilitySnapshot {
  return {
    window: targetWindow,
    elements: [
      {
        role: "button",
        label: "Save",
        description: null,
        value: null,
        bounds: { x: 10, y: 10, width: 20, height: 20 },
        center: { x: 20, y: 20 },
        actionable: true,
        nativeRef: "native-save",
      },
      {
        role: "text",
        label: "Status",
        description: null,
        value: "Ready",
        bounds: { x: 5, y: 35, width: 30, height: 10 },
        center: { x: 20, y: 40 },
        actionable: false,
      },
    ],
  };
}

function mockAdapter(
  captures: Uint8Array[],
  options: {
    captureWindows?: DesktopWindow[];
    accessibility?: AccessibilitySnapshot;
  } = {},
): {
  adapter: DesktopUiAdapter;
  dispatch: ReturnType<typeof vi.fn>;
  capture: ReturnType<typeof vi.fn>;
} {
  let captureIndex = 0;
  const dispatch = vi.fn(async (_action: NativeDesktopAction) => undefined);
  const capture = vi.fn(async (): Promise<NativeCapture> => {
    const index = Math.min(captureIndex++, captures.length - 1);
    return {
      image: captures[index],
      capturedAt: "2026-11-08T09:00:00.000Z",
      targetWindow: options.captureWindows?.[Math.min(index, options.captureWindows.length - 1)] ?? window,
    };
  });
  const adapter: DesktopUiAdapter = {
    platform: "win32",
    probe: vi.fn(async () => capabilities),
    capture,
    inspectAccessibility: vi.fn(async () => options.accessibility ?? accessibilitySnapshot()),
    dispatch,
  };
  return { adapter, dispatch, capture };
}

describe("DesktopUiSession", () => {
  it("builds a coherent accessibility-first schema and keeps vision-only controls non-actionable", async () => {
    const frame = fakePng(100, 50, 1);
    const { adapter } = mockAdapter([frame, frame]);
    const session = createDesktopUiSession({
      adapter,
      target: { pid: 42, nativeId: "window-42" },
      vision: {
        detect: vi.fn(async () => [
          { role: "button", score: 0.94, box: [10, 10, 30, 30] },
          { role: "input", score: 0.81, box: [50, 10, 90, 30] },
        ]),
      },
    });

    const schema = await session.snapshot();

    expect(schema.version).toBe(1);
    expect(schema.screenshot.revision).toBe(1);
    expect(schema.screenshot.pixelRatioX).toBe(1);
    expect(schema.elements.filter((element) => element.source === "accessibility")).toHaveLength(2);
    const visual = schema.elements.filter((element) => element.source === "vision");
    expect(visual).toHaveLength(1);
    expect(visual[0]).toMatchObject({
      role: "input",
      label: null,
      source: "vision",
      confidence: 0.81,
      actionable: false,
      bounds: { x: 50, y: 10, width: 40, height: 20 },
    });
  });

  it("rejects a schema when screenshot and accessibility resolve different target windows", async () => {
    const frame = fakePng(100, 50, 1);
    const mismatched: DesktopWindow = {
      ...window,
      nativeId: "other-window",
      bounds: { x: 500, y: 500, width: 100, height: 50 },
    };
    const { adapter } = mockAdapter([frame, frame], {
      accessibility: accessibilitySnapshot(mismatched),
    });
    const session = createDesktopUiSession({ adapter, target: { pid: 42 } });

    await expect(session.snapshot()).rejects.toMatchObject({ code: "STALE_SCREENSHOT" });
  });

  it("rejects a schema when the confirmation capture changes after accessibility inspection", async () => {
    const before = fakePng(100, 50, 1);
    const changed = fakePng(100, 50, 2);
    const { adapter } = mockAdapter([before, changed]);
    const session = createDesktopUiSession({ adapter, target: { pid: 42 } });

    await expect(session.snapshot()).rejects.toMatchObject({ code: "STALE_SCREENSHOT" });
  });

  it("default-denies native input even when the adapter reports input support", async () => {
    const frame = fakePng(100, 50, 1);
    const { adapter, dispatch } = mockAdapter([frame, frame]);
    const session = createDesktopUiSession({
      adapter,
      target: { pid: 42, nativeId: "window-42" },
    });
    const schema = await session.snapshot();

    await expect(session.click({
      elementId: "a1",
      expectedRevision: schema.screenshot.revision,
      expectedHash: schema.screenshot.sha256,
    })).rejects.toMatchObject({ code: "INPUT_DISABLED" });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("rejects stale caller revisions and hashes before dispatch", async () => {
    const frame = fakePng(100, 50, 1);
    const { adapter, dispatch } = mockAdapter([frame, frame]);
    const session = createDesktopUiSession({
      adapter,
      target: { pid: 42, nativeId: "window-42" },
      allowInput: true,
    });
    const schema = await session.snapshot();

    await expect(session.click({
      elementId: "a1",
      expectedRevision: schema.screenshot.revision - 1,
      expectedHash: schema.screenshot.sha256,
    })).rejects.toMatchObject({ code: "STALE_SCREENSHOT" });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("recaptures immediately before input and rejects a changed target window", async () => {
    const before = fakePng(100, 50, 1);
    const changed = fakePng(100, 50, 2);
    const { adapter, dispatch } = mockAdapter([before, before, changed]);
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

  it("rejects a target identity or bounds change before dispatch even when pixels are unchanged", async () => {
    const frame = fakePng(100, 50, 1);
    const movedWindow: DesktopWindow = {
      ...window,
      bounds: { x: 10, y: 0, width: 100, height: 50 },
    };
    const { adapter, dispatch } = mockAdapter(
      [frame, frame, frame],
      { captureWindows: [window, window, movedWindow] },
    );
    const session = createDesktopUiSession({
      adapter,
      target: { pid: 42 },
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

  it("derives click coordinates from confirmed accessibility and returns post-action verification", async () => {
    const before = fakePng(100, 50, 1);
    const after = fakePng(100, 50, 2);
    const { adapter, dispatch } = mockAdapter([before, before, before, before, after, after]);
    const session = createDesktopUiSession({
      adapter,
      target: { pid: 42 },
      allowInput: true,
    });
    const schema = await session.snapshot();

    const receipt = await session.click({
      elementId: "a1",
      expectedRevision: schema.screenshot.revision,
      expectedHash: schema.screenshot.sha256,
    });

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0]).toMatchObject({
      kind: "click",
      target: { pid: 42, nativeId: "window-42", title: "Fixture" },
      point: { x: 20, y: 20 },
      element: { id: "a1", label: "Save", source: "accessibility" },
    });
    expect(receipt.dispatched).toBe(true);
    expect(receipt.screenChanged).toBe(true);
    expect(receipt.after.revision).toBe(2);
  });

  it("never permits input through a vision-only element", async () => {
    const frame = fakePng(100, 50, 1);
    const { adapter, dispatch } = mockAdapter([frame, frame, frame]);
    const session = createDesktopUiSession({
      adapter,
      target: { pid: 42 },
      allowInput: true,
      vision: {
        detect: vi.fn(async () => [{ role: "button", score: 0.99, box: [50, 10, 90, 30] }]),
      },
    });
    const schema = await session.snapshot();
    const visionElement = schema.elements.find((element) => element.source === "vision");
    expect(visionElement?.actionable).toBe(false);

    await expect(session.click({
      elementId: visionElement!.id,
      expectedRevision: schema.screenshot.revision,
      expectedHash: schema.screenshot.sha256,
    })).rejects.toMatchObject({ code: "ELEMENT_NOT_ACTIONABLE" });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("does not permit a non-actionable accessibility element", async () => {
    const frame = fakePng(100, 50, 1);
    const { adapter, dispatch } = mockAdapter([frame, frame, frame]);
    const session = createDesktopUiSession({
      adapter,
      target: { pid: 42, nativeId: "window-42" },
      allowInput: true,
    });
    const schema = await session.snapshot();

    await expect(session.click({
      elementId: "a2",
      expectedRevision: schema.screenshot.revision,
      expectedHash: schema.screenshot.sha256,
    })).rejects.toBeInstanceOf(DesktopUiError);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("rejects changed accessibility semantics even when screenshot pixels are identical", async () => {
    const frame = fakePng(100, 50, 1);
    const { adapter, dispatch } = mockAdapter([frame, frame, frame, frame]);
    const original = accessibilitySnapshot();
    const changed = {
      ...original,
      elements: [{ ...original.elements[0], label: "Delete" }, original.elements[1]],
    };
    vi.mocked(adapter.inspectAccessibility)
      .mockResolvedValueOnce(original)
      .mockResolvedValueOnce(changed);
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

  it("rejects a target that lost foreground focus before action", async () => {
    const frame = fakePng(100, 50, 1);
    const inactive = { ...window, active: false };
    const { adapter, dispatch } = mockAdapter([frame, frame, frame], {
      captureWindows: [window, window, inactive],
    });
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
    })).rejects.toMatchObject({ code: "TARGET_NOT_ACTIVE" });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("rejects accessible coordinates outside the scoped target window", async () => {
    const frame = fakePng(100, 50, 1);
    const original = accessibilitySnapshot();
    const outside = {
      ...original,
      elements: [{
        ...original.elements[0],
        bounds: { x: 200, y: 10, width: 20, height: 20 },
        center: { x: 210, y: 20 },
      }, original.elements[1]],
    };
    const { adapter, dispatch } = mockAdapter([frame, frame, frame, frame], {
      accessibility: outside,
    });
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
    })).rejects.toMatchObject({ code: "ELEMENT_NOT_ACTIONABLE" });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("rechecks screenshot pixels after pre-action accessibility inspection", async () => {
    const frame = fakePng(100, 50, 1);
    const changed = fakePng(100, 50, 2);
    const { adapter, dispatch } = mockAdapter([frame, frame, frame, changed]);
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

  it("never presents a sent click as a pre-dispatch failure when post-action verification fails", async () => {
    const before = fakePng(100, 50, 1);
    const after = fakePng(100, 50, 2);
    const { adapter, dispatch } = mockAdapter([before, before, before, before, after, before]);
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
    })).rejects.toMatchObject({
      code: "DISPATCH_UNVERIFIED",
      details: { dispatched: true, verificationErrorCode: "STALE_SCREENSHOT" },
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    await expect(session.click({
      elementId: "a1",
      expectedRevision: schema.screenshot.revision,
      expectedHash: schema.screenshot.sha256,
    })).rejects.toMatchObject({ code: "STALE_SCREENSHOT" });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("reports uncertain dispatch errors without claiming that OS input was not sent", async () => {
    const frame = fakePng(100, 50, 1);
    const { adapter, dispatch } = mockAdapter([frame, frame, frame, frame]);
    vi.mocked(adapter.dispatch).mockRejectedValueOnce(new Error("Input subsystem returned an error"));
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
    })).rejects.toMatchObject({
      code: "DISPATCH_UNVERIFIED",
      details: { dispatched: "unknown", dispatchErrorCode: "PROCESS_FAILED" },
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("does not pin a new window until screenshot and accessibility checks both pass", async () => {
    const frame = fakePng(100, 50, 1);
    const replacement = { ...window, nativeId: "replacement-window" };
    const { adapter, capture } = mockAdapter([frame, frame, frame, frame], {
      captureWindows: [window, replacement, replacement, replacement],
    });
    vi.mocked(adapter.inspectAccessibility).mockImplementation(
      async (_target, nativeCapture) => accessibilitySnapshot(nativeCapture.targetWindow),
    );
    const session = createDesktopUiSession({ adapter, target: { pid: 42 } });

    await expect(session.snapshot()).rejects.toMatchObject({ code: "STALE_SCREENSHOT" });
    const schema = await session.snapshot();
    expect(schema.screenshot.targetWindow.nativeId).toBe("replacement-window");
    expect(capture).toHaveBeenNthCalledWith(3, { pid: 42 });
  });

  it("requires verified focused-element identity for mutating untargeted key commands", async () => {
    const frame = fakePng(100, 50, 1);
    const { adapter, dispatch } = mockAdapter([frame, frame, frame, frame]);
    const session = createDesktopUiSession({
      adapter, target: { pid: 42, nativeId: "window-42" }, allowInput: true,
    });
    const schema = await session.snapshot();
    await expect(session.key({
      key: "DELETE",
      expectedRevision: schema.screenshot.revision,
      expectedHash: schema.screenshot.sha256,
    })).rejects.toMatchObject({ code: "ELEMENT_NOT_ACTIONABLE" });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("permits grounded mutating keys only while their focused control remains unchanged", async () => {
    const before = fakePng(100, 50, 1);
    const after = fakePng(100, 50, 2);
    const initial = accessibilitySnapshot();
    initial.elements[0].focused = true;
    const { adapter, dispatch } = mockAdapter(
      [before, before, before, before, after, after],
      { accessibility: initial },
    );
    const session = createDesktopUiSession({
      adapter, target: { pid: 42, nativeId: "window-42" }, allowInput: true,
    });
    const schema = await session.snapshot();
    const receipt = await session.key({
      key: "ENTER",
      expectedRevision: schema.screenshot.revision,
      expectedHash: schema.screenshot.sha256,
    });
    expect(receipt.dispatched).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("rejects an invisible focused-control switch during pre-action verification", async () => {
    const frame = fakePng(100, 50, 1);
    const first = accessibilitySnapshot();
    first.elements[0].focused = true;
    const second = accessibilitySnapshot();
    second.elements[1].focused = true;
    const { adapter, dispatch } = mockAdapter([frame, frame, frame, frame]);
    vi.mocked(adapter.inspectAccessibility)
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const session = createDesktopUiSession({
      adapter, target: { pid: 42, nativeId: "window-42" }, allowInput: true,
    });
    const schema = await session.snapshot();
    await expect(session.key({
      key: "ENTER",
      expectedRevision: schema.screenshot.revision,
      expectedHash: schema.screenshot.sha256,
    })).rejects.toMatchObject({ code: "STALE_SCREENSHOT" });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("serializes concurrent mutations so an old revision cannot dispatch twice", async () => {
    const before = fakePng(100, 50, 1);
    const after = fakePng(100, 50, 2);
    const { adapter, dispatch } = mockAdapter([before, before, before, before, after, after]);
    const session = createDesktopUiSession({
      adapter,
      target: { pid: 42 },
      allowInput: true,
    });
    const schema = await session.snapshot();
    const action = {
      elementId: "a1",
      expectedRevision: schema.screenshot.revision,
      expectedHash: schema.screenshot.sha256,
    };

    const [first, second] = await Promise.allSettled([
      session.click(action),
      session.click(action),
    ]);

    expect(first.status).toBe("fulfilled");
    expect(second.status).toBe("rejected");
    if (second.status === "rejected") {
      expect(second.reason).toMatchObject({ code: "STALE_SCREENSHOT" });
    }
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});

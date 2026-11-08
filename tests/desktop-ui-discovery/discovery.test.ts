import { afterEach, describe, expect, it, vi } from "vitest";
import {
  findDiscoveredWindows,
  listDiscoveredWindows,
  type AccessibilitySnapshot,
  type DesktopDiscoveredWindow,
  type DesktopUiAdapter,
  type DesktopUiCapabilities,
  type NativeCapture,
  type NativeDesktopAction,
} from "../../src/core/desktopUi/index.js";
import {
  DesktopUiConsentManager,
  DesktopUiSessionManager,
  desktopUiSessionManager,
  desktopUiTool,
  sanitizeDesktopUiLogPayload,
} from "../../src/core/tools/desktopUiTools.js";

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

function fakePng(): Uint8Array {
  const bytes = Buffer.alloc(25);
  Buffer.from(PNG_SIGNATURE).copy(bytes, 0);
  bytes.writeUInt32BE(640, 16);
  bytes.writeUInt32BE(480, 20);
  bytes[24] = 1;
  return bytes;
}

const windowA: DesktopDiscoveredWindow = {
  pid: 401,
  nativeId: "40101",
  title: "Quarterly Notes",
  application: "Notepad",
  active: true,
  bounds: { x: 10, y: 20, width: 640, height: 480 },
  scaleFactor: 1.25,
};

const windowB: DesktopDiscoveredWindow = {
  pid: 402,
  nativeId: "40201",
  title: "Project Dashboard",
  application: "Browser",
  active: false,
  bounds: { x: 680, y: 20, width: 800, height: 600 },
  scaleFactor: 1,
};

const capabilities: DesktopUiCapabilities = {
  platform: "win32",
  available: true,
  screenshot: true,
  accessibility: true,
  input: false,
  scroll: false,
  prerequisites: [],
  limitations: [],
  errors: [],
};

function createAdapter(options: { failCapture?: boolean } = {}) {
  const dispatch = vi.fn(async (_action: NativeDesktopAction) => undefined);
  const listWindows = vi.fn(async (limit: number) => ({
    windows: [windowA, windowB].slice(0, limit),
    limit,
    truncated: limit < 2,
  }));
  const capture = vi.fn(async (): Promise<NativeCapture> => {
    if (options.failCapture) throw new Error("fixture capture failure");
    return {
      image: fakePng(),
      capturedAt: "2026-11-08T16:00:00.000Z",
      targetWindow: {
        pid: windowA.pid,
        nativeId: windowA.nativeId,
        title: windowA.title,
        active: windowA.active,
        bounds: windowA.bounds,
        scaleFactor: windowA.scaleFactor,
      },
    };
  });
  const accessibility: AccessibilitySnapshot = {
    window: {
      pid: windowA.pid,
      nativeId: windowA.nativeId,
      title: windowA.title,
      active: windowA.active,
      bounds: windowA.bounds,
      scaleFactor: windowA.scaleFactor,
    },
    elements: [{
      role: "button",
      label: "Save",
      description: null,
      value: null,
      bounds: { x: 20, y: 30, width: 100, height: 30 },
      center: { x: 70, y: 45 },
      actionable: true,
      nativeRef: "save-button",
    }],
  };
  const adapter: DesktopUiAdapter = {
    platform: "win32",
    probe: vi.fn(async () => capabilities),
    listWindows,
    getActiveWindow: vi.fn(async () => windowA),
    capture,
    inspectAccessibility: vi.fn(async () => accessibility),
    dispatch,
  };
  return { adapter, dispatch, listWindows, capture };
}

afterEach(() => vi.restoreAllMocks());

describe("desktop window discovery", () => {
  it("defaults to 50, preserves truncation, and hard-rejects limits above 100", async () => {
    const { adapter, listWindows } = createAdapter();
    const result = await listDiscoveredWindows(adapter);
    expect(listWindows).toHaveBeenCalledWith(50);
    expect(result.windows).toHaveLength(2);
    expect(result.truncated).toBe(false);

    await expect(listDiscoveredWindows(adapter, 101)).rejects.toMatchObject({ code: "INVALID_ACTION" });
    expect(listWindows).toHaveBeenCalledTimes(1);
  });

  it("fails closed when a provider returns duplicate native identities", async () => {
    const { adapter } = createAdapter();
    adapter.listWindows = vi.fn(async (limit) => ({
      windows: [windowA, { ...windowA }],
      limit,
      truncated: false,
    }));
    await expect(listDiscoveredWindows(adapter, 10)).rejects.toMatchObject({ code: "PROCESS_FAILED" });
  });

  it("finds case-insensitively by application or title with optional exact PID", () => {
    const discovery = { windows: [windowA, windowB], limit: 50, truncated: false };
    expect(findDiscoveredWindows(discovery, "notes")).toEqual([windowA]);
    expect(findDiscoveredWindows(discovery, "BROWSER")).toEqual([windowB]);
    expect(findDiscoveredWindows(discovery, "project", 401)).toEqual([]);
    expect(() => findDiscoveredWindows(discovery, " ")).toThrow(/1-256/);
    expect(() => findDiscoveredWindows(discovery, "x", 0)).toThrow(/positive integer/);
  });

  it("inspects only a freshly discovered exact pid/nativeId in a read-only ephemeral session", async () => {
    const manager = new DesktopUiSessionManager(new DesktopUiConsentManager());
    const { adapter, dispatch, listWindows } = createAdapter();
    const result = await manager.inspectWindow({
      pid: windowA.pid,
      nativeId: windowA.nativeId,
      ownerPrincipal: "principal-a",
      adapter,
    });

    expect(listWindows).toHaveBeenCalledWith(100);
    expect(result.window).toEqual(windowA);
    expect(result.schema.screenshot.targetWindow.nativeId).toBe(windowA.nativeId);
    expect(result.schema.elements[0]).toMatchObject({ role: "button", label: "Save", source: "accessibility" });
    expect(result).not.toHaveProperty("screenshotImage");
    expect(dispatch).not.toHaveBeenCalled();
    expect(manager.getActiveSessionsCount()).toBe(0);
  });

  it("returns screenshot bytes only on explicit request and closes the ephemeral session on error", async () => {
    const manager = new DesktopUiSessionManager(new DesktopUiConsentManager());
    const ok = createAdapter();
    const result = await manager.inspectWindow({
      pid: windowA.pid,
      nativeId: windowA.nativeId,
      ownerPrincipal: "principal-a",
      adapter: ok.adapter,
      includeScreenshotImage: true,
      maxImageBytes: 1024,
    });
    expect(result.screenshotImage).toBe(Buffer.from(fakePng()).toString("base64"));
    expect(manager.getActiveSessionsCount()).toBe(0);

    const failing = createAdapter({ failCapture: true });
    await expect(manager.inspectWindow({
      pid: windowA.pid,
      nativeId: windowA.nativeId,
      ownerPrincipal: "principal-a",
      adapter: failing.adapter,
    })).rejects.toThrow("fixture capture failure");
    expect(manager.getActiveSessionsCount()).toBe(0);
  });

  it("rejects stale or title-only inspection targets", async () => {
    const manager = new DesktopUiSessionManager(new DesktopUiConsentManager());
    const { adapter } = createAdapter();
    await expect(manager.inspectWindow({
      pid: windowA.pid,
      nativeId: "stale-native-id",
      ownerPrincipal: "principal-a",
      adapter,
    })).rejects.toMatchObject({ code: "TARGET_NOT_FOUND" });
  });

  it("redacts window discovery metadata from structured log payloads", () => {
    const sanitized = sanitizeDesktopUiLogPayload({
      title: "Private document title",
      application: "PrivateApp",
      query: "secret search",
      nested: { nativeId: "safe-stable-id" },
    });
    const serialized = JSON.stringify(sanitized);
    expect(serialized).not.toContain("Private document title");
    expect(serialized).not.toContain("PrivateApp");
    expect(serialized).not.toContain("secret search");
    expect(serialized).toContain("[REDACTED_WINDOW_METADATA]");
  });

  it("routes local list_windows and rejects discovery-only extra fields before host access", async () => {
    const list = vi.spyOn(desktopUiSessionManager, "listWindows").mockResolvedValue({
      windows: [windowA], limit: 5, truncated: false,
    });
    const success = JSON.parse(await desktopUiTool.execute({ command: "list_windows", limit: 5 }, "."));
    expect(success.success).toBe(true);
    expect(success.windows[0].nativeId).toBe(windowA.nativeId);
    expect(list).toHaveBeenCalledWith({ limit: 5 });

    const invalid = JSON.parse(await desktopUiTool.execute({
      command: "inspect_window",
      pid: windowA.pid,
      nativeId: windowA.nativeId,
      title: "must-not-authorize",
    }, "."));
    expect(invalid).toMatchObject({ success: false, code: "INVALID_ACTION" });
  });
});

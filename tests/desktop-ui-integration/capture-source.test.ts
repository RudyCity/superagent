import { describe, expect, it, vi } from "vitest";
import {
  DesktopUiConsentManager,
  DesktopUiSessionManager,
} from "../../src/core/tools/desktopUiTools.js";
import type {
  DesktopUiAdapter,
  DesktopWindowCaptureSource,
  DesktopWindowDiscoveryResult,
} from "../../src/core/desktopUi/types.js";
import type {
  ExecutableIdentity,
  PersistentAccessPolicy,
} from "../../src/core/desktopUi/persistentAccessPolicy.js";

const app: ExecutableIdentity = {
  platform: "win32",
  executablePath: "C:\\Apps\\Persistent\\persistent.exe",
  sha256: "d".repeat(64),
};

const policy: PersistentAccessPolicy = {
  version: 2,
  defaultEffect: "deny",
  rules: [
    { id: "view", kind: "desktop", effect: "allow", app, operations: ["view"], scope: {} },
    { id: "input", kind: "desktop", effect: "allow", app, operations: ["input"], scope: {} },
  ],
};

const window = {
  pid: 1201, nativeId: "556677", title: "Persistent Editor", application: "Persistent",
  active: true, bounds: { x: 0, y: 0, width: 800, height: 600 },
};

function fakePng(marker: number): Uint8Array {
  const bytes = Buffer.alloc(25);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes, 0);
  bytes.writeUInt32BE(120, 16);
  bytes.writeUInt32BE(90, 20);
  bytes[24] = marker;
  return bytes;
}

function harness(options: { sourceFails?: boolean } = {}) {
  const adapterCapture = vi.fn();
  const sourceCapture = vi.fn(async () => ({
    image: fakePng(7),
    capturedAt: new Date().toISOString(),
    targetWindow: window,
  }));
  const sourceClose = vi.fn();
  const openVerifiedCapture = vi.fn(async (): Promise<DesktopWindowCaptureSource> => ({
    backend: "win32-persistent-exact-hwnd",
    verifiedInsideCapture: true,
    capture: options.sourceFails
      ? async () => { throw new Error("refused"); }
      : sourceCapture,
    close: sourceClose,
  }));
  const adapter: DesktopUiAdapter = {
    platform: "win32",
    probe: async () => ({
      platform: "win32", available: true, screenshot: true, accessibility: true,
      input: true, scroll: true, prerequisites: [], limitations: [], errors: [],
    }),
    listWindows: async (limit): Promise<DesktopWindowDiscoveryResult> => ({
      windows: [window], limit, truncated: false,
    }),
    capture: adapterCapture.mockImplementation(async () => {
      throw new Error("one-shot capture should not run");
    }),
    inspectAccessibility: async () => ({
      window,
      elements: [{
        role: "button", label: "Run", description: null, value: null,
        bounds: { x: 12, y: 12, width: 56, height: 24 }, center: { x: 40, y: 24 },
        actionable: true, nativeRef: "run",
      }],
    }),
    dispatch: vi.fn(async () => undefined),
    openVerifiedCapture,
  };
  return { adapter, sourceCapture, sourceClose, openVerifiedCapture };
}

function manager() {
  return new DesktopUiSessionManager(new DesktopUiConsentManager(), {
    permanentRegistry: () => policy,
    executableIdentity: async () => app,
  });
}

describe("persistent capture source lifecycle", () => {
  it("opens one verified source per session and closes it on close", async () => {
    const { adapter, sourceCapture, sourceClose, openVerifiedCapture } = harness();
    const sessions = manager();
    const opened = await sessions.openSession({
      pid: window.pid, nativeId: window.nativeId, title: window.title,
      ownerPrincipal: "mcp-agent", allowInput: false, adapter,
    });

    expect(openVerifiedCapture).toHaveBeenCalledTimes(1);
    expect(openVerifiedCapture.mock.calls[0][0]).toMatchObject({ pid: window.pid, nativeId: window.nativeId });

    // openSession pre-warms both carriers: one frame plus one UIA read.
    expect(sourceCapture).toHaveBeenCalledTimes(1);

    await sessions.snapshot({ sessionToken: opened.sessionToken, ownerPrincipal: "mcp-agent" });
    // The first snapshot reuses the warm worker: exactly one more frame.
    expect(sourceCapture).toHaveBeenCalledTimes(2);

    sessions.closeSession(opened.sessionToken, "mcp-agent");
    expect(sourceClose).toHaveBeenCalledTimes(1);
  });

  it("closes the source when a session expires", async () => {
    const { adapter, sourceClose } = harness();
    const sessions = manager();
    const opened = await sessions.openSession({
      pid: window.pid, nativeId: window.nativeId, title: window.title,
      ownerPrincipal: "mcp-agent", allowInput: false, adapter,
    });
    expect(sourceClose).not.toHaveBeenCalled();

    sessions.revokeOperatorWindowSessions(window.pid, window.nativeId);
    expect(sourceClose).toHaveBeenCalledTimes(1);
    expect(sessions.getSession(opened.sessionToken, "mcp-agent")).toBeNull();
  });

  it("keeps working through one-shot capture when the source refuses", async () => {
    const { adapter } = harness({ sourceFails: true });
    adapter.capture = vi.fn(async () => ({
      image: fakePng(9), capturedAt: new Date().toISOString(), targetWindow: window,
    }));
    const sessions = manager();
    const opened = await sessions.openSession({
      pid: window.pid, nativeId: window.nativeId, title: window.title,
      ownerPrincipal: "mcp-agent", allowInput: false, adapter,
    });

    const snapshot = await sessions.snapshot({
      sessionToken: opened.sessionToken, ownerPrincipal: "mcp-agent",
    });

    expect(snapshot.schema.elements).toHaveLength(1);
    expect(adapter.capture).toHaveBeenCalled();
  });

  it("does not waste a carrier warm-up on one-shot inspect_window", async () => {
    const { adapter, sourceCapture } = harness();
    const sessions = manager();

    const inspected = await sessions.inspectWindow({
      pid: window.pid, nativeId: window.nativeId, adapter,
    });

    expect(inspected.schema.elements).toHaveLength(1);
    // One-shot inspection snapshots once and closes; pre-warming would only
    // duplicate that single perception, so exactly one frame is paid.
    expect(sourceCapture).toHaveBeenCalledTimes(1);
  });

  it("does not require the optional fast path", async () => {
    const { adapter, openVerifiedCapture } = harness();
    delete (adapter as { openVerifiedCapture?: unknown }).openVerifiedCapture;
    adapter.capture = vi.fn(async () => ({
      image: fakePng(3), capturedAt: new Date().toISOString(), targetWindow: window,
    }));
    const sessions = manager();
    const opened = await sessions.openSession({
      pid: window.pid, nativeId: window.nativeId, title: window.title,
      ownerPrincipal: "mcp-agent", allowInput: false, adapter,
    });

    await sessions.snapshot({ sessionToken: opened.sessionToken, ownerPrincipal: "mcp-agent" });
    expect(openVerifiedCapture).not.toHaveBeenCalled();
    expect(adapter.capture).toHaveBeenCalled();
  });
});

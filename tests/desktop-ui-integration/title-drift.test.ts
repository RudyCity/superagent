import { describe, expect, it, vi } from "vitest";
import {
  DesktopUiConsentManager,
  DesktopUiSessionManager,
  desktopWindowTitlesMatch,
  normalizeDesktopWindowTitle,
} from "../../src/core/tools/desktopUiTools.js";
import type { DesktopUiAdapter } from "../../src/core/desktopUi/types.js";
import type {
  ExecutableIdentity,
  PersistentAccessPolicy,
} from "../../src/core/desktopUi/persistentAccessPolicy.js";

const app: ExecutableIdentity = {
  platform: "win32",
  executablePath: "C:\\Users\\USER\\AppData\\Local\\Programs\\Antigravity\\Antigravity.exe",
  sha256: "a".repeat(64),
};

function policy(rules: PersistentAccessPolicy["rules"]): PersistentAccessPolicy {
  return { version: 2, defaultEffect: "deny", rules };
}

const appScoped = policy([
  { id: "antigravity-view", kind: "desktop", effect: "allow", app, operations: ["view"], scope: {} },
  { id: "antigravity-input", kind: "desktop", effect: "allow", app, operations: ["input"], scope: {} },
]);

const titleScoped = policy([
  {
    id: "antigravity-view-title", kind: "desktop", effect: "allow", app,
    operations: ["view"], scope: { windowTitle: "Optimize All Preset Factors" },
  },
  {
    id: "antigravity-input-title", kind: "desktop", effect: "allow", app,
    operations: ["input"], scope: { windowTitle: "Optimize All Preset Factors" },
  },
]);

const png = () => {
  const bytes = Buffer.alloc(25);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes, 0);
  bytes.writeUInt32BE(120, 16);
  bytes.writeUInt32BE(90, 20);
  return bytes;
};

function harness(initialTitle: string) {
  const state = { title: initialTitle };
  const dispatch = vi.fn(async () => undefined);
  const currentWindow = () => ({
    pid: 801,
    nativeId: "hwnd-801",
    title: state.title,
    application: "Antigravity",
    active: true,
    bounds: { x: 0, y: 0, width: 1200, height: 800 },
  });
  const adapter: DesktopUiAdapter = {
    platform: "win32",
    probe: async () => ({
      platform: "win32", available: true, screenshot: true, accessibility: true,
      input: true, scroll: true, prerequisites: [], limitations: [], errors: [],
    }),
    listWindows: async (limit) => ({ windows: [currentWindow()], limit, truncated: false }),
    capture: async () => ({
      image: png(), capturedAt: new Date().toISOString(), targetWindow: currentWindow(),
    }),
    inspectAccessibility: async () => ({
      window: currentWindow(),
      elements: [{
        role: "button", label: "Send", description: null, value: null,
        bounds: { x: 10, y: 10, width: 60, height: 24 }, center: { x: 40, y: 22 },
        actionable: true, nativeRef: "send",
      }],
    }),
    dispatch,
  };
  return { state, adapter, dispatch };
}

function manager(persistent: PersistentAccessPolicy) {
  return new DesktopUiSessionManager(new DesktopUiConsentManager(), {
    permanentRegistry: () => persistent,
    executableIdentity: async () => app,
  });
}

describe("desktop window title handling", () => {
  it("normalizes truncation and whitespace for comparison", () => {
    expect(normalizeDesktopWindowTitle("Optimize All Preset Facto...")).toBe("optimize all preset facto");
    expect(normalizeDesktopWindowTitle("  Optimize   All Preset Factors ")).toBe("optimize all preset factors");
    expect(desktopWindowTitlesMatch("Optimize All Preset Facto...", "Optimize All Preset Factors")).toBe(true);
    expect(desktopWindowTitlesMatch("Optimize All Preset Factors", "Optimize All Preset Factors")).toBe(true);
    expect(desktopWindowTitlesMatch("EA And Preset Identificat...", "Optimize All Preset Factors")).toBe(false);
  });

  it("canonicalizes a stale caller title for an app-scoped approval", async () => {
    const { adapter } = harness("Optimize All Preset Factors");
    const opened = await manager(appScoped).openSession({
      pid: 801, nativeId: "hwnd-801",
      title: "Optimize All Preset Facto...",
      ownerPrincipal: "mcp-agent", allowInput: true, adapter,
    });

    expect(opened.target.title).toBe("Optimize All Preset Factors");
    expect(opened.inputAllowed).toBe(true);
  });

  it("accepts an omitted title and still binds the exact OS window", async () => {
    const { adapter } = harness("Developing MCP Server for...");
    const opened = await manager(appScoped).openSession({
      pid: 801, nativeId: "hwnd-801",
      ownerPrincipal: "mcp-agent", allowInput: false, adapter,
    });

    expect(opened.target.title).toBe("Developing MCP Server for...");
    expect(opened.inputAllowed).toBe(false);
  });

  it("keeps an app-scoped session usable after the live window renames itself", async () => {
    const { adapter, dispatch, state } = harness("Optimize All Preset Factors");
    const sessions = manager(appScoped);
    const opened = await sessions.openSession({
      pid: 801, nativeId: "hwnd-801", title: "Optimize All Preset Factors",
      ownerPrincipal: "mcp-agent", allowInput: true, adapter,
    });

    state.title = "EA And Preset Identification";
    const snapshot = await sessions.snapshot({
      sessionToken: opened.sessionToken, ownerPrincipal: "mcp-agent",
    });
    expect(snapshot.schema.elements).toHaveLength(1);

    await sessions.action({
      sessionToken: opened.sessionToken,
      ownerPrincipal: "mcp-agent",
      action: "click",
      elementId: "a1",
      expectedRevision: snapshot.schema.screenshot.revision,
      expectedHash: snapshot.schema.screenshot.sha256,
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("still enforces an exact title for a title-scoped approval", async () => {
    const { adapter, state } = harness("Optimize All Preset Factors");
    const sessions = manager(titleScoped);
    const opened = await sessions.openSession({
      pid: 801, nativeId: "hwnd-801", title: "Optimize All Preset Factors",
      ownerPrincipal: "mcp-agent", allowInput: true, adapter,
    });

    state.title = "Secret Payroll";
    await expect(sessions.snapshot({
      sessionToken: opened.sessionToken, ownerPrincipal: "mcp-agent",
    })).rejects.toThrow(/Window title changed/);
  });

  it("rejects an unrelated caller title instead of binding the wrong document", async () => {
    const { adapter } = harness("Optimize All Preset Factors");
    await expect(manager(appScoped).openSession({
      pid: 801, nativeId: "hwnd-801", title: "Secret Payroll",
      ownerPrincipal: "mcp-agent", allowInput: true, adapter,
    })).rejects.toMatchObject({
      code: "INVALID_ACTION",
      message: expect.stringMatching(/exact full title/i),
    });
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  desktopUiErrorGuidance,
  DesktopUiConsentManager,
  DesktopUiSessionManager,
} from "../../src/core/tools/desktopUiTools.js";
import { dispatchDesktopUiMcpTool } from "../../src/core/mcp/tools/desktopUiMcpTools.js";
import type { DesktopUiAdapter } from "../../src/core/desktopUi/types.js";
import type {
  ExecutableIdentity,
  PersistentAccessPolicy,
} from "../../src/core/desktopUi/persistentAccessPolicy.js";

const app: ExecutableIdentity = {
  platform: "win32",
  executablePath: "C:\\Apps\\Live\\live.exe",
  sha256: "c".repeat(64),
};

const appScoped: PersistentAccessPolicy = {
  version: 2,
  defaultEffect: "deny",
  rules: [
    { id: "live-view", kind: "desktop", effect: "allow", app, operations: ["view"], scope: {} },
    { id: "live-input", kind: "desktop", effect: "allow", app, operations: ["input"], scope: {} },
  ],
};

const titleScoped: PersistentAccessPolicy = {
  version: 2,
  defaultEffect: "deny",
  rules: [
    {
      id: "live-view-title", kind: "desktop", effect: "allow", app,
      operations: ["view"], scope: { windowTitle: "Live Editor" },
    },
  ],
};

function fakePng(marker: number): Uint8Array {
  const bytes = Buffer.alloc(25);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes, 0);
  bytes.writeUInt32BE(120, 16);
  bytes.writeUInt32BE(90, 20);
  bytes[24] = marker;
  return bytes;
}

function harness(markers: number[], initialTitle = "Live Editor") {
  const state = { title: initialTitle };
  const currentWindow = () => ({
    pid: 901, nativeId: "hwnd-901", title: state.title, application: "Live Editor",
    active: true, bounds: { x: 0, y: 0, width: 1200, height: 800 },
  });
  let index = 0;
  const adapter: DesktopUiAdapter = {
    platform: "win32",
    probe: async () => ({
      platform: "win32", available: true, screenshot: true, accessibility: true,
      input: true, scroll: true, prerequisites: [], limitations: [], errors: [],
    }),
    listWindows: async (limit) => ({ windows: [currentWindow()], limit, truncated: false }),
    capture: async () => ({
      image: fakePng(markers[index++ % markers.length]),
      capturedAt: new Date().toISOString(),
      targetWindow: currentWindow(),
    }),
    inspectAccessibility: async () => ({
      window: currentWindow(),
      elements: [{
        role: "button", label: "Send", description: null, value: null,
        bounds: { x: 10, y: 10, width: 60, height: 24 }, center: { x: 40, y: 22 },
        actionable: true, nativeRef: "send",
      }],
    }),
    dispatch: vi.fn(async () => undefined),
  };
  return { adapter, state };
}

function manager(policy: PersistentAccessPolicy) {
  return new DesktopUiSessionManager(new DesktopUiConsentManager(), {
    permanentRegistry: () => policy,
    executableIdentity: async () => app,
  });
}

describe("wait_ready stable snapshot", () => {
  it("retries perception assembly failures until a schema is available", async () => {
    const { adapter } = harness([1, 2, 3, 3]);
    const sessions = manager(appScoped);
    const opened = await sessions.openSession({
      pid: 901, nativeId: "hwnd-901", title: "Live Editor",
      ownerPrincipal: "mcp-agent", allowInput: false, adapter,
    });

    const result = await sessions.waitForStableSnapshot({
      sessionToken: opened.sessionToken,
      ownerPrincipal: "mcp-agent",
      timeoutMs: 3000,
      pollIntervalMs: 50,
    });

    expect(result.attempts).toBe(2);
    expect(result.waitedMs).toBeGreaterThan(0);
    expect(result.schema.elements).toHaveLength(1);
  });

  it("gives up at the deadline with the last perception error", async () => {
    const { adapter } = harness([1, 2, 1, 2, 1, 2]);
    const sessions = manager(appScoped);
    const opened = await sessions.openSession({
      pid: 901, nativeId: "hwnd-901", title: "Live Editor",
      ownerPrincipal: "mcp-agent", allowInput: false, adapter,
    });

    await expect(sessions.waitForStableSnapshot({
      sessionToken: opened.sessionToken,
      ownerPrincipal: "mcp-agent",
      timeoutMs: 500,
      pollIntervalMs: 50,
    })).rejects.toMatchObject({ code: "STALE_SCREENSHOT" });
  });

  it("never retries permission denials", async () => {
    const { adapter, state } = harness([1, 1, 1, 1], "Live Editor");
    const sessions = manager(titleScoped);
    const opened = await sessions.openSession({
      pid: 901, nativeId: "hwnd-901", title: "Live Editor",
      ownerPrincipal: "mcp-agent", allowInput: false, adapter,
    });
    state.title = "Secret Payroll";

    const startedAt = Date.now();
    await expect(sessions.waitForStableSnapshot({
      sessionToken: opened.sessionToken,
      ownerPrincipal: "mcp-agent",
      timeoutMs: 5000,
      pollIntervalMs: 50,
    })).rejects.toMatchObject({ code: "INPUT_DISABLED" });
    expect(Date.now() - startedAt).toBeLessThan(2000);
  });

  it("returns machine-readable retry guidance from the MCP dispatcher", async () => {
    const result = await dispatchDesktopUiMcpTool(
      "superagent_desktop_ui",
      { command: "wait_ready", sessionToken: "0".repeat(64), timeoutMs: 500 },
      { principalId: "principal-test", workspace: "D:\\workspace" },
    );

    expect(result?.isError).toBe(true);
    const payload = JSON.parse(String((result?.content[0] as { text: string }).text));
    expect(payload.code).toBe("TARGET_NOT_FOUND");
    expect(payload.retryable).toBe(true);
    expect(payload.retryAfterMs).toBe(250);
    expect(payload.nextAction).toMatch(/find_window|list_windows/);
  });
});

describe("desktop UI error guidance", () => {
  it("marks transient conditions retryable and denials final", () => {
    expect(desktopUiErrorGuidance("STALE_SCREENSHOT")).toMatchObject({ retryable: true, retryAfterMs: 200 });
    expect(desktopUiErrorGuidance("TARGET_NOT_ACTIVE").retryable).toBe(true);
    expect(desktopUiErrorGuidance("INPUT_DISABLED").retryable).toBe(false);
    expect(desktopUiErrorGuidance("INVALID_ACTION").retryable).toBe(false);
    expect(desktopUiErrorGuidance("SOMETHING_ELSE").retryable).toBe(false);
  });
});

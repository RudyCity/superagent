import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DesktopNativeMediator,
  classifyDesktopSurface,
  sanitizeMediatedElements,
} from "../../src/core/desktopUi/desktopNativeMediator.js";
import { readPermanentAccessRegistryStatus } from "../../src/core/desktopUi/permanentRegistryStore.js";
import type { ExecutableIdentity, PersistentAccessPolicy } from "../../src/core/desktopUi/persistentAccessPolicy.js";
import type { DesktopDiscoveredWindow, DesktopUiAdapter } from "../../src/core/desktopUi/types.js";
import { DesktopUiConsentManager, DesktopUiSessionManager } from "../../src/core/tools/desktopUiTools.js";

const ownedTrayApp: ExecutableIdentity = {
  platform: "win32",
  executablePath: "C:\\Program Files\\SuperAgent\\superagent-tray.exe",
  sha256: "a".repeat(64),
};

const thirdPartyBrowser: ExecutableIdentity = {
  platform: "win32",
  executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  sha256: "b".repeat(64),
};

const pngBuffer = () => {
  const buf = Buffer.alloc(25);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buf, 0);
  buf.writeUInt32BE(120, 16);
  buf.writeUInt32BE(90, 20);
  return buf;
};

const tempDirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("M4 narrow native Desktop UI mediator", () => {
  it("permits verified owned SuperAgent surface controls and redacts sensitive fields/paths", async () => {
    const trayWindow: DesktopDiscoveredWindow = {
      pid: 7001,
      nativeId: "hwnd-7001",
      title: "SuperAgent Tray",
      application: "SuperAgent Tray",
      active: true,
      bounds: { x: 0, y: 0, width: 900, height: 700 },
    };
    const policy: PersistentAccessPolicy = {
      version: 2,
      defaultEffect: "deny",
      rules: [{
        id: "tray-view-only",
        kind: "desktop",
        effect: "allow",
        app: ownedTrayApp,
        operations: ["view"],
        scope: { windowTitle: "SuperAgent Tray" },
      }],
    };
    const mediator = new DesktopNativeMediator({
      ownedIdentities: [ownedTrayApp],
      registryStatus: () => ({ status: "valid", policy }),
      executableIdentity: async (pid) => (pid === 7001 ? ownedTrayApp : null),
      adapter: {
        platform: "win32",
        probe: async () => ({
          platform: "win32", available: true, screenshot: false,
          accessibility: true, input: true, scroll: false, prerequisites: [], limitations: [], errors: [],
        }),
        listWindows: async (limit) => ({ limit, windows: [trayWindow], truncated: false }),
        capture: async () => ({ image: pngBuffer(), capturedAt: "2026-11-19T00:00:00Z", targetWindow: trayWindow }),
        inspectAccessibility: async () => ({ window: trayWindow, elements: [] }),
        dispatch: async () => undefined,
      },
    });

    const viewDecision = await mediator.verifyTarget({
      pid: 7001,
      nativeId: "hwnd-7001",
      expectedTitle: "SuperAgent Tray",
      operation: "view",
    });
    expect(viewDecision.allowed).toBe(true);
    expect(viewDecision.surfaceClass).toBe("owned_superagent_surface");

    // View grant must NEVER implicitly upgrade to input.
    const inputDecision = await mediator.verifyTarget({
      pid: 7001,
      nativeId: "hwnd-7001",
      expectedTitle: "SuperAgent Tray",
      operation: "input",
      requireActive: true,
      elementRole: "button",
      elementLabel: "Approve",
    });
    expect(inputDecision.allowed).toBe(false);
    expect(inputDecision.code).toBe("NATIVE_CONSENT_REQUIRED");

    // Raw screenshots remain denied even for an owned surface.
    const screenshotDecision = await mediator.verifyTarget({
      pid: 7001,
      nativeId: "hwnd-7001",
      expectedTitle: "SuperAgent Tray",
      operation: "view",
      includeScreenshotImage: true,
    });
    expect(screenshotDecision.allowed).toBe(false);
    expect(screenshotDecision.code).toBe("SCREENSHOT_MEDIATION_DISABLED");

    const sanitized = sanitizeMediatedElements([
      {
        id: "a1",
        role: "button",
        label: "Approve Request",
        description: "Opens C:\\Users\\Private\\secret.env",
        value: null,
        bounds: { x: 10, y: 10, width: 80, height: 30 },
        center: { x: 50, y: 25 },
        source: "accessibility",
        confidence: 1,
        actionable: true,
      },
      {
        id: "a2",
        role: "textbox",
        label: "OAuth Bearer Token",
        description: null,
        value: "eyJhbGciOi...",
        bounds: { x: 10, y: 50, width: 200, height: 30 },
        center: { x: 110, y: 65 },
        source: "accessibility",
        confidence: 1,
        actionable: true,
      },
      {
        id: "a3",
        role: "filepicker",
        label: "Secret Directory",
        description: null,
        value: "C:\\Users\\Private",
        bounds: { x: 10, y: 90, width: 200, height: 30 },
        center: { x: 110, y: 105 },
        source: "accessibility",
        confidence: 1,
        actionable: false,
      },
    ]);
    expect(sanitized).toHaveLength(2);
    expect(sanitized[0].description).toBe("Opens [REDACTED_PATH]");
    expect(sanitized[1].value).toBe("[REDACTED_SENSITIVE_FIELD]");
  });

  it("denies third-party windows, user-mode title spoofing, PID reuse, and corrupt policy stores", async () => {
    const spoofedWindow: DesktopDiscoveredWindow = {
      pid: 9999,
      nativeId: "hwnd-9999",
      title: "SuperAgent Tray", // Attacker sets matching window title!
      application: "Google Chrome",
      active: true,
      bounds: { x: 0, y: 0, width: 1024, height: 768 },
    };
    expect(classifyDesktopSurface(thirdPartyBrowser, [ownedTrayApp])).toBe("third_party_window");

    const permissivePolicy: PersistentAccessPolicy = {
      version: 2,
      defaultEffect: "deny",
      rules: [{
        id: "browser-allow",
        kind: "desktop",
        effect: "allow",
        app: thirdPartyBrowser,
        operations: ["view", "input"],
        scope: { windowTitle: "SuperAgent Tray" },
      }],
    };
    const spoofMediator = new DesktopNativeMediator({
      ownedIdentities: [ownedTrayApp],
      registryStatus: () => ({ status: "valid", policy: permissivePolicy }),
      executableIdentity: async () => thirdPartyBrowser,
      adapter: {
        platform: "win32",
        probe: async () => ({
          platform: "win32", available: true, screenshot: false,
          accessibility: true, input: false, scroll: false, prerequisites: [], limitations: [], errors: [],
        }),
        listWindows: async (limit) => ({ limit, windows: [spoofedWindow], truncated: false }),
        capture: async () => ({ image: pngBuffer(), capturedAt: "2026-11-19T00:00:00Z", targetWindow: spoofedWindow }),
        inspectAccessibility: async () => ({ window: spoofedWindow, elements: [] }),
        dispatch: async () => undefined,
      },
    });
    const spoofRes = await spoofMediator.verifyTarget({
      pid: 9999,
      nativeId: "hwnd-9999",
      expectedTitle: "SuperAgent Tray",
      operation: "view",
    });
    expect(spoofRes.allowed).toBe(false);
    expect(spoofRes.surfaceClass).toBe("third_party_window");
    expect(spoofRes.code).toBe("THIRD_PARTY_CONTENT_DENIED");

    // Binary replacement / PID reuse fails closed.
    const replacedIdentity: ExecutableIdentity = { ...ownedTrayApp, sha256: "f".repeat(64) };
    const pidReuseMediator = new DesktopNativeMediator({
      ownedIdentities: [ownedTrayApp],
      registryStatus: () => ({ status: "valid", policy: permissivePolicy }),
      executableIdentity: async () => replacedIdentity,
      adapter: {
        platform: "win32",
        probe: async () => ({
          platform: "win32", available: true, screenshot: false,
          accessibility: true, input: false, scroll: false, prerequisites: [], limitations: [], errors: [],
        }),
        listWindows: async (limit) => ({ limit, windows: [spoofedWindow], truncated: false }),
        capture: async () => ({ image: pngBuffer(), capturedAt: "2026-11-19T00:00:00Z", targetWindow: spoofedWindow }),
        inspectAccessibility: async () => ({ window: spoofedWindow, elements: [] }),
        dispatch: async () => undefined,
      },
    });
    const pidReuseRes = await pidReuseMediator.verifyTarget({
      pid: 9999,
      nativeId: "hwnd-9999",
      expectedTitle: "SuperAgent Tray",
      operation: "view",
      pinnedIdentity: ownedTrayApp,
    });
    expect(pidReuseRes.allowed).toBe(false);
    expect(pidReuseRes.code).toBe("TARGET_IDENTITY_MISMATCH");

    // Corrupt policy file yields POLICY_STORE_UNAVAILABLE without leaking path.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sa-m4-corrupt-"));
    tempDirs.push(dir);
    fs.writeFileSync(path.join(dir, "desktop-access-registry.json"), "{corrupt_json");
    const status = readPermanentAccessRegistryStatus({ configDir: dir });
    expect(status.status).toBe("corrupt");
    const corruptMediator = new DesktopNativeMediator({
      ownedIdentities: [ownedTrayApp],
      registryStatus: () => status,
      executableIdentity: async () => ownedTrayApp,
    });
    const corruptRes = await corruptMediator.verifyTarget({
      pid: 7001,
      nativeId: "hwnd-7001",
      expectedTitle: "SuperAgent Tray",
      operation: "view",
    });
    expect(corruptRes.allowed).toBe(false);
    expect(corruptRes.code).toBe("POLICY_STORE_UNAVAILABLE");
    expect(JSON.stringify(corruptRes)).not.toContain(dir);
  });

  it("blocks post-open window title swaps and focus loss in DesktopUiSessionManager snapshot and action", async () => {
    let currentTitle = "SuperAgent Tray";
    let currentActive = true;
    const makeWindow = (): DesktopDiscoveredWindow => ({
      pid: 8001,
      nativeId: "hwnd-8001",
      title: currentTitle,
      application: "SuperAgent Tray",
      active: currentActive,
      bounds: { x: 0, y: 0, width: 900, height: 700 },
    });
    let policy: PersistentAccessPolicy = {
      version: 2,
      defaultEffect: "deny",
      rules: [
        {
          id: "tray-view",
          kind: "desktop",
          effect: "allow",
          app: ownedTrayApp,
          operations: ["view"],
          scope: { windowTitle: "SuperAgent Tray" },
        },
        {
          id: "tray-input-confirm",
          kind: "desktop",
          effect: "allow",
          app: ownedTrayApp,
          operations: ["input"],
          scope: { windowTitle: "SuperAgent Tray", elementRole: "button", elementLabel: "Confirm" },
        },
      ],
    };
    const adapter: DesktopUiAdapter = {
      platform: "win32",
      probe: async () => ({
        platform: "win32", available: true, screenshot: true,
        accessibility: true, input: true, scroll: false, prerequisites: [], limitations: [], errors: [],
      }),
      listWindows: async (limit) => ({ limit, windows: [makeWindow()], truncated: false }),
      capture: async () => ({ image: pngBuffer(), capturedAt: "2026-11-19T00:00:00Z", targetWindow: makeWindow() }),
      inspectAccessibility: async () => ({
        window: makeWindow(),
        elements: [{
          role: "button", label: "Confirm", description: null, value: null,
          bounds: { x: 10, y: 10, width: 80, height: 30 }, center: { x: 50, y: 25 },
          actionable: true, nativeRef: "confirm-btn",
        }],
      }),
      dispatch: async () => undefined,
    };

    const manager = new DesktopUiSessionManager(new DesktopUiConsentManager(), {
      permanentRegistry: () => policy,
      executableIdentity: async () => ownedTrayApp,
    });
    const opened = await manager.openSession({
      pid: 8001,
      nativeId: "hwnd-8001",
      title: "SuperAgent Tray",
      ownerPrincipal: "mcp-owner",
      allowInput: true,
      adapter,
    });
    expect(opened.inputAllowed).toBe(true);

    const snap = await manager.snapshot({ sessionToken: opened.sessionToken, ownerPrincipal: "mcp-owner" });
    expect(snap.schema.elements).toHaveLength(1);

    // Tab switch / title change to protected document must block subsequent snapshot and action!
    currentTitle = "secret-taxes.pdf - Viewer";
    await expect(manager.snapshot({
      sessionToken: opened.sessionToken,
      ownerPrincipal: "mcp-owner",
    })).rejects.toThrow(/Window title changed/);

    await expect(manager.action({
      sessionToken: opened.sessionToken,
      ownerPrincipal: "mcp-owner",
      action: "click",
      elementId: "a1",
      expectedRevision: snap.schema.screenshot.revision,
      expectedHash: snap.schema.screenshot.sha256,
    })).rejects.toThrow(/Window title or foreground focus changed/);

    // Even if title reverts, consent was revoked on failure.
    currentTitle = "SuperAgent Tray";
    currentActive = false;
    await expect(manager.action({
      sessionToken: opened.sessionToken,
      ownerPrincipal: "mcp-owner",
      action: "click",
      elementId: "a1",
      expectedRevision: snap.schema.screenshot.revision,
      expectedHash: snap.schema.screenshot.sha256,
    })).rejects.toThrow(/INPUT_DISABLED|revoked|changed/i);

    manager.closeSession(opened.sessionToken, "mcp-owner");
  });
});

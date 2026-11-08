import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MAX_IMAGE_BYTES,
  DesktopUiConsentManager,
  DesktopUiSessionManager,
  MIN_SESSION_TTL_MS,
} from "../../src/core/tools/desktopUiTools.js";
import type {
  AccessibilitySnapshot,
  DesktopUiAdapter,
  DesktopWindow,
  NativeCapture,
  NativeDesktopAction,
} from "../../src/core/desktopUi/index.js";

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

function fakePng(marker = 1): Uint8Array {
  const bytes = Buffer.alloc(25);
  Buffer.from(PNG_SIGNATURE).copy(bytes, 0);
  bytes.writeUInt32BE(100, 16);
  bytes.writeUInt32BE(50, 20);
  bytes[24] = marker;
  return bytes;
}

const targetWindow: DesktopWindow = {
  pid: 42,
  nativeId: "w42",
  title: "Fixture",
  active: true,
  bounds: { x: 0, y: 0, width: 100, height: 50 },
};

function accessibility(): AccessibilitySnapshot {
  return {
    window: targetWindow,
    elements: [{
      role: "button",
      label: "Save",
      description: null,
      value: null,
      bounds: { x: 10, y: 10, width: 20, height: 20 },
      center: { x: 20, y: 20 },
      actionable: true,
      nativeRef: "save",
    }],
  };
}

function adapterWithCaptures(captures: Uint8Array[]) {
  let index = 0;
  const dispatch = vi.fn(async (_action: NativeDesktopAction) => undefined);
  const adapter: DesktopUiAdapter = {
    platform: "win32",
    probe: vi.fn(async () => ({
      platform: "win32",
      available: true,
      screenshot: true,
      accessibility: true,
      input: true,
      scroll: true,
      prerequisites: [],
      limitations: [],
      errors: [],
    })),
    capture: vi.fn(async (): Promise<NativeCapture> => ({
      image: captures[Math.min(index++, captures.length - 1)],
      capturedAt: "2026-11-08T10:00:00.000Z",
      targetWindow,
    })),
    inspectAccessibility: vi.fn(async () => accessibility()),
    dispatch,
  };
  return { adapter, dispatch };
}

const envKeys = [
  "SUPERAGENT_DESKTOP_UI_ALLOW_INPUT",
  "SUPERAGENT_DESKTOP_ALLOW_INPUT",
  "SUPERAGENT_DESKTOP_INPUT_CONSENT",
  "SUPERAGENT_DESKTOP_UI_ALLOWED_TARGETS",
  "SUPERAGENT_DESKTOP_UI_ALLOW_VISION_UPLOAD",
  "SUPERAGENT_DESKTOP_UI_VISION_AUTH_TOKEN",
] as const;

afterEach(() => {
  vi.restoreAllMocks();
  for (const key of envKeys) delete process.env[key];
});

describe("desktop UI integration session security", () => {
  it("default-denies native input until exact host consent exists", async () => {
    const consent = new DesktopUiConsentManager();
    const manager = new DesktopUiSessionManager(consent);
    const frame = fakePng(1);
    const { adapter, dispatch } = adapterWithCaptures([frame, frame, frame]);
    const opened = await manager.openSession({
      pid: 42,
      nativeId: "w42",
      title: "Fixture",
      ownerPrincipal: "principal-a",
      allowInput: true,
      adapter,
    });
    expect(opened.inputAllowed).toBe(false);

    const schema = (await manager.snapshot({
      sessionToken: opened.sessionToken,
      ownerPrincipal: "principal-a",
    })).schema;

    await expect(manager.action({
      sessionToken: opened.sessionToken,
      ownerPrincipal: "principal-a",
      action: "click",
      elementId: "a1",
      expectedRevision: schema.screenshot.revision,
      expectedHash: schema.screenshot.sha256,
    })).rejects.toMatchObject({ code: "INPUT_DISABLED" });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("never authorizes by title/nativeId alone and requires exact PID plus nativeId for target grants", () => {
    const consent = new DesktopUiConsentManager();
    expect(() => consent.grantConsent({ title: "Fixture" })).toThrow(/pid\/nativeId/);
    expect(() => consent.grantConsent({ nativeId: "w42" })).toThrow(/pid\/nativeId/);

    consent.grantConsent({ pid: 42, nativeId: "w42", title: "Fixture" });
    expect(consent.hasConsent({ pid: 42, nativeId: "w42", title: "Renamed" })).toBe(true);
    expect(consent.hasConsent({ pid: 43, nativeId: "w42", title: "Fixture" })).toBe(false);
    expect(consent.hasConsent({ pid: 42, nativeId: "other", title: "Fixture" })).toBe(false);
  });

  it("does not let legacy global env consent authorize arbitrary targets without exact allowlist entry", () => {
    process.env.SUPERAGENT_DESKTOP_UI_ALLOW_INPUT = "true";
    const consent = new DesktopUiConsentManager();
    expect(consent.hasConsent({ pid: 42, nativeId: "w42", title: "Fixture" })).toBe(false);

    process.env.SUPERAGENT_DESKTOP_UI_ALLOWED_TARGETS = JSON.stringify([{ pid: 42, nativeId: "w42" }]);
    expect(consent.hasConsent({ pid: 42, nativeId: "w42", title: "Fixture" })).toBe(true);
    expect(consent.hasConsent({ pid: 42, nativeId: "other", title: "Fixture" })).toBe(false);
  });

  it("supports exact session-token consent without widening another session", async () => {
    const consent = new DesktopUiConsentManager();
    const manager = new DesktopUiSessionManager(consent);
    const frame = fakePng(1);
    const { adapter, dispatch } = adapterWithCaptures([frame, frame, frame, frame, frame]);
    const opened = await manager.openSession({
      pid: 42,
      nativeId: "w42",
      title: "Fixture",
      ownerPrincipal: "principal-a",
      allowInput: true,
      adapter,
    });
    consent.grantConsent({ sessionToken: opened.sessionToken });

    const schema = (await manager.snapshot({
      sessionToken: opened.sessionToken,
      ownerPrincipal: "principal-a",
    })).schema;
    await manager.action({
      sessionToken: opened.sessionToken,
      ownerPrincipal: "principal-a",
      action: "click",
      elementId: "a1",
      expectedRevision: schema.screenshot.revision,
      expectedHash: schema.screenshot.sha256,
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("binds session tokens to their owner principal and invalidates them on close", async () => {
    const manager = new DesktopUiSessionManager(new DesktopUiConsentManager());
    const { adapter } = adapterWithCaptures([fakePng()]);
    const opened = await manager.openSession({
      pid: 42,
      nativeId: "w42",
      title: "Fixture",
      ownerPrincipal: "principal-a",
      adapter,
    });

    expect(manager.getSession(opened.sessionToken, "principal-a")).not.toBeNull();
    expect(manager.getSession(opened.sessionToken, "principal-b")).toBeNull();
    expect(manager.closeSession(opened.sessionToken, "principal-b")).toEqual({ closed: false });
    expect(manager.closeSession(opened.sessionToken, "principal-a")).toEqual({ closed: true });
    expect(manager.getSession(opened.sessionToken, "principal-a")).toBeNull();
  });

  it("uses absolute bounded TTL and activity does not extend expiry", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const manager = new DesktopUiSessionManager(new DesktopUiConsentManager());
    const frame = fakePng(1);
    const { adapter } = adapterWithCaptures([frame, frame]);
    const opened = await manager.openSession({
      pid: 42,
      nativeId: "w42",
      title: "Fixture",
      ownerPrincipal: "principal-a",
      adapter,
      ttlMs: MIN_SESSION_TTL_MS,
    });
    const originalExpiry = opened.expiresAt;

    now += 30_000;
    await manager.snapshot({ sessionToken: opened.sessionToken, ownerPrincipal: "principal-a" });
    expect(manager.getSession(opened.sessionToken, "principal-a")?.expiresAt).toBe(originalExpiry);

    now = originalExpiry + 1;
    expect(manager.getSession(opened.sessionToken, "principal-a")).toBeNull();
  });

  it("rejects stale screenshots before native action dispatch", async () => {
    const consent = new DesktopUiConsentManager();
    consent.grantConsent({ pid: 42, nativeId: "w42" });
    const manager = new DesktopUiSessionManager(consent);
    const before = fakePng(1);
    const changed = fakePng(2);
    const { adapter, dispatch } = adapterWithCaptures([before, before, changed]);
    const opened = await manager.openSession({
      pid: 42,
      nativeId: "w42",
      title: "Fixture",
      ownerPrincipal: "principal-a",
      allowInput: true,
      adapter,
    });
    const schema = (await manager.snapshot({
      sessionToken: opened.sessionToken,
      ownerPrincipal: "principal-a",
    })).schema;

    await expect(manager.action({
      sessionToken: opened.sessionToken,
      ownerPrincipal: "principal-a",
      action: "click",
      elementId: "a1",
      expectedRevision: schema.screenshot.revision,
      expectedHash: schema.screenshot.sha256,
    })).rejects.toMatchObject({ code: "STALE_SCREENSHOT" });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("keeps vision off by default and requires trusted host opt-in when requested", async () => {
    const manager = new DesktopUiSessionManager(new DesktopUiConsentManager());
    const { adapter } = adapterWithCaptures([fakePng()]);
    await expect(manager.openSession({
      pid: 42,
      nativeId: "w42",
      title: "Fixture",
      ownerPrincipal: "principal-a",
      adapter,
    })).resolves.toMatchObject({ inputAllowed: false });

    await expect(manager.openSession({
      pid: 42,
      nativeId: "w42",
      title: "Fixture",
      ownerPrincipal: "principal-a",
      adapter,
      enableVision: true,
    })).rejects.toMatchObject({ code: "VISION_UNAVAILABLE" });
  });

  it("enforces hard screenshot, modifier, scroll, revision and hash bounds", async () => {
    const consent = new DesktopUiConsentManager();
    consent.grantConsent({ pid: 42, nativeId: "w42" });
    const manager = new DesktopUiSessionManager(consent);
    const frame = fakePng(1);
    const { adapter } = adapterWithCaptures([frame, frame, frame, frame, frame]);
    const opened = await manager.openSession({
      pid: 42,
      nativeId: "w42",
      title: "Fixture",
      ownerPrincipal: "principal-a",
      allowInput: true,
      adapter,
    });

    await expect(manager.snapshot({
      sessionToken: opened.sessionToken,
      ownerPrincipal: "principal-a",
      maxImageBytes: DEFAULT_MAX_IMAGE_BYTES + 1,
    })).rejects.toMatchObject({ code: "INVALID_ACTION" });

    const schema = (await manager.snapshot({
      sessionToken: opened.sessionToken,
      ownerPrincipal: "principal-a",
    })).schema;

    await expect(manager.action({
      sessionToken: opened.sessionToken,
      ownerPrincipal: "principal-a",
      action: "key",
      key: "ENTER",
      modifiers: ["CTRL", "CTRL"],
      expectedRevision: schema.screenshot.revision,
      expectedHash: schema.screenshot.sha256,
    })).rejects.toMatchObject({ code: "INVALID_ACTION" });

    await expect(manager.action({
      sessionToken: opened.sessionToken,
      ownerPrincipal: "principal-a",
      action: "scroll",
      elementId: "a1",
      deltaY: 1.5,
      expectedRevision: schema.screenshot.revision,
      expectedHash: schema.screenshot.sha256,
    })).rejects.toMatchObject({ code: "INVALID_ACTION" });

    await expect(manager.action({
      sessionToken: opened.sessionToken,
      ownerPrincipal: "principal-a",
      action: "click",
      elementId: "a1",
      expectedRevision: 1.5,
      expectedHash: "not-a-hash",
    })).rejects.toMatchObject({ code: "INVALID_ACTION" });
  });
});

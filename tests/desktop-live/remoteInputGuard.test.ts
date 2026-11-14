import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { RemoteControlAuthority, type RemoteControlChallenge,
  type RemoteHostScope, type RemotePrincipal } from "../../src/core/desktopUi/remoteControlAuthority.js";
import {
  RemoteInputGuard, parseRemoteInputRequest, semanticElementHash,
  REMOTE_INPUT_MAX_CAPTURE_AGE_MS,
} from "../../src/core/desktopUi/remoteInputGuard.js";
import type { DesktopUiSchema, DesktopUiElement } from "../../src/core/desktopUi/types.js";

const nowBase = 1_800_000_000_000;
const caller: RemotePrincipal = {
  principalId: "session-bound-user", connectionId: "remote-connection",
  viewSessionId: "view-signed-by-host",
};
const scope: RemoteHostScope = {
  platform: "win32", pid: 42, nativeId: "hwnd:001",
  processBirthId: "created-009", osUserId: "S-1-5-21-55",
  hostSessionId: "signed-host-login", hostGeneration: 9,
  viewSessionId: caller.viewSessionId,
};
const element: DesktopUiElement = {
  id: "a1", role: "textbox", label: "Find", description: "",
  value: "", bounds: { x: 120, y: 120, width: 200, height: 30 },
  center: { x: 220, y: 135 }, source: "accessibility",
  confidence: 1, actionable: true, focused: true, nativeRef: "uia:window-001:search",
};
function schema(now = nowBase): DesktopUiSchema {
  return {
    version: 1, platform: "win32",
    screenshot: {
      revision: 7, sha256: "a".repeat(64),
      capturedAt: new Date(now - 50).toISOString(),
      width: 1024, height: 720, pixelRatioX: 1, pixelRatioY: 1,
      targetWindow: {
        pid: 42, nativeId: "hwnd:001", title: "Pinned app",
        bounds: { x: 0, y: 0, width: 1024, height: 720 },
        active: true,
      },
    },
    elements: [{ ...element, bounds: { ...element.bounds }, center: { ...element.center } }],
    windows: [], warnings: [],
  };
}
function request(kind: "click" | "type" | "key" | "scroll", sequence = 1) {
  const common = { kind, sequence, expectedRevision: 7,
    expectedHash: "a".repeat(64), elementId: "a1",
    expectedElementHash: semanticElementHash(element) };
  if (kind === "type") return { ...common, text: "safe-text" };
  if (kind === "key") return { ...common, key: "ENTER" };
  if (kind === "scroll") return { ...common, deltaX: 0, deltaY: 1 };
  return common;
}

function fixture() {
  let now = nowBase;
  let current = schema(now);
  let nativeScope: RemoteHostScope = { ...scope };
  let rbac = true;
  let captureCount = 0;
  const trust = {
    currentScope: () => nativeScope,
    authorizeCaller: () => rbac,
    verifyNativeControlApproval: (challenge: RemoteControlChallenge, proof: unknown) =>
      proof === createHmac("sha256", "test-host-only-secret")
        .update(JSON.stringify(challenge)).digest("hex"),
  };
  const control = new RemoteControlAuthority(trust, () => now);
  const challenge = control.request(caller);
  const signed = createHmac("sha256", "test-host-only-secret")
    .update(JSON.stringify(challenge)).digest("hex");
  const { token } = control.confirmNativeApproval(challenge.nonce, signed);
  const guard = new RemoteInputGuard(control, async boundScope => {
    expect(boundScope).toEqual(scope);
    captureCount++;
    return current;
  }, () => now);
  return {
    control, guard, token,
    get current() { return current; },
    set current(s: DesktopUiSchema) { current = s; },
    get nativeScope() { return nativeScope; },
    set nativeScope(s: RemoteHostScope) { nativeScope = s; },
    get captureCount() { return captureCount; },
    get now() { return now; },
    set now(n: number) { now = n; },
    set rbac(b: boolean) { rbac = b; },
  };
}

describe("Desktop Live remote semantic input — no native dispatch", () => {
  it.each(["click", "type", "key", "scroll"] as const)(
    "accepts a pinned, recent, focused semantic %s without any client coordinates", async kind => {
      const f = fixture();
      const permit = await f.guard.prepare(caller, f.token, request(kind));
      expect(permit.action.kind).toBe(kind);
      expect(permit.action.nativeRef).toBe(element.nativeRef);
      expect(permit.action).not.toHaveProperty("x");
      expect(permit.action).not.toHaveProperty("point");
      expect(f.captureCount).toBe(1);
      expect(permit.signal.aborted).toBe(false);
      permit.consumeForNativeDispatch();
      expect(() => permit.consumeForNativeDispatch()).toThrow(/single use/);
      permit.finish();
      expect(permit.signal.aborted).toBe(true);
    },
  );

  it.each([
    ["non-string kind", { kind: { toString: () => "click" } }],
    ["coordinates", { x: 100, y: 200 }],
    ["process override", { pid: 123 }],
    ["scope override", { target: { pid: 999 } }],
    ["click without expected semantic hash", { expectedElementHash: undefined }],
    ["caller-selected modifier", { modifiers: ["CTRL"] }],
    ["noninteger revision", { expectedRevision: "7" }],
    ["noninteger sequence", { sequence: 1.1 }],
    ["malformed hash", { expectedHash: "g".repeat(64) }],
  ])("rejects malformed or unsafe click payload: %s", (_label, variant) => {
    expect(() => parseRemoteInputRequest({ ...request("click"), ...variant })).toThrow();
  });

  it.each([
    { kind: "key", key: "CTRL+A" },
    { kind: "key", key: "F12" },
    { kind: "key", key: "ENTER", modifiers: [] },
    { kind: "type", text: "" },
    { kind: "type", text: "a\u0000b" },
    { kind: "type", text: "x".repeat(4097) },
    { kind: "scroll", deltaX: 2, deltaY: -4 },
    { kind: "scroll", deltaX: 0.1, deltaY: 0 },
    { kind: "scroll", deltaX: 0, deltaY: 0 },
    { kind: "scroll", deltaX: "1", deltaY: 0 },
  ])("rejects malformed key/type/scroll request: $kind", variant => {
    const kind = variant.kind as "key" | "type" | "scroll";
    expect(() => parseRemoteInputRequest({ ...request(kind), ...variant })).toThrow();
  });

  it("denies forged screenshot revision/hash and expired or future capture", async () => {
    const f = fixture();
    await expect(f.guard.prepare(caller, f.token,
      { ...request("click"), expectedRevision: 8 })).rejects.toThrow(/screenshot/);
    // Sequence one was consumed by the failed verification; a replay must fail.
    await expect(f.guard.prepare(caller, f.token, request("click"))).rejects.toThrow(/sequence/);
    const next = fixture();
    const changed = schema();
    changed.screenshot.capturedAt =
      new Date(nowBase - REMOTE_INPUT_MAX_CAPTURE_AGE_MS - 1).toISOString();
    next.current = changed;
    await expect(next.guard.prepare(caller, next.token, request("click")))
      .rejects.toThrow(/Capture is stale/);
    const future = fixture();
    const after = schema();
    after.screenshot.capturedAt = new Date(nowBase + 101).toISOString();
    future.current = after;
    await expect(future.guard.prepare(caller, future.token, request("click")))
      .rejects.toThrow(/Capture is stale/);
  });

  it("rejects OS-window drift, background capture and vision-only element", async () => {
    const a = fixture();
    const wrongWindow = schema();
    wrongWindow.screenshot.targetWindow.nativeId = "hwnd:other";
    a.current = wrongWindow;
    await expect(a.guard.prepare(caller, a.token, request("click"))).rejects.toThrow(/window/);
    const b = fixture();
    const inactive = schema();
    inactive.screenshot.targetWindow.active = false;
    b.current = inactive;
    await expect(b.guard.prepare(caller, b.token, request("click"))).rejects.toThrow(/unfocused/);
    const c = fixture();
    const vision = schema();
    vision.elements[0].source = "vision";
    c.current = vision;
    await expect(c.guard.prepare(caller, c.token, request("click")))
      .rejects.toThrow(/accessibility/);
  });

  it("denies stale semantic hash, duplicate native references and out-of-window bounds", async () => {
    const a = fixture();
    const changed = schema();
    changed.elements[0].label = "Unexpected";
    a.current = changed;
    await expect(a.guard.prepare(caller, a.token, request("click"))).rejects.toThrow(/hash-matched/);
    const b = fixture();
    const duplicate = schema();
    duplicate.elements.push({ ...element, id: "a2" });
    b.current = duplicate;
    await expect(b.guard.prepare(caller, b.token, request("click")))
      .rejects.toThrow(/unique/);
    const c = fixture();
    const outside = schema();
    outside.elements[0].bounds.x = -10;
    c.current = outside;
    await expect(c.guard.prepare(caller, c.token, request("click")))
      .rejects.toThrow(/hash-matched/);
  });

  it("restricts type/key to an exact focused accessible control", async () => {
    const a = fixture();
    const notFocused = schema();
    notFocused.elements[0].focused = false;
    a.current = notFocused;
    const req = request("key");
    req.expectedElementHash = semanticElementHash(notFocused.elements[0]);
    await expect(a.guard.prepare(caller, a.token, req)).rejects.toThrow(/focused/);
    const b = fixture();
    const notEditable = schema();
    notEditable.elements[0].role = "button";
    b.current = notEditable;
    const typed = request("type");
    typed.expectedElementHash = semanticElementHash(notEditable.elements[0]);
    await expect(b.guard.prepare(caller, b.token, typed)).rejects.toThrow(/editable/);
  });

  it("rejects view-only token, remote role withdrawal, and stale host generation", async () => {
    const f = fixture();
    await expect(f.guard.prepare(caller, "0".repeat(64), request("click")))
      .rejects.toThrow(/not approved/);
    f.rbac = false;
    await expect(f.guard.prepare(caller, f.token, request("click")))
      .rejects.toThrow(/RBAC/);
    const changed = fixture();
    changed.nativeScope = { ...scope, hostGeneration: 10 };
    await expect(changed.guard.prepare(caller, changed.token, request("click")))
      .rejects.toThrow(/identity changed/);
  });

  it("revokes an outstanding capture immediately on human takeover", async () => {
    const f = fixture();
    let resolveCapture!: (value: DesktopUiSchema) => void;
    const deferred = new Promise<DesktopUiSchema>(resolve => { resolveCapture = resolve; });
    const guard = new RemoteInputGuard(f.control, () => deferred, () => f.now);
    const attempt = guard.prepare(caller, f.token, request("click"));
    f.control.humanTakeover();
    resolveCapture(schema());
    await expect(attempt).rejects.toThrow(/interrupted/);
  });

  it("serializes remote input, then rejects replay of a completed action", async () => {
    const f = fixture();
    const permit = await f.guard.prepare(caller, f.token, request("click", 1));
    await expect(f.guard.prepare(caller, f.token, request("click", 2)))
      .rejects.toThrow(/in progress/);
    permit.finish();
    await expect(f.guard.prepare(caller, f.token, request("click", 1)))
      .rejects.toThrow(/sequence/);
    const second = await f.guard.prepare(caller, f.token, request("click", 2));
    second.finish();
  });
});

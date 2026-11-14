import { describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import {
  RemoteControlAuthority, type RemoteHostScope, type RemotePrincipal,
  type RemoteControlChallenge,
} from "../../src/core/desktopUi/remoteControlAuthority.js";
import { RemoteNativeInputDispatcher } from "../../src/core/desktopUi/remoteNativeInputDispatch.js";
import { createWindowsRemoteSemanticAdapter, type WindowsNativeSemanticBinding,
  type WindowsNativeSemanticElement } from "../../src/core/desktopUi/adapters/windowsRemoteSemantic.js";
import { semanticElementHash } from "../../src/core/desktopUi/remoteInputGuard.js";
import { openVerifiedWindowsRemoteSemanticNative } from "../../src/core/desktopUi/adapters/windowsRemoteSemanticNative.js";
import { sha256 } from "../../src/core/desktopUi/png.js";
import type { DesktopUiElement, DesktopUiSchema } from "../../src/core/desktopUi/types.js";

const base = 1_800_000_000_000;
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZsAAAAASUVORK5CYII=",
  "base64",
);
const principal: RemotePrincipal = {
  principalId: "approved-controller", connectionId: "verified-private-link",
  viewSessionId: "view-checked",
};
const scope: RemoteHostScope = {
  platform: "win32", pid: 731, nativeId: "731",
  processBirthId: "filetime:133835174000000000",
  osUserId: "S-1-5-21-100-200-300-1001", hostSessionId: "session:1",
  hostGeneration: 4, viewSessionId: principal.viewSessionId,
};
const element: DesktopUiElement = {
  id: "e1", source: "accessibility", confidence: 1,
  nativeRef: "automationId:ActionOne", role: "button", label: "Action",
  description: null, value: null, actionable: true, focused: false,
  bounds: { x: 10, y: 20, width: 100, height: 30 },
  center: { x: 60, y: 35 },
};
function nativeElement(e = element): WindowsNativeSemanticElement {
  return {
    nativeRef: e.nativeRef!, role: e.role, label: e.label, description: e.description,
    value: e.value, actionable: e.actionable, focused: e.focused === true,
    bounds: { ...e.bounds }, center: { ...e.center },
    patterns: { invoke: true, value: false, scroll: false },
  };
}
function makeSchema(e = element, age = 10): DesktopUiSchema {
  return {
    version: 1, platform: "win32", windows: [], warnings: [], elements: [e],
    screenshot: {
      revision: 1, sha256: sha256(png),
      capturedAt: new Date(base - age).toISOString(), width: 1, height: 1,
      pixelRatioX: 1, pixelRatioY: 1,
      targetWindow: {
        pid: scope.pid, nativeId: scope.nativeId, title: "Disposable Fixture",
        active: true, bounds: { x: 0, y: 0, width: 400, height: 300 },
      },
    },
  };
}
function makeRequest(e = element, kind: "click" | "type" | "key" | "scroll" = "click") {
  const common = {
    kind, sequence: 1, expectedRevision: 1, expectedHash: sha256(png),
    elementId: e.id, expectedElementHash: semanticElementHash(e),
  };
  if (kind === "type") return { ...common, text: "safe words" };
  if (kind === "key") return { ...common, key: "ENTER" };
  if (kind === "scroll") return { ...common, deltaX: 0, deltaY: 1 };
  return common;
}
function fixture(e = element) {
  let now = base;
  let schema = makeSchema(e);
  let currentScope: RemoteHostScope = { ...scope };
  const secret = "only-local-fixture";
  const authority = new RemoteControlAuthority({
    currentScope: () => currentScope,
    authorizeCaller: () => true,
    verifyNativeControlApproval: (challenge: RemoteControlChallenge, proof: unknown) =>
      proof === createHmac("sha256", secret).update(JSON.stringify(challenge)).digest("hex"),
  }, () => now);
  const approve = () => {
    const challenge = authority.request(principal);
    const proof = createHmac("sha256", secret).update(JSON.stringify(challenge)).digest("hex");
    return authority.confirmNativeApproval(challenge.nonce, proof).token;
  };
  const frame = () => ({
    verifiedInsideCapture: true as const, hostScope: { ...currentScope },
    png, schema,
  });
  const events: string[] = [];
  let observation = nativeElement(e);
  const inspect = vi.fn((_scope: Readonly<RemoteHostScope>, _ref: string) => {
    events.push("inspect");
    return { element: observation, proof: JSON.stringify(observation) };
  });
  const act = vi.fn((
    _scope: Readonly<RemoteHostScope>, _ref: string, _kind: "click" | "type" | "scroll",
    _proof: string, _text: string, _dx: number, _dy: number, authorizeNow: () => void,
  ) => {
    events.push("native-precheck");
    authorizeNow(); // Represents the final native UIA action boundary.
    events.push("native-action");
    return true;
  });
  const native: WindowsNativeSemanticBinding = { inspect, act };
  const adapter = createWindowsRemoteSemanticAdapter({
    native, currentVerifiedFrame: frame, hostPlatform: "win32", now: () => now,
  });
  const dispatcher = new RemoteNativeInputDispatcher({
    authority, captureFresh: async () => frame(), adapter,
    hostPlatform: "win32", now: () => now,
  });
  return {
    approve, authority, adapter, dispatcher, events, inspect, act,
    get schema() { return schema; }, set schema(s) { schema = s; },
    get scope() { return currentScope; }, set scope(s) { currentScope = s; },
    get observation() { return observation; }, set observation(s) { observation = s; },
    get now() { return now; }, set now(value) { now = value; },
  };
}

describe("Windows nativeRef-only UI Automation: attended one-shot dispatch", () => {
  it("permits a unique fresh InvokePattern only after native revalidation and one native checkpoint", async () => {
    const f = fixture();
    expect(await f.dispatcher.dispatch(principal, f.approve(), makeRequest())).toEqual({ status: "dispatched" });
    expect(f.events).toEqual(["inspect", "native-precheck", "native-action"]);
    expect(f.inspect).toHaveBeenCalledWith(scope, "automationId:ActionOne");
    const args = f.act.mock.calls[0];
    expect(args.slice(0, 7)).toEqual([scope, "automationId:ActionOne", "click",
      JSON.stringify(nativeElement()), "", 0, 0]);
    expect(args[7]).toEqual(expect.any(Function));
    expect(f.act).toHaveBeenCalledTimes(1);
  });

  it("permits focused ValuePattern and a scoped ScrollPattern without keyboard or coordinates", async () => {
    const edit: DesktopUiElement = { ...element, role: "edit", focused: true,
      nativeRef: "automationId:InputA", value: null };
    const typed = fixture(edit);
    typed.observation = { ...nativeElement(edit), patterns: { invoke: false, value: true, scroll: false } };
    expect(await typed.dispatcher.dispatch(principal, typed.approve(), makeRequest(edit, "type")))
      .toEqual({ status: "dispatched" });
    expect(typed.act.mock.calls[0][4]).toBe("safe words");

    const pane: DesktopUiElement = { ...element, role: "combobox",
      nativeRef: "automationId:Scrollable" };
    const scrolled = fixture(pane);
    scrolled.observation = { ...nativeElement(pane), patterns: { invoke: false, value: false, scroll: true } };
    expect(await scrolled.dispatcher.dispatch(principal, scrolled.approve(), makeRequest(pane, "scroll")))
      .toEqual({ status: "dispatched" });
    expect(scrolled.act.mock.calls[0].slice(4, 7)).toEqual(["", 0, 1]);
  });

  it("blocks generic keys without substituting SendInput, coordinates or shortcuts", async () => {
    const edit = { ...element, role: "edit", focused: true };
    const f = fixture(edit);
    expect(await f.dispatcher.dispatch(principal, f.approve(), makeRequest(edit, "key")))
      .toEqual({ status: "blocked", reason: "NATIVE_DISPATCH_UNVERIFIED" });
    expect(f.act).not.toHaveBeenCalled();
  });

  it("refuses replaced native bounds, value, role, label, focus or element hash", async () => {
    const changes = [
      { bounds: { ...element.bounds, x: 25 }, center: { x: 75, y: 35 } },
      { label: "changed" }, { value: "stale" }, { role: "edit" },
      { focused: true }, { actionable: false },
    ] as const;
    for (const change of changes) {
      const f = fixture();
      f.observation = { ...f.observation, ...change };
      expect(await f.dispatcher.dispatch(principal, f.approve(), makeRequest()))
        .toEqual({ status: "blocked", reason: "NATIVE_DISPATCH_UNVERIFIED" });
      expect(f.act).not.toHaveBeenCalled();
    }
  });

  it("rejects ambiguous duplicate native references before the native boundary", async () => {
    const f = fixture();
    f.schema = { ...f.schema, elements: [element, { ...element, id: "e2" }] };
    expect(await f.dispatcher.dispatch(principal, f.approve(), makeRequest()))
      .toEqual({ status: "blocked", reason: "INPUT_DENIED" });
    expect(f.inspect).not.toHaveBeenCalled();
  });

  it("requires exact canonical HWND, SID, birth, session and generation", async () => {
    const mutations: Partial<RemoteHostScope>[] = [
      { nativeId: "hwnd:731" }, { processBirthId: "guessed" },
      { osUserId: "username" }, { hostSessionId: "unknown" },
      { hostGeneration: 0 }, { platform: "darwin" },
    ];
    for (const update of mutations) {
      const f = fixture();
      f.scope = { ...scope, ...update };
      let token: string;
      try { token = f.approve(); }
      catch {
        // Some invalid scopes are refused by Authority before an action exists.
        expect(f.act).not.toHaveBeenCalled();
        continue;
      }
      const result = await f.dispatcher.dispatch(principal, token, makeRequest());
      expect(result.status).toBe("blocked");
      expect(f.act).not.toHaveBeenCalled();
    }
  });

  it("rejects missing/forged screenshot or stale snapshot before reaching UIA", async () => {
    const mismatches = [
      (s: DesktopUiSchema): DesktopUiSchema => ({ ...s, screenshot: {
        ...s.screenshot, sha256: "a".repeat(64),
      } }),
      (s: DesktopUiSchema): DesktopUiSchema => makeSchema(element, 3_000),
      (s: DesktopUiSchema): DesktopUiSchema => ({ ...s, screenshot: {
        ...s.screenshot, targetWindow: { ...s.screenshot.targetWindow, active: false },
      } }),
    ];
    for (const mutate of mismatches) {
      const f = fixture();
      f.schema = mutate(f.schema);
      expect((await f.dispatcher.dispatch(principal, f.approve(), makeRequest())).status)
        .toBe("blocked");
      expect(f.act).not.toHaveBeenCalled();
    }
  });

  it("a human takeover before the native callback prevents action; no replay", async () => {
    const f = fixture();
    f.act.mockImplementationOnce((
      _scope, _ref, _kind, _proof, _text, _dx, _dy, authorizeNow,
    ) => {
      f.authority.humanTakeover();
      authorizeNow();
      return false;
    });
    const token = f.approve();
    expect(await f.dispatcher.dispatch(principal, token, makeRequest()))
      .toEqual({ status: "blocked", reason: "NATIVE_DISPATCH_UNVERIFIED" });
    expect(await f.dispatcher.dispatch(principal, token, { ...makeRequest(), sequence: 2 }))
      .toEqual({ status: "blocked", reason: "INPUT_DENIED" });
  });

  it("a native error after the checkpoint is UNCERTAIN, revokes grant and never retries", async () => {
    const f = fixture();
    f.act.mockImplementationOnce((
      _scope, _ref, _kind, _proof, _text, _dx, _dy, authorizeNow,
    ) => { authorizeNow(); return false; });
    const token = f.approve();
    expect(await f.dispatcher.dispatch(principal, token, makeRequest()))
      .toEqual({ status: "uncertain", reason: "NATIVE_DISPATCH_UNVERIFIED" });
    expect(await f.dispatcher.dispatch(principal, token, { ...makeRequest(), sequence: 2 }))
      .toEqual({ status: "blocked", reason: "INPUT_DENIED" });
  });

  it("rejects native methods that skip or replay final authorization", async () => {
    const skipped = fixture();
    skipped.act.mockImplementationOnce(() => true);
    expect(await skipped.dispatcher.dispatch(principal, skipped.approve(), makeRequest()))
      .toEqual({ status: "blocked", reason: "NATIVE_DISPATCH_UNVERIFIED" });
    const twice = fixture();
    twice.act.mockImplementationOnce((
      _scope, _ref, _kind, _proof, _text, _dx, _dy, authorizeNow,
    ) => { authorizeNow(); authorizeNow(); return true; });
    expect(await twice.dispatcher.dispatch(principal, twice.approve(), makeRequest()))
      .toEqual({ status: "uncertain", reason: "NATIVE_DISPATCH_UNVERIFIED" });
  });

  it("loaded native DLL (when present) rejects a nonexistent window without invoking UIA action", async () => {
    const native = await openVerifiedWindowsRemoteSemanticNative();
    if (!native) return; // CI without the separately compiled Windows-only artifact.
    try {
      expect(native.inspect({ ...scope, nativeId: "1" }, element.nativeRef!)).toBeNull();
    } finally { native.close(); }
  });
});

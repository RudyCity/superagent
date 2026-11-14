import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  RemoteNativeInputDispatcher,
  type RemoteNativeInputDependencies,
  type RemoteNativeSemanticAdapter,
  type RemoteNativeVerifiedFrame,
} from "../../src/core/desktopUi/remoteNativeInputDispatch.js";
import {
  RemoteControlAuthority,
  type RemoteControlChallenge,
  type RemoteHostScope,
  type RemotePrincipal,
} from "../../src/core/desktopUi/remoteControlAuthority.js";
import { semanticElementHash } from "../../src/core/desktopUi/remoteInputGuard.js";
import { sha256 } from "../../src/core/desktopUi/png.js";
import type { DesktopUiElement, DesktopUiSchema } from "../../src/core/desktopUi/types.js";

const nowBase = 1_800_000_000_000;
const image = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZsAAAAASUVORK5CYII=",
  "base64",
);
const caller: RemotePrincipal = {
  principalId: "controller", connectionId: "authenticated-transport",
  viewSessionId: "native-host-view",
};
const scope: RemoteHostScope = {
  platform: "win32", pid: 731, nativeId: "hwnd:731",
  processBirthId: "process-born-123", osUserId: "S-1-native-user",
  hostSessionId: "os-login-1", hostGeneration: 5, viewSessionId: caller.viewSessionId,
};
const element: DesktopUiElement = {
  id: "edit1", source: "accessibility", nativeRef: "automationId:SearchBox",
  role: "textbox", label: "Search", description: null, value: "",
  actionable: true, focused: true, confidence: 1,
  bounds: { x: 10, y: 20, width: 150, height: 30 },
  center: { x: 85, y: 35 },
};

function freshSchema(now = nowBase): DesktopUiSchema {
  return {
    version: 1, platform: "win32",
    screenshot: {
      revision: 1, sha256: sha256(image),
      capturedAt: new Date(now - 20).toISOString(),
      width: 1, height: 1, pixelRatioX: 1, pixelRatioY: 1,
      targetWindow: {
        pid: scope.pid, nativeId: scope.nativeId, title: "Approved app",
        bounds: { x: 0, y: 0, width: 1000, height: 800 }, active: true,
      },
    },
    windows: [], warnings: [], elements: [{ ...element }],
  };
}

function request(kind: "click" | "type" | "key" | "scroll" = "click", sequence = 1) {
  const base = {
    kind, sequence, expectedRevision: 1,
    expectedHash: sha256(image), elementId: "edit1",
    expectedElementHash: semanticElementHash(element),
  };
  switch (kind) {
    case "type": return { ...base, text: "hello" };
    case "key": return { ...base, key: "ENTER" };
    case "scroll": return { ...base, deltaX: 0, deltaY: -1 };
    default: return base;
  }
}

function fixture(overrides: Partial<RemoteNativeInputDependencies> = {}) {
  let now = nowBase;
  let pinnedScope: RemoteHostScope = { ...scope };
  let current: DesktopUiSchema = freshSchema();
  let capturedImage: Uint8Array = image;
  const secret = "host-only-native-test-key";
  const authority = new RemoteControlAuthority({
    currentScope: () => pinnedScope,
    authorizeCaller: () => true,
    verifyNativeControlApproval: (challenge: RemoteControlChallenge, proof: unknown) =>
      proof === createHmac("sha256", secret).update(JSON.stringify(challenge)).digest("hex"),
  }, () => now);
  const approve = () => {
    const challenge = authority.request(caller);
    const proof = createHmac("sha256", secret).update(JSON.stringify(challenge)).digest("hex");
    return authority.confirmNativeApproval(challenge.nonce, proof).token;
  };
  const dispatchNative = vi.fn(async (
    _input: Parameters<RemoteNativeSemanticAdapter["dispatchVerifiedNativeRef"]>[0],
    authorizeNow: () => void,
  ) => { authorizeNow(); });
  const adapter: RemoteNativeSemanticAdapter = {
    platform: "win32",
    nativeRefOnly: true,
    dispatchVerifiedNativeRef: dispatchNative,
  };
  const captureFresh = vi.fn(async (_scope: Readonly<RemoteHostScope>): Promise<RemoteNativeVerifiedFrame> =>
    ({
      verifiedInsideCapture: true,
      png: capturedImage,
      schema: current,
      hostScope: { ...pinnedScope },
    }));
  const deps: RemoteNativeInputDependencies = {
    authority, adapter, captureFresh,
    hostPlatform: "win32",
    now: () => now,
    ...overrides,
  };
  return {
    authority, approve, adapter, captureFresh, dispatchNative, deps,
    dispatcher: new RemoteNativeInputDispatcher(deps),
    get now() { return now; }, set now(value: number) { now = value; },
    get current() { return current; }, set current(value: DesktopUiSchema) { current = value; },
    get pinnedScope() { return pinnedScope; }, set pinnedScope(value: RemoteHostScope) { pinnedScope = value; },
    set capturedImage(value: Uint8Array) { capturedImage = value; },
  };
}

describe("Remote nativeRef-only dispatch: host-only and one-shot", () => {
  it.each(["click", "type", "key", "scroll"] as const)(
    "dispatches exactly one approved %s with nativeRef, never coordinates",
    async kind => {
      const f = fixture();
      const token = f.approve();
      expect(await f.dispatcher.dispatch(caller, token, request(kind))).toEqual({ status: "dispatched" });
      expect(f.captureFresh).toHaveBeenCalledTimes(1);
      expect(f.dispatchNative).toHaveBeenCalledTimes(1);
      const [input] = f.dispatchNative.mock.calls[0];
      expect(input.scope).toEqual(scope);
      expect(input.action.nativeRef).toEqual(element.nativeRef);
      expect(input.action.kind).toBe(kind);
      expect(input.screenshotSha256).toEqual(sha256(image));
      expect(input.action).not.toHaveProperty("point");
      expect(input.action).not.toHaveProperty("x");
      expect(await f.dispatcher.dispatch(caller, token, request(kind))).toEqual({
        status: "blocked", reason: "INPUT_DENIED",
      });
    },
  );

  it("does not allow viewing or an unapproved input grant to produce native actions", async () => {
    const f = fixture();
    expect(await f.dispatcher.dispatch(caller, "0".repeat(64), request())).toEqual({
      status: "blocked", reason: "INPUT_DENIED",
    });
    expect(f.dispatchNative).not.toHaveBeenCalled();
    expect(f.captureFresh).not.toHaveBeenCalled();
    expect(await new RemoteNativeInputDispatcher({
      adapter: f.adapter, captureFresh: f.captureFresh, hostPlatform: "win32",
    }).dispatch(caller, "0".repeat(64), request())).toEqual({
      status: "blocked", reason: "NATIVE_APPROVAL_UNAVAILABLE",
    });
  });

  it("blocks a generic coordinate adapter rather than using fallback dispatch", async () => {
    const f = fixture();
    const coordinateDispatch = vi.fn();
    const dispatcher = new RemoteNativeInputDispatcher({
      authority: f.authority, captureFresh: f.captureFresh, hostPlatform: "win32",
      adapter: { platform: "win32", dispatch: coordinateDispatch } as unknown as RemoteNativeSemanticAdapter,
    });
    expect(await dispatcher.dispatch(caller, f.approve(), request())).toEqual({
      status: "blocked", reason: "SEMANTIC_ADAPTER_UNAVAILABLE",
    });
    expect(coordinateDispatch).not.toHaveBeenCalled();
    expect(f.captureFresh).not.toHaveBeenCalled();
  });

  it("refuses wrong OS, unsupported OS, unknown Linux session and Wayland", async () => {
    const f = fixture();
    const token = f.approve();
    const result = (overrides: Partial<RemoteNativeInputDependencies>) =>
      new RemoteNativeInputDispatcher({ ...f.deps, ...overrides })
        .dispatch(caller, token, request());
    expect(await result({ hostPlatform: "freebsd" })).toEqual({
      status: "blocked", reason: "PLATFORM_UNSUPPORTED",
    });
    expect(await result({ hostPlatform: "darwin" })).toEqual({
      status: "blocked", reason: "SEMANTIC_ADAPTER_UNAVAILABLE",
    });
    expect(await result({
      hostPlatform: "linux",
      adapter: { ...f.adapter, platform: "linux", sessionType: "wayland" },
    })).toEqual({ status: "blocked", reason: "WAYLAND_INPUT_UNAVAILABLE" });
    expect(await result({
      hostPlatform: "linux",
      adapter: { ...f.adapter, platform: "linux", sessionType: "unknown" },
    })).toEqual({ status: "blocked", reason: "PLATFORM_UNSUPPORTED" });
    expect(f.dispatchNative).not.toHaveBeenCalled();
  });

  it.each([
    ["darwin", "axpath:/AXWindow/AXTextField", undefined],
    ["linux", "atspipath:/org/a11y/atspi/accessible/12", "x11"],
  ] as const)("supports a host-verified nativeRef-only %s adapter in mock E2E", async (
    platform, nativeRef, sessionType,
  ) => {
    const adapter: RemoteNativeSemanticAdapter = {
      platform, nativeRefOnly: true, sessionType,
      dispatchVerifiedNativeRef: async (input, authorizeNow) => {
        expect(input.scope.platform).toBe(platform);
        expect(input.action.nativeRef).toBe(nativeRef);
        authorizeNow();
      },
    };
    const f = fixture({ hostPlatform: platform, adapter });
    f.pinnedScope = { ...scope, platform };
    const nativeElement = { ...element, nativeRef };
    f.current = {
      ...freshSchema(), platform, elements: [nativeElement],
    };
    const token = f.approve();
    const nativeRequest = {
      ...request(), expectedElementHash: semanticElementHash(nativeElement),
    };
    expect(await f.dispatcher.dispatch(caller, token, nativeRequest))
      .toEqual({ status: "dispatched" });
  });

  it("rejects forged screenshot pixels, native host mismatch, stale time and foreground loss", async () => {
    const f = fixture();
    const token = f.approve();
    f.capturedImage = new Uint8Array([...image, 3]);
    expect(await f.dispatcher.dispatch(caller, token, request())).toEqual({
      status: "blocked", reason: "CAPTURE_UNVERIFIED",
    });
    // A failed capture still burns the sequence, so a request cannot be replayed.
    expect(await f.dispatcher.dispatch(caller, token, request())).toEqual({
      status: "blocked", reason: "INPUT_DENIED",
    });
    const second = fixture();
    const secondToken = second.approve();
    second.pinnedScope = { ...scope, processBirthId: "different-process" };
    expect(await second.dispatcher.dispatch(caller, secondToken, request())).toEqual({
      status: "blocked", reason: "INPUT_DENIED",
    });
    const mismatched = fixture();
    const wrongCapture = async () => ({
      verifiedInsideCapture: true as const, png: image, schema: mismatched.current,
      hostScope: { ...scope, osUserId: "different-local-user" },
    });
    const mismatchDispatcher = new RemoteNativeInputDispatcher({
      ...mismatched.deps, captureFresh: wrongCapture,
    });
    expect(await mismatchDispatcher.dispatch(caller, mismatched.approve(), request())).toEqual({
      status: "blocked", reason: "CAPTURE_UNVERIFIED",
    });
    const stale = fixture();
    stale.current = { ...stale.current, screenshot: {
      ...stale.current.screenshot, capturedAt: new Date(nowBase - 3_000).toISOString(),
    } };
    expect(await stale.dispatcher.dispatch(caller, stale.approve(), request())).toEqual({
      status: "blocked", reason: "CAPTURE_UNVERIFIED",
    });
    const unfocused = fixture();
    unfocused.current = { ...unfocused.current, screenshot: {
      ...unfocused.current.screenshot,
      targetWindow: { ...unfocused.current.screenshot.targetWindow, active: false },
    } };
    expect(await unfocused.dispatcher.dispatch(caller, unfocused.approve(), request())).toEqual({
      status: "blocked", reason: "CAPTURE_UNVERIFIED",
    });
    expect(f.dispatchNative).not.toHaveBeenCalled();
  });

  it("rejects nativeRef scheme mismatch, coordinates, shell and malformed requests", async () => {
    const f = fixture();
    const token = f.approve();
    expect(await f.dispatcher.dispatch(caller, token, { ...request(), x: 200 })).toEqual({
      status: "blocked", reason: "INPUT_DENIED",
    });
    const newFixture = fixture();
    newFixture.current = { ...newFixture.current, elements: [
      { ...element, nativeRef: "uia:guess" },
    ] };
    const modified = { ...request(), expectedElementHash: semanticElementHash(newFixture.current.elements[0]) };
    expect(await newFixture.dispatcher.dispatch(caller, newFixture.approve(), modified)).toEqual({
      status: "blocked", reason: "INPUT_DENIED",
    });
    expect(await new RemoteNativeInputDispatcher(f.deps)
      .dispatch(caller, token, { kind: "shell", command: "whoami" })).toEqual({
      status: "blocked", reason: "INPUT_DENIED",
    });
    expect(f.dispatchNative).not.toHaveBeenCalled();
  });

  it("burns authorization at the final synchronous checkpoint; rejects adapters that skip it", async () => {
    const f = fixture();
    const badAdapter: RemoteNativeSemanticAdapter = {
      platform: "win32", nativeRefOnly: true,
      dispatchVerifiedNativeRef: vi.fn(async () => undefined),
    };
    const dispatcher = new RemoteNativeInputDispatcher({ ...f.deps, adapter: badAdapter });
    const token = f.approve();
    expect(await dispatcher.dispatch(caller, token, request())).toEqual({
      status: "blocked", reason: "NATIVE_DISPATCH_UNVERIFIED",
    });
    expect(await dispatcher.dispatch(caller, token, request("click", 2))).toEqual({
      status: "blocked", reason: "INPUT_DENIED",
    });
  });

  it("revokes if the native adapter throws before the checkpoint, without retry", async () => {
    const f = fixture();
    const failingAdapter: RemoteNativeSemanticAdapter = {
      platform: "win32", nativeRefOnly: true,
      dispatchVerifiedNativeRef: async () => { throw new Error("native resolver failed"); },
    };
    const dispatcher = new RemoteNativeInputDispatcher({ ...f.deps, adapter: failingAdapter });
    const token = f.approve();
    expect(await dispatcher.dispatch(caller, token, request())).toEqual({
      status: "blocked", reason: "NATIVE_DISPATCH_UNVERIFIED",
    });
    expect(await dispatcher.dispatch(caller, token, request("click", 2))).toEqual({
      status: "blocked", reason: "INPUT_DENIED",
    });
  });

  it("treats repeated checkpoints and post-checkpoint native failures as uncertain; revokes", async () => {
    const f = fixture();
    const badAdapter: RemoteNativeSemanticAdapter = {
      platform: "win32", nativeRefOnly: true,
      dispatchVerifiedNativeRef: async (_input, authorize) => { authorize(); authorize(); },
    };
    const dispatcher = new RemoteNativeInputDispatcher({ ...f.deps, adapter: badAdapter });
    const token = f.approve();
    expect(await dispatcher.dispatch(caller, token, request())).toEqual({
      status: "uncertain", reason: "NATIVE_DISPATCH_UNVERIFIED",
    });
    expect(await dispatcher.dispatch(caller, token, request("click", 2))).toEqual({
      status: "blocked", reason: "INPUT_DENIED",
    });
  });

  it("blocks takeover or revocation while capturing without touching native adapter", async () => {
    const f = fixture();
    const captureFresh = vi.fn(async () => {
      f.authority.humanTakeover();
      return { verifiedInsideCapture: true as const, png: image,
        schema: f.current, hostScope: scope };
    });
    const dispatcher = new RemoteNativeInputDispatcher({ ...f.deps, captureFresh });
    const token = f.approve();
    expect(await dispatcher.dispatch(caller, token, request())).toEqual({
      status: "blocked", reason: "INPUT_DENIED",
    });
    expect(f.dispatchNative).not.toHaveBeenCalled();
    expect(await dispatcher.dispatch(caller, token, request("click", 2))).toEqual({
      status: "blocked", reason: "INPUT_DENIED",
    });
  });

  it("returns uncertain if a human takes over after native checkpoint", async () => {
    const f = fixture();
    const adapter: RemoteNativeSemanticAdapter = {
      platform: "win32", nativeRefOnly: true,
      dispatchVerifiedNativeRef: async (_input, authorize) => {
        authorize();
        f.authority.humanTakeover();
      },
    };
    const dispatcher = new RemoteNativeInputDispatcher({ ...f.deps, adapter });
    expect(await dispatcher.dispatch(caller, f.approve(), request())).toEqual({
      status: "uncertain", reason: "NATIVE_DISPATCH_UNVERIFIED",
    });
  });

  it("rejects reentrant native callbacks instead of dispatching twice", async () => {
    const f = fixture();
    const token = f.approve();
    let dispatcher!: RemoteNativeInputDispatcher;
    const adapter: RemoteNativeSemanticAdapter = {
      platform: "win32", nativeRefOnly: true,
      dispatchVerifiedNativeRef: async (_input, authorize) => {
        expect(await dispatcher.dispatch(caller, token, request("click", 2)))
          .toEqual({ status: "blocked", reason: "INPUT_DENIED" });
        authorize();
      },
    };
    dispatcher = new RemoteNativeInputDispatcher({ ...f.deps, adapter });
    expect(await dispatcher.dispatch(caller, token, request())).toEqual({ status: "dispatched" });
  });

  it("expires a lease just before native injection, not after it", async () => {
    const f = fixture();
    const adapter: RemoteNativeSemanticAdapter = {
      platform: "win32", nativeRefOnly: true,
      dispatchVerifiedNativeRef: async (_input, authorizeNow) => {
        f.now += 3_500;
        authorizeNow();
      },
    };
    const dispatcher = new RemoteNativeInputDispatcher({ ...f.deps, adapter });
    expect(await dispatcher.dispatch(caller, f.approve(), request())).toEqual({
      status: "blocked", reason: "NATIVE_DISPATCH_UNVERIFIED",
    });
    expect(f.dispatchNative).not.toHaveBeenCalled();
  });

  it("expires a lease while awaiting fresh capture", async () => {
    const f = fixture();
    const captureFresh = async () => {
      f.now += 3_500;
      return { verifiedInsideCapture: true as const, png: image,
        schema: f.current, hostScope: scope };
    };
    const dispatcher = new RemoteNativeInputDispatcher({ ...f.deps, captureFresh });
    expect(await dispatcher.dispatch(caller, f.approve(), request())).toEqual({
      status: "blocked", reason: "INPUT_DENIED",
    });
    expect(f.dispatchNative).not.toHaveBeenCalled();
  });
});

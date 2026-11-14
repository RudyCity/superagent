/**
 * Host-local composition boundary for Desktop Live semantic input. Deliberately
 * not registered in HTTP/MCP/Delegate routes: a viewer is never a controller.
 *
 * The existing coordinate-based DesktopUiAdapter.dispatch() is NOT compatible.
 * A host-installed nativeRef-only adapter must resolve the exact accessibility
 * object INSIDE the native input boundary, revalidate the pinned process/window,
 * foreground, element hash and human takeover state, and call authorizeNow()
 * synchronously immediately before the OS semantic action. No mouse points,
 * guessed targets, shell/keyboard shortcuts or monitor fallback are permitted.
 */
import { DesktopUiError } from "./errors.js";
import { readPngSize, sha256 } from "./png.js";
import {
  RemoteInputGuard,
  type VerifiedRemoteInput,
} from "./remoteInputGuard.js";
import type {
  RemoteControlAuthority,
  RemoteHostScope,
  RemotePrincipal,
} from "./remoteControlAuthority.js";
import type { DesktopPlatform, DesktopUiSchema } from "./types.js";

const MAX_NATIVE_PNG_BYTES = 32 * 1024 * 1024;

export interface RemoteNativeVerifiedFrame {
  /** Newly captured native PNG bytes (not a cached stream/viewer frame). */
  readonly png: Uint8Array;
  readonly schema: DesktopUiSchema;
  /** Independently reverified by the native host on this capture. */
  readonly hostScope: Readonly<RemoteHostScope>;
  readonly verifiedInsideCapture: true;
}

export interface RemoteNativeSemanticAction {
  readonly scope: Readonly<RemoteHostScope>;
  readonly action: Readonly<VerifiedRemoteInput>;
  readonly screenshotRevision: number;
  readonly screenshotSha256: string;
}

/**
 * Privileged, attended native host implementation ONLY. Not supplied by a
 * remote caller or inferred from DesktopUiAdapter.dispatch (coordinate based).
 * The native adapter must re-resolve a unique nativeRef from fresh OS
 * accessibility inside the exact foreground window and recheck its semantics.
 * Call authorizeNow() synchronously at the final OS injection boundary, with
 * no async gap or fallback between it and the semantic OS action.
 */
export interface RemoteNativeSemanticAdapter {
  readonly platform: DesktopPlatform;
  readonly nativeRefOnly: true;
  /** Linux must be positively identified as X11; Wayland has no input path. */
  readonly sessionType?: "x11" | "wayland" | "unknown";
  dispatchVerifiedNativeRef(
    input: Readonly<RemoteNativeSemanticAction>,
    authorizeNow: () => void,
  ): Promise<void>;
}

export type RemoteNativeInputResult =
  | { readonly status: "dispatched" }
  | { readonly status: "blocked"; readonly reason: RemoteNativeInputBlockReason }
  | { readonly status: "uncertain"; readonly reason: "NATIVE_DISPATCH_UNVERIFIED" };

export type RemoteNativeInputBlockReason =
  | "NATIVE_APPROVAL_UNAVAILABLE"
  | "SEMANTIC_ADAPTER_UNAVAILABLE"
  | "PLATFORM_UNSUPPORTED"
  | "WAYLAND_INPUT_UNAVAILABLE"
  | "INPUT_DENIED"
  | "CAPTURE_UNVERIFIED"
  | "NATIVE_DISPATCH_UNVERIFIED";

export interface RemoteNativeInputDependencies {
  /** Must be constructed exclusively with native attended control approval. */
  readonly authority?: RemoteControlAuthority | null;
  /** Native-host capture: must independently verify exact window and pixels. */
  readonly captureFresh?: (
    scope: Readonly<RemoteHostScope>,
  ) => Promise<RemoteNativeVerifiedFrame | null>;
  /** Do NOT inject the existing coordinate-based DesktopUiAdapter here. */
  readonly adapter?: RemoteNativeSemanticAdapter | null;
  /** Trusted host-local platform, never taken from a request body. */
  readonly hostPlatform?: NodeJS.Platform;
  readonly now?: () => number;
}

function sameScope(a: RemoteHostScope, b: RemoteHostScope): boolean {
  return a.platform === b.platform && a.pid === b.pid &&
    a.nativeId === b.nativeId && a.processBirthId === b.processBirthId &&
    a.osUserId === b.osUserId && a.hostSessionId === b.hostSessionId &&
    a.hostGeneration === b.hostGeneration && a.viewSessionId === b.viewSessionId;
}

const prefixes: Record<DesktopPlatform, readonly string[]> = {
  win32: ["automationId:", "runtimeId:"],
  darwin: ["axpath:"],
  linux: ["atspipath:"],
};

function validNativeRef(platform: DesktopPlatform, nativeRef: string): boolean {
  return prefixes[platform].some(prefix =>
    nativeRef.startsWith(prefix) && nativeRef.length > prefix.length);
}

function assertVerifiedFrame(
  frame: RemoteNativeVerifiedFrame | null,
  scope: RemoteHostScope,
): asserts frame is RemoteNativeVerifiedFrame {
  if (!frame || frame.verifiedInsideCapture !== true ||
      !frame.hostScope || !sameScope(frame.hostScope, scope) ||
      !frame.schema || frame.schema.platform !== scope.platform ||
      !(frame.png instanceof Uint8Array) || frame.png.byteLength < 24 ||
      frame.png.byteLength > MAX_NATIVE_PNG_BYTES) {
    throw new DesktopUiError("STALE_SCREENSHOT", "Native host capture identity is unavailable.");
  }
  const { width, height } = readPngSize(frame.png);
  if (frame.schema.screenshot.width !== width ||
      frame.schema.screenshot.height !== height ||
      frame.schema.screenshot.sha256 !== sha256(frame.png)) {
    throw new DesktopUiError("STALE_SCREENSHOT", "Native capture pixels or dimensions do not match.");
  }
}

function blocked(reason: RemoteNativeInputBlockReason): RemoteNativeInputResult {
  return { status: "blocked", reason };
}

/**
 * One dispatcher per trusted host session. Never registers a network endpoint.
 * An approved authority issues an independent, single-use action lease; the
 * dispatch checkpoint consumes it only when the native adapter is ready.
 */
export class RemoteNativeInputDispatcher {
  private inProgress = false;

  constructor(private readonly deps: Readonly<RemoteNativeInputDependencies>) {}

  async dispatch(
    caller: RemotePrincipal,
    token: unknown,
    request: unknown,
  ): Promise<RemoteNativeInputResult> {
    // Reject reentrant callbacks synchronously before they can begin a lease.
    if (this.inProgress) return blocked("INPUT_DENIED");
    this.inProgress = true;
    try {
      const { authority, captureFresh, adapter } = this.deps;
      if (!authority || !captureFresh) return blocked("NATIVE_APPROVAL_UNAVAILABLE");
      const hostPlatform = this.deps.hostPlatform ?? process.platform;
      if (hostPlatform !== "win32" && hostPlatform !== "darwin" && hostPlatform !== "linux") {
        return blocked("PLATFORM_UNSUPPORTED");
      }
      if (!adapter || adapter.nativeRefOnly !== true || adapter.platform !== hostPlatform ||
          typeof adapter.dispatchVerifiedNativeRef !== "function") {
        return blocked("SEMANTIC_ADAPTER_UNAVAILABLE");
      }
      if (hostPlatform === "linux") {
        if (adapter.sessionType === "wayland") return blocked("WAYLAND_INPUT_UNAVAILABLE");
        if (adapter.sessionType !== "x11") return blocked("PLATFORM_UNSUPPORTED");
      }

      let pinnedScope: Readonly<RemoteHostScope> | null = null;
      let verifiedFrame: RemoteNativeVerifiedFrame | null = null;
      const guard = new RemoteInputGuard(
        authority,
        async scope => {
          if (scope.platform !== hostPlatform) {
            throw new DesktopUiError("PLATFORM_UNSUPPORTED", "Native host platform differs from approval.");
          }
          const frame = await captureFresh(scope);
          assertVerifiedFrame(frame, scope);
          pinnedScope = Object.freeze({ ...scope });
          verifiedFrame = frame;
          return frame.schema;
        },
        this.deps.now,
      );

      // prepare() creates and burns the sequence-bound authority action lease.
      // On failure it finishes the lease without dispatching.
      let permit: Awaited<ReturnType<RemoteInputGuard["prepare"]>> | null = null;
      let crossedNativeBoundary = false;
      let nativeAdapterEntered = false;
      try {
        permit = await guard.prepare(caller, token, request);
        if (!pinnedScope || !verifiedFrame) {
          throw new DesktopUiError("STALE_SCREENSHOT", "No native capture verification.");
        }
        const scope = pinnedScope as RemoteHostScope;
        const frame = verifiedFrame as RemoteNativeVerifiedFrame;
        if (!validNativeRef(scope.platform, permit.action.nativeRef)) {
          throw new DesktopUiError("ELEMENT_NOT_ACTIONABLE", "Unsupported native accessibility reference.");
        }
        const input: RemoteNativeSemanticAction = Object.freeze({
          scope,
          action: permit.action,
          screenshotRevision: frame.schema.screenshot.revision,
          screenshotSha256: frame.schema.screenshot.sha256,
        });
        const currentPermit = permit;
        let checkpointCalls = 0;
        const authorizeNow = () => {
          // This is synchronous and may be invoked only at the native boundary.
          if (checkpointCalls++ !== 0) {
            throw new DesktopUiError("INPUT_DISABLED", "Native dispatch checkpoint was replayed.");
          }
          currentPermit.assertLive();
          currentPermit.consumeForNativeDispatch();
          crossedNativeBoundary = true;
        };
        nativeAdapterEntered = true;
        await adapter.dispatchVerifiedNativeRef(input, authorizeNow);
        if (!crossedNativeBoundary || checkpointCalls !== 1) {
          throw new DesktopUiError("DISPATCH_UNVERIFIED", "Native adapter skipped its one-shot checkpoint.");
        }
        permit.assertLive();
        return { status: "dispatched" };
      } catch (error) {
        // A checkpoint may have preceded an uncertain OS action. Revoke the
        // entire control grant; neither the sequence nor input is retried.
        if (crossedNativeBoundary) {
          authority.revoke();
          return { status: "uncertain", reason: "NATIVE_DISPATCH_UNVERIFIED" };
        }
        if (nativeAdapterEntered) {
          authority.revoke();
          return blocked("NATIVE_DISPATCH_UNVERIFIED");
        }
        if (error instanceof DesktopUiError && error.code === "PLATFORM_UNSUPPORTED") {
          return blocked("PLATFORM_UNSUPPORTED");
        }
        if (error instanceof DesktopUiError &&
            (error.code === "STALE_SCREENSHOT" || error.code === "SCREENSHOT_UNAVAILABLE")) {
          return blocked("CAPTURE_UNVERIFIED");
        }
        if (error instanceof DesktopUiError &&
            error.code === "ELEMENT_NOT_ACTIONABLE") {
          return blocked("INPUT_DENIED");
        }
        if (error instanceof DesktopUiError &&
            error.code === "DISPATCH_UNVERIFIED") {
          authority.revoke();
          return blocked("NATIVE_DISPATCH_UNVERIFIED");
        }
        // An untrusted callback may fail at any point. No optimistic success.
        return blocked("INPUT_DENIED");
      } finally {
        permit?.finish();
      }
    } finally {
      this.inProgress = false;
    }
  }
}

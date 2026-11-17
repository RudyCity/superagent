/**
 * Trusted host-only composition for independently approved native mouse and
 * keyboard control. This does NOT install a listener or expose a WebView,
 * HTTP, MCP, browser, tunnel or LAN command endpoint.
 *
 * An attended native host must supply independent verified viewer identity,
 * signed physical approvals, a fresh per-action capture and nativeRef-only
 * semantic OS adapter. Viewing alone is never permission to inject input.
 */
import {
  RemoteControlAuthority,
  type RemoteControlChallenge,
  type RemoteControlHostTrust,
  type RemotePrincipal,
} from "./remoteControlAuthority.js";
import {
  RemoteNativeInputDispatcher,
  type RemoteNativeInputDependencies,
  type RemoteNativeInputResult,
} from "./remoteNativeInputDispatch.js";

export interface AttendedNativeControllerDependencies {
  readonly hostTrust: RemoteControlHostTrust;
  readonly captureFresh: NonNullable<RemoteNativeInputDependencies["captureFresh"]>;
  readonly adapter: NonNullable<RemoteNativeInputDependencies["adapter"]>;
  /** The local OS only; never derived from the remotely submitted request. */
  readonly hostPlatform: NodeJS.Platform;
  readonly viewer: {
    /** Terminates independent private viewer authentication and capture. */
    humanTakeover(): void;
  };
  readonly now?: () => number;
}

export type NativeInputFamily = "mouse" | "keyboard";
interface ScopedController {
  readonly authority: RemoteControlAuthority;
  readonly dispatcher: RemoteNativeInputDispatcher;
  pendingNonce: string | null;
}

function samePrincipal(a: RemotePrincipal, b: RemotePrincipal): boolean {
  return a.principalId === b.principalId &&
    a.connectionId === b.connectionId &&
    a.viewSessionId === b.viewSessionId;
}
function validPrincipal(p: RemotePrincipal): boolean {
  return !!p && [p.principalId,p.connectionId,p.viewSessionId].every(x =>
    typeof x === "string" && x.length > 0 && x.length <= 128 &&
    x.trim() === x && !/[\u0000-\u001f\u007f]/.test(x));
}

/**
 * One verified controller principal per host window, two independent
 * native-signed scopes. A mouse token can never authorize keyboard input.
 * Even with both grants, only one native action may run at a time.
 *
 * Construct exactly once inside the trusted installed host session. A new
 * object and fresh physical approval are needed after terminal takeover.
 */
export class AttendedNativeControllerSession {
  private readonly scopes: Record<NativeInputFamily, ScopedController>;
  private owner: RemotePrincipal | null = null;
  private closed = false;
  private inputBusy = false;

  constructor(private readonly deps: Readonly<AttendedNativeControllerDependencies>) {
    if (!deps || !deps.hostTrust ||
        typeof deps.hostTrust.currentScope !== "function" ||
        typeof deps.hostTrust.authorizeCaller !== "function" ||
        typeof deps.hostTrust.verifyNativeControlApproval !== "function" ||
        typeof deps.captureFresh !== "function" ||
        !deps.adapter || deps.adapter.nativeRefOnly !== true ||
        typeof deps.adapter.dispatchVerifiedNativeRef !== "function" ||
        !["win32","darwin","linux"].includes(deps.hostPlatform) ||
        typeof deps.viewer?.humanTakeover !== "function") {
      throw Error("ATTENDED_NATIVE_CONTROLLER_UNAVAILABLE");
    }
    const build = (): ScopedController => {
      const authority = new RemoteControlAuthority(deps.hostTrust, deps.now);
      return {
        authority,
        dispatcher: new RemoteNativeInputDispatcher({
          authority, captureFresh: deps.captureFresh, adapter: deps.adapter,
          hostPlatform: deps.hostPlatform, now: deps.now,
        }),
        pendingNonce: null,
      };
    };
    this.scopes = {mouse:build(),keyboard:build()};
  }

  /** Independently signed approval; never silently approve another family. */
  requestScope(caller: RemotePrincipal, family: NativeInputFamily): RemoteControlChallenge {
    this.assertOpen();
    const scope = this.requireFamily(family);
    if (!validPrincipal(caller) || (this.owner && !samePrincipal(this.owner, caller)))
      throw Error("ATTENDED_NATIVE_CONTROLLER_OWNER_MISMATCH");
    const challenge = scope.authority.requestScoped(caller, family);
    if (this.closed) {
      scope.authority.humanTakeover();
      throw Error("ATTENDED_NATIVE_CONTROLLER_CLOSED");
    }
    if (!this.owner) this.owner = {...caller};
    scope.pendingNonce = challenge.nonce;
    return challenge;
  }

  /** Only an attended native host can supply the signed challenge proof.
   * Wrong nonces burn all pending approval challenges, not the other grant.
   */
  confirmScope(nonce: unknown, proof: unknown): {token: string; expiresAt: number} {
    this.assertOpen();
    const family: NativeInputFamily | null =
      nonce === this.scopes.mouse.pendingNonce ? "mouse" :
      nonce === this.scopes.keyboard.pendingNonce ? "keyboard" : null;
    if (!family || typeof nonce !== "string") {
      this.scopes.mouse.pendingNonce = null;
      this.scopes.keyboard.pendingNonce = null;
      // Fail closed for both pending approvals; previously granted scopes are
      // revoked too, so an ambiguous replay never changes ownership.
      this.revokeController();
      throw Error("ATTENDED_NATIVE_CONTROLLER_INVALID_APPROVAL");
    }
    const scope = this.scopes[family];
    scope.pendingNonce = null;
    const grant = scope.authority.confirmNativeApproval(nonce, proof);
    if (this.closed) {
      scope.authority.humanTakeover();
      throw Error("ATTENDED_NATIVE_CONTROLLER_CLOSED");
    }
    return grant;
  }

  /** The request format is still checked by RemoteInputGuard. This early
   * routing only chooses the matching independent authority and prevents a
   * concurrent mouse/keyboard native dispatch from interleaving.
   */
  async input(
    caller: RemotePrincipal, token: unknown, request: unknown,
  ): Promise<RemoteNativeInputResult> {
    if (this.closed || this.inputBusy || !this.owner ||
        !validPrincipal(caller) || !samePrincipal(this.owner,caller) ||
        !request || typeof request !== "object" || Array.isArray(request))
      return {status:"blocked",reason:"INPUT_DENIED"};
    const kind = (request as {kind?:unknown}).kind;
    const family = kind === "click" || kind === "scroll" ? "mouse" :
      kind === "type" || kind === "key" ? "keyboard" : null;
    if (!family) return {status:"blocked",reason:"INPUT_DENIED"};
    this.inputBusy = true;
    try { return await this.scopes[family].dispatcher.dispatch(caller,token,request); }
    finally { this.inputBusy = false; }
  }

  /** A different connection cannot revoke the actual controller. */
  controllerDisconnected(connectionId: string): void {
    if (this.closed || this.owner?.connectionId !== connectionId) return;
    this.revokeController();
  }

  /** Allow an operator to revoke just mouse or keyboard while keeping the
   * other approved family and the private view active.
   */
  revokeScope(family: NativeInputFamily): void {
    if (this.closed) return;
    const scope = this.requireFamily(family);
    scope.pendingNonce = null;
    scope.authority.revoke();
  }

  /** Revoke both input families without tearing down a view-only stream. */
  revokeController(): void {
    if (this.closed) return;
    for (const scope of Object.values(this.scopes)) {
      scope.pendingNonce = null;
      scope.authority.revoke();
    }
    this.owner = null;
  }

  viewerDisconnected(): void { this.terminate(); }
  identityChanged(): void { this.terminate(); }
  hostRestarted(): void { this.terminate(); }
  humanTakeover(): void { this.terminate(); }
  get isClosed(): boolean { return this.closed; }

  private requireFamily(family: NativeInputFamily): ScopedController {
    if (family !== "mouse" && family !== "keyboard")
      throw Error("ATTENDED_NATIVE_CONTROLLER_INVALID_SCOPE");
    return this.scopes[family];
  }
  private assertOpen(): void {
    if (this.closed) throw Error("ATTENDED_NATIVE_CONTROLLER_CLOSED");
  }
  private terminate(): void {
    if (this.closed) return;
    this.closed = true;
    this.owner = null;
    for (const scope of Object.values(this.scopes)) {
      scope.pendingNonce = null;
      scope.authority.humanTakeover();
    }
    try { this.deps.viewer.humanTakeover(); }
    catch { /* Native authorization was already terminally revoked. */ }
  }
}

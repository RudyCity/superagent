/**
 * Trusted native-host composition for private Desktop Live semantic control.
 *
 * This module deliberately creates NO listener, HTTP/MCP/Tauri WebView route,
 * certificate or approval UI. Construct only inside an attended, installed
 * native host that supplies an independently verified exact OS window,
 * authenticated viewer principal, signed physical approval, fresh capture,
 * and nativeRef-only OS adapter. A preview bearer is never an input token.
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
  /** Must derive from local process.platform, never from remote input. */
  readonly hostPlatform: NodeJS.Platform;
  readonly viewer: {
    /** Terminates the independently authenticated private viewer and capture. */
    humanTakeover(): void;
  };
  readonly now?: () => number;
}

/**
 * Exactly one host-side session; new physical approval after every disconnect.
 * The controller can be returned to the local user, never auto-reconnected
 * through stale mTLS or preview tokens.
 */
export class AttendedNativeControllerSession {
  private readonly authority: RemoteControlAuthority;
  private readonly dispatcher: RemoteNativeInputDispatcher;
  private closed = false;

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
    this.authority = new RemoteControlAuthority(deps.hostTrust, deps.now);
    this.dispatcher = new RemoteNativeInputDispatcher({
      authority: this.authority,
      captureFresh: deps.captureFresh,
      adapter: deps.adapter,
      hostPlatform: deps.hostPlatform,
      now: deps.now,
    });
  }

  /** Only an independently verified OS-native host approval can sign this. */
  requestScope(caller: RemotePrincipal, kind: "mouse" | "keyboard"): RemoteControlChallenge {
    this.assertOpen();
    return this.authority.requestScoped(caller, kind);
  }

  /** The proof must be native-host-signed and scoped to the exact challenge. */
  confirmScope(nonce: unknown, proof: unknown): {token: string; expiresAt: number} {
    this.assertOpen();
    return this.authority.confirmNativeApproval(nonce, proof);
  }

  async input(caller: RemotePrincipal, token: unknown, request: unknown): Promise<RemoteNativeInputResult> {
    if (this.closed) return {status:"blocked",reason:"INPUT_DENIED"};
    return this.dispatcher.dispatch(caller, token, request);
  }

  /** Remote controller disconnect does not silently destroy a view-only stream. */
  controllerDisconnected(connectionId: string): void {
    if (!this.closed) this.authority.disconnect(connectionId);
  }

  /** Local operator may revoke input independently of view. */
  revokeController(): void {
    if (!this.closed) this.authority.revoke();
  }

  /** A transport disconnect always closes the exact remote viewer as well. */
  viewerDisconnected(): void { this.terminate(); }

  /** Host identity drift is terminal; never reuse a stale PID/window. */
  identityChanged(): void { this.terminate(); }

  /** Host restart and emergency physical human takeover both terminate input
   * before viewer, with no asynchronous gap or automatic return-to-agent.
   */
  hostRestarted(): void { this.terminate(); }
  humanTakeover(): void { this.terminate(); }

  get isClosed(): boolean { return this.closed; }

  private assertOpen(): void {
    if (this.closed) throw Error("ATTENDED_NATIVE_CONTROLLER_CLOSED");
  }

  private terminate(): void {
    if (this.closed) return;
    this.closed = true;
    this.authority.humanTakeover();
    try { this.deps.viewer.humanTakeover(); }
    catch { /* Input already latched off; viewer transport must fail closed. */ }
  }
}

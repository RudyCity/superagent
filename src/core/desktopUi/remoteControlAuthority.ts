/**
 * Host-first, in-memory Desktop Live remote-control authority.
 *
 * No network route, native input, process discovery, or viewer-to-controller
 * promotion lives here. The integrator MUST supply a trusted, host-only native
 * approval verifier and independently authenticated/RBAC-checked principals.
 * The existing preview approval is NOT a remote-input approval.
 * A trusted integration MUST own exactly one authority per host session. This
 * module intentionally does not install any network, input or global process
 * hooks and is NOT sufficient to activate remote control by itself.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { DesktopUiError } from "./errors.js";
import type { DesktopPlatform } from "./types.js";

export const REMOTE_CONTROL_TTL_MS = 5 * 60_000;
export const REMOTE_CONTROL_CHALLENGE_TTL_MS = 30_000;
export const REMOTE_ACTION_LEASE_TTL_MS = 3_000;

export type RemoteInputKind = "click" | "type" | "key" | "scroll";
export type RemoteControlOperation = "request" | RemoteInputKind;

export interface RemoteHostScope {
  /** Exactly the window the native host selected for the existing viewer. */
  platform: DesktopPlatform;
  pid: number;
  nativeId: string;
  processBirthId: string;
  osUserId: string;
  hostSessionId: string;
  hostGeneration: number;
  viewSessionId: string;
}

export interface RemotePrincipal {
  /** Values MUST come from verified transport identity, never a JSON body. */
  principalId: string;
  connectionId: string;
  viewSessionId: string;
}

export interface RemoteControlChallenge {
  nonce: string;
  issuedAt: number;
  expiresAt: number;
  scope: Readonly<RemoteHostScope>;
  controller: Readonly<RemotePrincipal>;
  kinds: readonly RemoteInputKind[];
}

export interface RemoteControlHostTrust {
  /** Host-owned authoritative pinned viewer/window identity, not a remote PID. */
  currentScope(): RemoteHostScope | null;
  /** Independently validate caller identity, view membership and RBAC every time. */
  authorizeCaller(caller: Readonly<RemotePrincipal>, operation: RemoteControlOperation): boolean;
  /**
   * Verify a NEW native, attended, single-use approval cryptographically bound
   * to ALL challenge fields, including OS user/generation/controller/kinds.
   * Must reject viewer consent, caller-provided booleans, and preview proofs.
   * This callback and its signing key MUST NOT be exposed to network clients.
   */
  verifyNativeControlApproval(challenge: Readonly<RemoteControlChallenge>, proof: unknown): boolean;
}

export interface RemoteActionLease {
  readonly scope: Readonly<RemoteHostScope>;
  readonly signal: AbortSignal;
  /** Recheck identity, RBAC, TTL, takeover and scope after every async boundary. */
  assertLive(): void;
  /** Single use. Call synchronously at the trusted native injection boundary. */
  consumeForNativeDispatch(): void;
  /** Release in a finally block even after partial/uncertain dispatch. */
  finish(): void;
}

interface ActiveControl {
  token: string;
  controller: RemotePrincipal;
  scope: RemoteHostScope;
  expiresAt: number;
  epoch: number;
  lastSequence: number;
}

interface PendingAction {
  abort: AbortController;
  epoch: number;
  expiresAt: number;
}

function disabled(message: string): never {
  throw new DesktopUiError("INPUT_DISABLED", message);
}

function validId(value: unknown, max = 128): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max &&
    value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}

function validatePrincipal(value: RemotePrincipal): RemotePrincipal {
  if (!value || !validId(value.principalId) || !validId(value.connectionId) ||
      !validId(value.viewSessionId)) disabled("Authenticated controller identity is missing.");
  return { principalId: value.principalId, connectionId: value.connectionId,
    viewSessionId: value.viewSessionId };
}

function validateHostScope(raw: RemoteHostScope | null): RemoteHostScope {
  if (!raw || !["win32", "darwin", "linux"].includes(raw.platform) ||
      !Number.isSafeInteger(raw.pid) || raw.pid <= 0 ||
      !Number.isSafeInteger(raw.hostGeneration) || raw.hostGeneration < 1 ||
      !validId(raw.nativeId, 256) || !validId(raw.processBirthId) ||
      !validId(raw.osUserId) || !validId(raw.hostSessionId) ||
      !validId(raw.viewSessionId)) {
    disabled("The local host has no independently verified pinned viewer/window.");
  }
  return { platform: raw.platform, pid: raw.pid, nativeId: raw.nativeId,
    processBirthId: raw.processBirthId, osUserId: raw.osUserId,
    hostSessionId: raw.hostSessionId, hostGeneration: raw.hostGeneration,
    viewSessionId: raw.viewSessionId };
}

function samePrincipal(a: RemotePrincipal, b: RemotePrincipal): boolean {
  return a.principalId === b.principalId &&
    a.connectionId === b.connectionId && a.viewSessionId === b.viewSessionId;
}

function sameScope(a: RemoteHostScope, b: RemoteHostScope): boolean {
  return a.platform === b.platform && a.pid === b.pid &&
    a.nativeId === b.nativeId && a.processBirthId === b.processBirthId &&
    a.osUserId === b.osUserId && a.hostSessionId === b.hostSessionId &&
    a.hostGeneration === b.hostGeneration && a.viewSessionId === b.viewSessionId;
}

function sameToken(expected: string, presented: unknown): boolean {
  return typeof presented === "string" && /^[a-f0-9]{64}$/.test(presented) &&
    timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(presented, "hex"));
}

const kinds: readonly RemoteInputKind[] = Object.freeze(["click", "type", "key", "scroll"]);

export class RemoteControlAuthority {
  private pending: RemoteControlChallenge | null = null;
  private active: ActiveControl | null = null;
  private inFlight: PendingAction | null = null;
  private epoch = 0;
  private takeoverLatched = false;
  private lastObservedClock: number | null = null;

  constructor(
    private readonly host: RemoteControlHostTrust,
    private readonly now: () => number = Date.now,
  ) {}

  /** Never extend consent because a wall clock moved backwards or became invalid. */
  private readClock(): number {
    const current = this.now();
    if (!Number.isSafeInteger(current) || current < 0 ||
        current > Number.MAX_SAFE_INTEGER - REMOTE_CONTROL_TTL_MS - REMOTE_CONTROL_CHALLENGE_TTL_MS ||
        (this.lastObservedClock !== null && current < this.lastObservedClock)) {
      this.revoke();
      disabled("Host clock is invalid or regressed; remote control was revoked.");
    }
    this.lastObservedClock = current;
    return current;
  }

  /** Viewing never grants input; this only creates a 30-second native challenge. */
  request(caller: RemotePrincipal): RemoteControlChallenge {
    if (this.takeoverLatched) disabled("Local human takeover has disabled remote control.");
    if (this.pending && this.readClock() >= this.pending.expiresAt) this.pending = null;
    if (this.active && this.readClock() >= this.active.expiresAt) this.revoke();
    if (this.active || this.pending) disabled("A controller or approval challenge already exists.");
    const controller = validatePrincipal(caller);
    const scope = validateHostScope(this.host.currentScope());
    const requestEpoch = this.epoch;
    if (controller.viewSessionId !== scope.viewSessionId ||
        this.host.authorizeCaller(controller, "request") !== true ||
        this.takeoverLatched || requestEpoch !== this.epoch ||
        !sameScope(scope, validateHostScope(this.host.currentScope()))) {
      disabled("Remote controller is not authorized for the pinned viewer.");
    }
    const issuedAt = this.readClock();
    const challenge: RemoteControlChallenge = {
      nonce: randomBytes(32).toString("hex"),
      issuedAt,
      expiresAt: issuedAt + REMOTE_CONTROL_CHALLENGE_TTL_MS,
      scope: Object.freeze(scope),
      controller: Object.freeze(controller),
      kinds,
    };
    this.pending = Object.freeze(challenge);
    return challenge;
  }

  /** Only the native host UI may supply the separate signed human proof. */
  confirmNativeApproval(nonce: unknown, proof: unknown): { token: string; expiresAt: number } {
    const challenge = this.pending;
    const approvalEpoch = this.epoch;
    this.pending = null; // Burn on every attempt, including forged/replayed proof.
    if (this.takeoverLatched || !challenge || nonce !== challenge.nonce ||
        this.readClock() >= challenge.expiresAt || this.active) {
      disabled("Native control approval is missing, expired or replayed.");
    }
    const current = validateHostScope(this.host.currentScope());
    if (!sameScope(challenge.scope, current) ||
        this.host.authorizeCaller(challenge.controller, "request") !== true ||
        this.host.verifyNativeControlApproval(challenge, proof) !== true) {
      disabled("Native control approval does not match host/controller scope.");
    }
    const approvedAt = this.readClock();
    if (approvedAt >= challenge.expiresAt || approvalEpoch !== this.epoch ||
        this.takeoverLatched ||
        !sameScope(challenge.scope, validateHostScope(this.host.currentScope())) ||
        this.host.authorizeCaller(challenge.controller, "request") !== true ||
        approvalEpoch !== this.epoch || this.takeoverLatched) {
      disabled("Native approval expired or host/controller changed during verification.");
    }
    const expiresAt = approvedAt + REMOTE_CONTROL_TTL_MS;
    this.active = { token: randomBytes(32).toString("hex"),
      scope: { ...challenge.scope }, controller: { ...challenge.controller },
      expiresAt, epoch: ++this.epoch, lastSequence: 0 };
    return { token: this.active.token, expiresAt };
  }

  /** One controller and one outstanding action, with strict non-replay sequence. */
  beginAction(
    caller: RemotePrincipal, token: unknown, kind: RemoteInputKind, sequence: number,
  ): RemoteActionLease {
    if (!kinds.includes(kind)) disabled("Unsupported remote input operation.");
    const active = this.requireActive(caller, token, kind);
    if (this.inFlight && this.readClock() >= this.inFlight.expiresAt) {
      this.inFlight.abort.abort();
      this.inFlight = null;
    }
    if (this.inFlight) disabled("Another remote input is still in progress.");
    if (!Number.isSafeInteger(sequence) || sequence !== active.lastSequence + 1 ||
        sequence > 4096) {
      throw new DesktopUiError("INVALID_ACTION", "Remote input sequence is invalid or replayed.");
    }
    const expiresAt = Math.min(active.expiresAt, this.readClock() + REMOTE_ACTION_LEASE_TTL_MS);
    const entry: PendingAction = { abort: new AbortController(), epoch: active.epoch, expiresAt };
    this.inFlight = entry;
    active.lastSequence = sequence; // Never retry after uncertain native dispatch.
    let consumed = false;
    const assertLive = () => {
      if (this.inFlight !== entry || entry.abort.signal.aborted ||
          this.readClock() >= entry.expiresAt) {
        disabled("Remote action expired, completed or was interrupted.");
      }
      const verified = this.requireActive(caller, token, kind);
      if (verified.epoch !== entry.epoch) disabled("Remote control generation changed.");
    };
    return {
      scope: Object.freeze({ ...active.scope }),
      signal: entry.abort.signal,
      assertLive,
      consumeForNativeDispatch: () => {
        assertLive();
        if (consumed) disabled("Remote input authorization is single use.");
        consumed = true;
      },
      finish: () => {
        if (this.inFlight === entry) this.inFlight = null;
        entry.abort.abort();
      },
    };
  }

  private requireActive(caller: RemotePrincipal, token: unknown, kind: RemoteControlOperation): ActiveControl {
    if (this.takeoverLatched || !this.active ||
        !sameToken(this.active.token, token)) disabled("Remote control is not approved.");
    const controller = validatePrincipal(caller);
    if (!samePrincipal(this.active.controller, controller)) {
      disabled("The approval belongs to a different authenticated controller.");
    }
    if (this.readClock() >= this.active.expiresAt) {
      this.revoke();
      disabled("Remote control expired; new native approval is required.");
    }
    let current: RemoteHostScope;
    try { current = validateHostScope(this.host.currentScope()); }
    catch { this.revoke(); disabled("Host identity is no longer verifiable."); }
    if (!sameScope(this.active.scope, current)) {
      this.revoke();
      disabled("Host/window/OS-user/session identity changed.");
    }
    const originalEpoch = this.active.epoch;
    let permitted = false;
    try { permitted = this.host.authorizeCaller(controller, kind) === true; }
    catch { permitted = false; }
    if (!permitted || this.takeoverLatched || !this.active ||
        this.active.epoch !== originalEpoch) {
      this.revoke();
      disabled("Remote controller RBAC, approval or connection was revoked.");
    }
    return this.active;
  }

  /** Event handlers must be wired directly to trusted host lifecycle. */
  disconnect(connectionId: string): void {
    if (this.active?.controller.connectionId === connectionId ||
        this.pending?.controller.connectionId === connectionId) this.revoke();
  }
  viewerDisconnected(viewSessionId: string): void {
    if (this.active?.scope.viewSessionId === viewSessionId ||
        this.pending?.scope.viewSessionId === viewSessionId) this.revoke();
  }
  hostRestarted(): void { this.revoke(); }
  identityChanged(): void { this.revoke(); }
  humanTakeover(): void {
    this.takeoverLatched = true;
    this.revoke();
  }
  /** Only construction of a new authority from the attended host can reset takeover. */
  revoke(): void {
    this.inFlight?.abort.abort();
    this.inFlight = null;
    this.pending = null;
    this.active = null;
    this.epoch++;
  }
}

/**
 * Remote Desktop Live authorization policy — transport-independent and OFF
 * until a trusted native host and a separately authenticated viewer are wired.
 *
 * Not a listener, bearer HTTP endpoint, native capture source, or consent UI.
 * The integration MUST derive TransportEvidence from its authenticated TLS
 * connection, NEVER from untrusted JSON, Origin/Forwarded headers, or a tunnel.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const REMOTE_HOST_CHALLENGE_TTL_MS = 30_000;
export const REMOTE_VIEWER_CHALLENGE_TTL_MS = 30_000;
export const REMOTE_SESSION_TTL_MS = 120_000;

export type RemoteLiveDenialCode =
  | "INVALID_REQUEST" | "CONSENT_REQUIRED" | "VIEWER_PROOF_REQUIRED"
  | "TRANSPORT_DENIED" | "SESSION_DENIED" | "BUSY";

export class RemoteLiveDenied extends Error {
  constructor(readonly code: RemoteLiveDenialCode) {
    super("Remote desktop live access denied."); // No secret or screenshot in errors.
    this.name = "RemoteLiveDenied";
  }
}

export interface RemoteWindowPin {
  pid: number;
  nativeId: string;
  title: string;
  application: string;
  bounds: { x: number; y: number; width: number; height: number };
}

export interface RemoteHostIntent {
  hostId: string;
  viewerId: string;
  expectedOrigin: string;
  window: RemoteWindowPin;
}

/** Only a PRIVATE native IPC may request or complete this host challenge. */
export interface RemoteHostApprovalEvidence extends RemoteHostIntent {
  nonce: string;
  proof: string;
}

/**
 * The caller must establish these facts from the transport's trusted server
 * context (TLS engine, private ingress router and verified peer identity).
 * Do not fill these from request-supplied JSON or X-Forwarded-* headers.
 */
export interface RemoteTransportEvidence {
  connectionId: string;
  authenticatedViewerId: string;
  origin: string;
  tlsVerified: boolean;
  privateIngressVerified: boolean;
  /** Reject every public reverse proxy, named tunnel, or quick tunnel. */
  publicTunnelDetected: boolean;
  forwardedHeadersPresent: boolean;
}

export interface RemoteViewerProofEvidence {
  sessionId: string;
  nonce: string;
  viewerId: string;
  hostId: string;
  expectedOrigin: string;
  connectionId: string;
  proof: string;
}

export interface RemoteLiveVerifiers {
  /** Verify fresh native-attended approval covering ALL fields and nonce. */
  verifyHostApproval(evidence: RemoteHostApprovalEvidence): Promise<boolean>;
  /** Verify distinct viewer-side proof of the nonce and connection binding. */
  verifyViewerProof(evidence: RemoteViewerProofEvidence): Promise<boolean>;
}

interface PendingHost {
  intent: RemoteHostIntent;
  nonce: string;
  expiresAt: number;
}

interface Session {
  id: string;
  hostId: string;
  viewerId: string;
  origin: string;
  window: RemoteWindowPin;
  hostTokenDigest: Buffer;
  viewerNonce: string;
  viewerChallengeExpiresAt: number;
  viewerChallengeUsed: boolean;
  expiresAt: number;
  viewer?: {
    connectionId: string;
    csrfDigest: Buffer;
  };
}

function denied(code: RemoteLiveDenialCode): never {
  throw new RemoteLiveDenied(code);
}
function randomSecret(): string {
  return randomBytes(32).toString("hex");
}
function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}
function isSecret(raw: unknown): raw is string {
  return typeof raw === "string" && /^[a-f0-9]{64}$/.test(raw);
}
function sameSecret(raw: unknown, expected: Buffer): boolean {
  return isSecret(raw) && timingSafeEqual(digest(raw), expected);
}
function id(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{7,127}$/.test(value);
}
function exactOrigin(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 256) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value &&
      !url.username && !url.password && url.hostname !== "localhost" &&
      url.hostname !== "127.0.0.1" && url.hostname !== "[::1]";
  } catch { return false; }
}
function exactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every(key => Object.hasOwn(value, key));
}
function pin(raw: unknown): RemoteWindowPin {
  if (!exactKeys(raw, ["pid", "nativeId", "title", "application", "bounds"]) ||
      !Number.isSafeInteger(raw.pid) || Number(raw.pid) <= 0 ||
      typeof raw.nativeId !== "string" || !raw.nativeId || raw.nativeId.length > 256 ||
      typeof raw.title !== "string" || !raw.title || raw.title.length > 512 ||
      typeof raw.application !== "string" || !raw.application || raw.application.length > 256 ||
      !exactKeys(raw.bounds, ["x", "y", "width", "height"])) {
    denied("INVALID_REQUEST");
  }
  const b = raw.bounds;
  if (![b.x, b.y, b.width, b.height].every(Number.isSafeInteger) ||
      Number(b.width) < 1 || Number(b.height) < 1 ||
      Number(b.width) > 8192 || Number(b.height) > 8192) denied("INVALID_REQUEST");
  return {
    pid: Number(raw.pid), nativeId: raw.nativeId, title: raw.title,
    application: raw.application,
    bounds: { x: Number(b.x), y: Number(b.y), width: Number(b.width), height: Number(b.height) },
  };
}
function clonePin(value: RemoteWindowPin): RemoteWindowPin {
  return { ...value, bounds: { ...value.bounds } };
}
export function exactRemoteWindow(a: RemoteWindowPin, b: RemoteWindowPin): boolean {
  if (!b || typeof b !== "object" || !b.bounds || typeof b.bounds !== "object") return false;
  return a.pid === b.pid && a.nativeId === b.nativeId &&
    a.title === b.title && a.application === b.application &&
    a.bounds.x === b.bounds.x && a.bounds.y === b.bounds.y &&
    a.bounds.width === b.bounds.width && a.bounds.height === b.bounds.height;
}

export class RemoteLiveSessionPolicy {
  private pending: PendingHost | null = null;
  private active: Session | null = null;
  private activating = false;
  private attaching = false;

  constructor(
    private readonly verifier: RemoteLiveVerifiers,
    private readonly now: () => number = Date.now,
    /** Must close any attached socket and discard queued frames synchronously. */
    private readonly onRevoke: () => void = () => undefined,
  ) {}

  /** Host-only; the challenge is NOT remote viewer authorization. */
  beginNativeApproval(raw: RemoteHostIntent): { nonce: string; expiresAt: number } {
    this.expire();
    if (this.pending || this.active || this.activating) denied("BUSY");
    if (!exactKeys(raw, ["hostId", "viewerId", "expectedOrigin", "window"]) ||
        !id(raw.hostId) || !id(raw.viewerId) || !exactOrigin(raw.expectedOrigin)) {
      denied("INVALID_REQUEST");
    }
    const nonce = randomSecret();
    const expiresAt = this.now() + REMOTE_HOST_CHALLENGE_TTL_MS;
    this.pending = {
      nonce, expiresAt,
      intent: { hostId: raw.hostId, viewerId: raw.viewerId,
        expectedOrigin: raw.expectedOrigin, window: pin(raw.window) },
    };
    return { nonce, expiresAt };
  }

  /** Host-only; only native-attended proof can mint a short-lived host token. */
  async approveNative(raw: { nonce: string; proof: string }): Promise<{
    sessionId: string; hostToken: string; viewerChallenge: string; expiresAt: number;
  }> {
    this.expire();
    if (!exactKeys(raw, ["nonce", "proof"]) || !isSecret(raw.nonce) ||
        typeof raw.proof !== "string" || raw.proof.length < 8 ||
        raw.proof.length > 8192) denied("INVALID_REQUEST");
    if (this.activating || this.active) denied("BUSY");
    const pending = this.pending;
    this.pending = null; // Burn even an invalid or replayed native proof.
    if (!pending || pending.nonce !== raw.nonce || this.now() >= pending.expiresAt) {
      denied("CONSENT_REQUIRED");
    }
    this.activating = true;
    try {
      const valid = await this.verifier.verifyHostApproval({
        ...pending.intent, window: clonePin(pending.intent.window),
        nonce: pending.nonce, proof: raw.proof,
      }).catch(() => false);
      if (!valid || this.active || this.now() >= pending.expiresAt) denied("CONSENT_REQUIRED");
      const hostToken = randomSecret();
      const sessionId = randomSecret();
      const viewerChallenge = randomSecret();
      const now = this.now();
      const expiresAt = now + REMOTE_SESSION_TTL_MS;
      this.active = {
        id: sessionId, hostId: pending.intent.hostId, viewerId: pending.intent.viewerId,
        origin: pending.intent.expectedOrigin, window: clonePin(pending.intent.window),
        hostTokenDigest: digest(hostToken), viewerNonce: viewerChallenge,
        viewerChallengeExpiresAt: now + REMOTE_VIEWER_CHALLENGE_TTL_MS,
        viewerChallengeUsed: false, expiresAt,
      };
      return { sessionId, hostToken, viewerChallenge, expiresAt };
    } finally { this.activating = false; }
  }

  private expire(): void {
    if (this.pending && this.now() >= this.pending.expiresAt) this.pending = null;
    if (this.active && (this.now() >= this.active.expiresAt ||
        (!this.active.viewer && this.now() >= this.active.viewerChallengeExpiresAt))) {
      this.terminate();
    }
  }

  private checkTransport(transport: RemoteTransportEvidence, session: Session): void {
    if (!transport || !id(transport.connectionId) ||
        transport.authenticatedViewerId !== session.viewerId ||
        transport.origin !== session.origin ||
        transport.tlsVerified !== true ||
        transport.privateIngressVerified !== true ||
        transport.publicTunnelDetected !== false ||
        transport.forwardedHeadersPresent !== false) denied("TRANSPORT_DENIED");
  }

  /**
   * Viewer-only after an independent cryptographic proof. One attach, one
   * trusted connection; reconnect requires a NEW attended native approval.
   */
  async attachViewer(raw: {
    sessionId: string; proof: string; transport: RemoteTransportEvidence;
  }): Promise<{ csrfToken: string; expiresAt: number }> {
    this.expire();
    if (!raw || !isSecret(raw.sessionId) ||
        typeof raw.proof !== "string" || raw.proof.length < 8 ||
        raw.proof.length > 8192) denied("VIEWER_PROOF_REQUIRED");
    const session = this.active;
    if (!session || session.id !== raw.sessionId || session.viewer ||
        session.viewerChallengeUsed || this.attaching) denied("SESSION_DENIED");
    this.checkTransport(raw.transport, session);
    if (this.now() >= session.viewerChallengeExpiresAt) {
      this.terminate();
      denied("SESSION_DENIED");
    }
    session.viewerChallengeUsed = true; // Burn before async proof verification.
    this.attaching = true;
    try {
      const valid = await this.verifier.verifyViewerProof({
        sessionId: session.id, nonce: session.viewerNonce,
        hostId: session.hostId, viewerId: session.viewerId, expectedOrigin: session.origin,
        connectionId: raw.transport.connectionId, proof: raw.proof,
      }).catch(() => false);
      this.expire();
      if (!valid || this.active !== session) {
        this.terminate();
        denied("VIEWER_PROOF_REQUIRED");
      }
      this.checkTransport(raw.transport, session);
      const csrfToken = randomSecret();
      session.viewer = { connectionId: raw.transport.connectionId, csrfDigest: digest(csrfToken) };
      return { csrfToken, expiresAt: session.expiresAt };
    } finally { this.attaching = false; }
  }

  /** Called for every frame and acknowledgement; never trusts client cookies. */
  authorizeViewer(raw: {
    sessionId: string; csrfToken: string; transport: RemoteTransportEvidence;
  }): { window: RemoteWindowPin; expiresAt: number } {
    this.expire();
    const session = this.active;
    if (!session || !raw || raw.sessionId !== session.id || !session.viewer) {
      denied("SESSION_DENIED");
    }
    this.checkTransport(raw.transport, session);
    if (raw.transport.connectionId !== session.viewer.connectionId ||
        !sameSecret(raw.csrfToken, session.viewer.csrfDigest)) denied("SESSION_DENIED");
    return { window: clonePin(session.window), expiresAt: session.expiresAt };
  }

  revokeByHost(raw: { sessionId: string; hostToken: string }): void {
    this.expire();
    if (!raw || !this.active || raw.sessionId !== this.active.id ||
        !sameSecret(raw.hostToken, this.active.hostTokenDigest)) denied("SESSION_DENIED");
    this.terminate();
  }

  /** Only the internal transport lifecycle or host supervisor may call this. */
  terminate(): void {
    this.pending = null;
    const old = this.active;
    this.active = null;
    if (old) {
      try { this.onRevoke(); } catch { /* Never keep a revoked capability alive. */ }
    }
  }
}

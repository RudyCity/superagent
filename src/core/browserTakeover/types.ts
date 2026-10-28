/**
 * SuperAgent Linux Secure Human Takeover Subsystem Types (Milestone M3)
 *
 * Defines explicit states, session contracts, and configuration for
 * human-in-the-loop takeover on virtual-display and headless runtimes.
 *
 * Hard Invariants:
 * 1. Plaintext tokens, passwords, cookies, and OTPs are NEVER stored in persistent session metadata.
 * 2. Only cryptographic hashes (SHA-256) of one-time nonces are persisted.
 * 3. Human holds are bound to (port, targetId, profileId, generation, browserFingerprint).
 */

export type TakeoverState =
  | "AGENT_ACTIVE"
  | "HUMAN_REQUESTED"
  | "HUMAN_READY"
  | "HUMAN_ACTIVE"
  | "RETURN_REQUESTED"
  | "VERIFYING"
  | "PAUSED_NEEDS_REVIEW"
  | "CANCELLED"
  | "EXPIRED";

export interface TakeoverAuditEntry {
  timestamp: number;
  from: TakeoverState;
  to: TakeoverState;
  actor: string;
  details?: string;
}

export interface TakeoverSession {
  sessionId: string;
  targetId: string;
  port: number;
  profileId: string;
  generation: string;
  browserFingerprint: string;
  displayNumber?: number;
  noVncPort?: number;
  vncPort?: number;
  vncPassword?: string;
  invitationKeyPath?: string;
  state: TakeoverState;
  requestedBy: string;
  reason: string;
  targetUrl?: string;
  tokenHash: string; // SHA-256 of single-use invitation nonce
  operatorTokenHash?: string; // Human-only control capability, never serialized to public status
  csrfTokenHash?: string; // Anti-CSRF token hash
  invitationRedeemed: boolean;
  createdAt: number;
  updatedAt: number;
  invitationExpiresAt: number;
  sessionExpiresAt: number;
  humanActiveAt?: number;
  returnedAt?: number;
  verifiedAt?: number;
  resolution?: "verified" | "needs_review" | "cancelled" | "expired";
  reviewReason?: string;
  auditTrail: TakeoverAuditEntry[];
}

export type PublicTakeoverSession = Omit<TakeoverSession, "tokenHash" | "operatorTokenHash" | "csrfTokenHash" | "vncPassword">;

export interface TakeoverConfig {
  enabled: boolean;
  remoteAccessEnabled: boolean;
  invitationTtlMs: number;
  sessionTtlMs: number;
  sessionsDir?: string;
}

export interface TakeoverInvitation {
  sessionId: string;
  invitationToken: string;
  invitationUrl: string;
  invitationKeyPath?: string;
  expiresAt: number;
  state: TakeoverState;
  targetId: string;
  reason: string;
}

export interface RequestTakeoverInput {
  targetId: string;
  port?: number;
  reason: string;
  requestedBy?: string;
  targetUrl?: string;
  profileId?: string;
  generation?: string;
  browserFingerprint?: string;
  displayNumber?: number;
}

export interface RedeemInvitationInput {
  sessionId: string;
  invitationToken: string;
  actor?: string;
}

export interface ReturnToAgentInput {
  sessionId: string;
  actor?: string;
  operatorToken?: string;
  notes?: string;
}

export interface CancelTakeoverInput {
  sessionId: string;
  reason: string;
  actor?: string;
  releaseHold?: boolean;
  operatorToken?: string;
  invitationToken?: string;
}

export interface VerifyAndResumeResult {
  sessionId: string;
  state: TakeoverState;
  resumed: boolean;
  reason?: string;
  verifiedAt?: number;
}

export interface RedeemInvitationResult {
  session: TakeoverSession;
  authorized: boolean;
  operatorToken: string;
  csrfToken: string;
}

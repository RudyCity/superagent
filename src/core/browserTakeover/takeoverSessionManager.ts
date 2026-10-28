/**
 * Takeover Session Manager (Milestone M3)
 *
 * Coordinates Human-in-the-Loop browser takeover sessions, enforces the
 * "hold-before-link" security invariant, handles single-use token redemption,
 * and manages safe Return to Agent verification before releasing holds.
 *
 * Hard Invariants:
 * 1. Human hold via setManagedBrowserControl MUST be installed BEFORE issuing an invitation.
 * 2. Invitation nonces are single-use and have a strict 5-minute TTL.
 * 3. Token verification uses constant-time comparison (timingSafeEqual).
 * 4. Plaintext tokens are NEVER persisted to disk; only SHA-256 hashes are stored.
 * 5. Remote inputs are revoked BEFORE the managed browser human hold is lifted.
 * 6. Live browser fingerprint and target tab generation are revalidated on return.
 * 7. Disconnect or expiry FAILS CLOSED (never silently resumes the agent).
 */

import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  type TakeoverSession,
  type TakeoverInvitation,
  type TakeoverConfig,
  type RequestTakeoverInput,
  type RedeemInvitationInput,
  type ReturnToAgentInput,
  type CancelTakeoverInput,
  type VerifyAndResumeResult,
  type PublicTakeoverSession,
} from "./types.js";
import {
  saveTakeoverSession,
  loadTakeoverSession,
  listTakeoverSessions,
  transitionSession,
  sanitizeUrlForAudit,
  getTakeoverSessionsDir,
} from "./takeoverStateMachine.js";
import { setManagedBrowserControl } from "../tools/managedBrowserControl.js";
import {
  browserFingerprintForPort,
  listManagedBrowserRegistrations,
  registerManagedBrowser,
} from "../tools/managedBrowserRegistry.js";
import { discoverCdpPages } from "../tools/chromeCdpTools.js";
import { getBrowserProcessManager } from "../browserRuntime/browserProcessManager.js";

const DEFAULT_CONFIG: TakeoverConfig = {
  enabled: true,
  remoteAccessEnabled: false, // Strictly opt-in; local only by default
  invitationTtlMs: 5 * 60 * 1000, // 5 minutes
  sessionTtlMs: 15 * 60 * 1000, // 15 minutes
};

/**
 * Generates a high-entropy random base64url token.
 */
function generateInvitationToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/**
 * Computes the SHA-256 hash of a string in hex format.
 */
function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * Constant-time hash verification.
 */
function verifyTokenHash(token: string, expectedHash: string): boolean {
  if (!token || !expectedHash) return false;
  const actualHash = hashToken(token);
  const a = Buffer.from(actualHash, "hex");
  const b = Buffer.from(expectedHash, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Removes the sensitive token hash from a session object before returning to public callers.
 */
export function sanitizePublicSession(session: TakeoverSession): PublicTakeoverSession {
  const { tokenHash: _hash, operatorTokenHash: _operatorHash, ...publicSession } = session;
  return publicSession;
}

export class TakeoverSessionManager {
  private config: TakeoverConfig;
  private inputRevocationCallbacks: Map<string, () => void> = new Map();
  // Invitation secrets stay in memory only, and are retrievable exclusively via
  // the locally authenticated human control-plane endpoint (never agent output).
  private pendingInvitations = new Map<string, TakeoverInvitation>();

  constructor(config?: Partial<TakeoverConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  public getConfig(): TakeoverConfig {
    return { ...this.config };
  }

  public registerInputRevoker(sessionId: string, revoker: () => void): void {
    this.inputRevocationCallbacks.set(sessionId, revoker);
  }

  public unregisterInputRevoker(sessionId: string): void {
    this.inputRevocationCallbacks.delete(sessionId);
  }

  /**
   * Revokes remote input for a session immediately.
   */
  public revokeRemoteInput(sessionId: string): void {
    const revoker = this.inputRevocationCallbacks.get(sessionId);
    if (revoker) {
      try {
        revoker();
      } catch {}
      this.inputRevocationCallbacks.delete(sessionId);
    }
  }

  /**
   * Requests a human takeover on a specified CDP target.
   *
   * SECURITY GATE:
   * Installs a verified human hold via `setManagedBrowserControl` BEFORE issuing an invitation.
   */
  public async requestTakeover(
    input: RequestTakeoverInput,
    customDir?: string
  ): Promise<TakeoverInvitation> {
    if (!this.config.enabled) {
      throw new Error("Human takeover subsystem is disabled.");
    }

    if (!input.targetId || typeof input.targetId !== "string") {
      throw new Error("Explicit targetId required for takeover request.");
    }

    const port = input.port ?? Number(process.env.SUPERAGENT_CDP_PORT || 9222);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      throw new Error("Invalid CDP port.");
    }

    // The takeover MUST refer to a process owned by the canonical runtime,
    // not an arbitrary local CDP port or caller-supplied display number.
    const runtime = getBrowserProcessManager().getActiveInstance(port);
    if (!runtime || !runtime.virtualDisplay || !runtime.virtualDisplay.noVncPort ||
        !runtime.virtualDisplay.vncPort) {
      throw new Error("Managed Linux virtual-display browser with explicitly enabled local VNC/noVNC required.");
    }
    if (input.displayNumber !== undefined && input.displayNumber !== runtime.virtualDisplay.displayNumber) {
      throw new Error("Requested display does not match the owned Chrome runtime.");
    }

    // 1. Verify live Chrome fingerprint
    const liveFingerprint = await browserFingerprintForPort(port);
    if (input.browserFingerprint && input.browserFingerprint !== liveFingerprint) {
      throw new Error("Supplied browser fingerprint does not match live Chrome identity.");
    }
    const browserFingerprint = liveFingerprint;

    // 2. Discover target page
    const pages = await discoverCdpPages(port);
    const targetPage = pages.find((p) => p.targetId === input.targetId);
    if (!targetPage) {
      throw new Error(`Target tab '${input.targetId}' not found on CDP port ${port}.`);
    }

    // 3. Locate or establish managed browser registration
    let profileId = input.profileId;
    let generation = input.generation;

    const existingRegistrations = listManagedBrowserRegistrations();
    const existing = existingRegistrations.find(
      (r) => r.port === port && r.targetId === input.targetId
    );

    if (existing) {
      profileId = existing.profileId;
      generation = existing.generation;
    } else {
      profileId = profileId || runtime.profileName;
      generation = generation || runtime.generation;
      try {
        await registerManagedBrowser({
          profileId,
          generation,
          port,
          targetId: input.targetId,
          browserFingerprint,
        });
      } catch (err: any) {
        // If registration already exists or failed, recheck
        const recheck = listManagedBrowserRegistrations().find(
          (r) => r.port === port && r.targetId === input.targetId
        );
        if (recheck) {
          profileId = recheck.profileId;
          generation = recheck.generation;
        } else {
          throw new Error(`Failed to ensure managed browser registration: ${err.message}`);
        }
      }
    }

    // 4. HARD SECURITY GATE: Install verified human hold BEFORE issuing invitation!
    await setManagedBrowserControl({
      mode: "human",
      port,
      targetId: input.targetId,
      profileId,
      generation,
      browserFingerprint,
    });

    // 5. Generate one-time invitation nonce and session metadata
    const sessionId = crypto.randomUUID();
    const token = generateInvitationToken();
    const tokenHash = hashToken(token);
    const now = Date.now();
    const invitationExpiresAt = now + this.config.invitationTtlMs;
    const sessionExpiresAt = now + this.config.sessionTtlMs;

    const session: TakeoverSession = {
      sessionId,
      targetId: input.targetId,
      port,
      profileId,
      generation,
      browserFingerprint,
      displayNumber: runtime.virtualDisplay.displayNumber,
      state: "HUMAN_READY",
      requestedBy: input.requestedBy || "agent",
      reason: input.reason || "Manual user verification required",
      targetUrl: sanitizeUrlForAudit(input.targetUrl || targetPage.url),
      tokenHash,
      invitationRedeemed: false,
      createdAt: now,
      updatedAt: now,
      invitationExpiresAt,
      sessionExpiresAt,
      auditTrail: [
        {
          timestamp: now,
          from: "AGENT_ACTIVE",
          to: "HUMAN_REQUESTED",
          actor: input.requestedBy || "agent",
          details: `Takeover requested: ${input.reason}`,
        },
        {
          timestamp: now,
          from: "HUMAN_REQUESTED",
          to: "HUMAN_READY",
          actor: "system",
          details: "Verified human hold installed on managed CDP target.",
        },
      ],
    };

    // 6. Persist session metadata (WITHOUT plaintext token)
    await saveTakeoverSession(session, customDir || this.config.sessionsDir);

    const invitationUrl = `/api/browser/takeover/ui?sessionId=${sessionId}&token=${token}`;

    const invitation: TakeoverInvitation = {
      sessionId, invitationToken: token, invitationUrl,
      expiresAt: invitationExpiresAt, state: "HUMAN_READY",
      targetId: input.targetId, reason: session.reason,
    };
    this.pendingInvitations.set(sessionId, invitation);
    return invitation;
  }

  /**
   * Redeems a one-time invitation token to gain interactive human control.
   * Prevents replay attacks: the token can only be redeemed once.
   */
  public async redeemInvitation(
    input: RedeemInvitationInput,
    customDir?: string
  ): Promise<{ session: TakeoverSession; authorized: boolean; operatorToken: string; vncPassword?: string }> {
    // An atomic cross-process mutex protects the read/verify/consume sequence.
    // A stale lock fails closed and requires operator reconciliation.
    const directory = getTakeoverSessionsDir(customDir || this.config.sessionsDir);
    await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
    const lockPath = path.join(directory, input.sessionId + ".redeem.lock");
    try {
      await fsp.mkdir(lockPath);
    } catch {
      throw new Error("Concurrent or interrupted invitation redemption; operator review required.");
    }
    try {
    const session = await loadTakeoverSession(
      input.sessionId,
      customDir || this.config.sessionsDir
    );

    if (!session) {
      throw new Error(`Takeover session '${input.sessionId}' not found.`);
    }

    const now = Date.now();

    // Check expiration
    if (now > session.invitationExpiresAt || now > session.sessionExpiresAt) {
      const expired = transitionSession(session, "EXPIRED", "system", "Invitation expired.");
      await saveTakeoverSession(expired, customDir || this.config.sessionsDir);
      throw new Error("Takeover invitation has expired.");
    }

    // Check single-use / replay prevention
    if (session.invitationRedeemed) {
      throw new Error("Invitation token already redeemed; single-use token cannot be replayed.");
    }

    // Verify token hash with timing-safe comparison
    if (!verifyTokenHash(input.invitationToken, session.tokenHash)) {
      throw new Error("Invalid invitation token.");
    }

    // Check valid state
    if (session.state !== "HUMAN_READY") {
      throw new Error(`Cannot redeem invitation in state '${session.state}'.`);
    }

    // Transition to HUMAN_ACTIVE
    const active = transitionSession(
      session,
      "HUMAN_ACTIVE",
      input.actor || "human",
      "One-time invitation redeemed successfully."
    );
    active.invitationRedeemed = true;
    this.pendingInvitations.delete(input.sessionId);
    const operatorToken = generateInvitationToken();
    active.operatorTokenHash = hashToken(operatorToken);
    await saveTakeoverSession(active, customDir || this.config.sessionsDir);

    // The VNC password is returned only to a human redeeming the invitation.
    // Never store it in session JSON, notifications, or agent tool output.
    const runtime = getBrowserProcessManager().getActiveInstance(active.port);
    const vncPassword = runtime?.browserFingerprint === active.browserFingerprint &&
      runtime.virtualDisplay?.displayNumber === active.displayNumber
      ? runtime?.virtualDisplay?.vncPassword : undefined;
    return { session: active, authorized: true, operatorToken, vncPassword };
    } finally {
      await fsp.rmdir(lockPath).catch(() => {});
    }
  }

  /**
   * Initiates the Return to Agent process.
   *
   * SECURITY INVARIANT:
   * Revokes remote input BEFORE lifting the hold.
   */
  public async requestReturn(
    input: ReturnToAgentInput,
    customDir?: string
  ): Promise<TakeoverSession> {
    const session = await loadTakeoverSession(
      input.sessionId,
      customDir || this.config.sessionsDir
    );

    if (!session) {
      throw new Error(`Takeover session '${input.sessionId}' not found.`);
    }

    // Only the human's redeemed short-lived session capability can request a
    // return. Agent tools and the generic Core bearer cannot override a hold.
    if (!session.operatorTokenHash || !verifyTokenHash(input.operatorToken || "", session.operatorTokenHash)) {
      throw new Error("Human operator authorization required to return control.");
    }
    if (Date.now() > session.sessionExpiresAt) {
      throw new Error("Human operator session expired; hold remains installed.");
    }
    if (session.state !== "HUMAN_ACTIVE" && session.state !== "HUMAN_READY" && session.state !== "PAUSED_NEEDS_REVIEW") {
      throw new Error(`Cannot request return in state '${session.state}'.`);
    }

    // 1. Transition to RETURN_REQUESTED
    let updated = transitionSession(
      session,
      "RETURN_REQUESTED",
      input.actor || "human",
      input.notes || "Human requested return to agent."
    );

    // 2. HARD SECURITY INVARIANT: Revoke remote input immediately!
    this.revokeRemoteInput(input.sessionId);

    // 3. Transition to VERIFYING
    updated = transitionSession(
      updated,
      "VERIFYING",
      "system",
      "Revoked remote input; verifying browser identity and tab state."
    );

    await saveTakeoverSession(updated, customDir || this.config.sessionsDir);
    return updated;
  }

  /**
   * Verifies live browser identity, tab state, and releases the human hold.
   */
  public async verifyAndResume(
    sessionId: string,
    customDir?: string
  ): Promise<VerifyAndResumeResult> {
    const session = await loadTakeoverSession(sessionId, customDir || this.config.sessionsDir);
    if (!session) {
      throw new Error(`Takeover session '${sessionId}' not found.`);
    }

    if (session.state !== "VERIFYING" && session.state !== "RETURN_REQUESTED") {
      throw new Error(`Cannot verify session in state '${session.state}'.`);
    }

    // 1. Re-verify live browser fingerprint
    let currentFingerprint: string;
    try {
      currentFingerprint = await browserFingerprintForPort(session.port);
    } catch (err: any) {
      const paused = transitionSession(
        session,
        "PAUSED_NEEDS_REVIEW",
        "system",
        `Browser identity check failed: ${err.message}`
      );
      paused.reviewReason = "Browser runtime unreachable";
      await saveTakeoverSession(paused, customDir || this.config.sessionsDir);
      return {
        sessionId,
        state: "PAUSED_NEEDS_REVIEW",
        resumed: false,
        reason: "Browser runtime unreachable; hold preserved.",
      };
    }

    if (currentFingerprint !== session.browserFingerprint) {
      const paused = transitionSession(
        session,
        "PAUSED_NEEDS_REVIEW",
        "system",
        "Browser identity changed (browser restart detected)."
      );
      paused.reviewReason = "Browser fingerprint mismatch";
      await saveTakeoverSession(paused, customDir || this.config.sessionsDir);
      return {
        sessionId,
        state: "PAUSED_NEEDS_REVIEW",
        resumed: false,
        reason: "Browser fingerprint mismatch; hold preserved for review.",
      };
    }

    // 2. Re-verify target page still exists
    const pages = await discoverCdpPages(session.port);
    const targetPage = pages.find((p) => p.targetId === session.targetId);
    if (!targetPage) {
      const paused = transitionSession(
        session,
        "PAUSED_NEEDS_REVIEW",
        "system",
        "Target tab was closed during takeover."
      );
      paused.reviewReason = "Target tab not found";
      await saveTakeoverSession(paused, customDir || this.config.sessionsDir);
      return {
        sessionId,
        state: "PAUSED_NEEDS_REVIEW",
        resumed: false,
        reason: "Target tab was closed during takeover; hold preserved for review.",
      };
    }

    // A managed browser announcement has a shorter TTL (90s) than a takeover.
    // Re-register only after fingerprint+live target verification; never bypass
    // the canonical hold controller or silently release a different generation.
    try {
      await registerManagedBrowser({
        profileId: session.profileId, generation: session.generation,
        port: session.port, targetId: session.targetId,
        browserFingerprint: session.browserFingerprint,
      });
      await setManagedBrowserControl({
        mode: "agent",
        port: session.port,
        targetId: session.targetId,
        profileId: session.profileId,
        generation: session.generation,
        browserFingerprint: session.browserFingerprint,
      });
    } catch (err: any) {
      const paused = transitionSession(
        session,
        "PAUSED_NEEDS_REVIEW",
        "system",
        `Failed to release human hold: ${err.message}`
      );
      paused.reviewReason = err.message;
      await saveTakeoverSession(paused, customDir || this.config.sessionsDir);
      return {
        sessionId,
        state: "PAUSED_NEEDS_REVIEW",
        resumed: false,
        reason: `Failed to release hold: ${err.message}`,
      };
    }

    // 4. Transition to AGENT_ACTIVE
    const resumedSession = transitionSession(
      session,
      "AGENT_ACTIVE",
      "system",
      "Identity and tab verified; hold released; agent resumed."
    );

    await saveTakeoverSession(resumedSession, customDir || this.config.sessionsDir);

    return {
      sessionId,
      state: "AGENT_ACTIVE",
      resumed: true,
      verifiedAt: resumedSession.verifiedAt,
    };
  }

  /**
   * Cancels a takeover session.
   * If releaseHold is false (default), keeps the hold installed so agent remains paused.
   */
  public async cancelTakeover(
    input: CancelTakeoverInput,
    customDir?: string
  ): Promise<TakeoverSession> {
    const session = await loadTakeoverSession(
      input.sessionId,
      customDir || this.config.sessionsDir
    );

    if (!session) {
      throw new Error(`Takeover session '${input.sessionId}' not found.`);
    }

    // Cancellation always keeps the hold. A cancellation request cannot bypass
    // Return-to-Agent revalidation or be forged by a local process knowing a UUID.
    if (input.releaseHold) {
      throw new Error("Cancellation cannot release a human hold; use authorized Return to Agent.");
    }
    const pending = session.state === "HUMAN_READY" || session.state === "HUMAN_REQUESTED";
    const approved = pending
      ? Boolean(session.tokenHash && !session.invitationRedeemed &&
          Date.now() < session.invitationExpiresAt &&
          verifyTokenHash(input.invitationToken || "", session.tokenHash))
      : Boolean(session.operatorTokenHash &&
          verifyTokenHash(input.operatorToken || "", session.operatorTokenHash));
    if (!approved) throw new Error("Authorized human capability required to cancel takeover.");
    // 1. Revoke remote input
    this.revokeRemoteInput(input.sessionId);

    // 2. Transition to CANCELLED
    const cancelled = transitionSession(
      session,
      "CANCELLED",
      input.actor || "operator",
      input.reason || "Takeover cancelled."
    );

    await saveTakeoverSession(cancelled, customDir || this.config.sessionsDir);
    return cancelled;
  }

  /**
   * Scans sessions and expires stale ones.
   * Invariant: Expired sessions FAIL CLOSED (do not lift hold).
   */
  public async listPendingInvitations(): Promise<TakeoverInvitation[]> {
    const now = Date.now();
    const available: TakeoverInvitation[] = [];
    for (const [id, invitation] of this.pendingInvitations) {
      if (now >= invitation.expiresAt ||
          !(await this.verifyInvitation(id, invitation.invitationToken))) {
        this.pendingInvitations.delete(id);
      } else {
        available.push({ ...invitation });
      }
    }
    return available;
  }

  public async authorizeOperator(sessionId: string, operatorToken: string): Promise<boolean> {
    const session = await loadTakeoverSession(sessionId, this.config.sessionsDir);
    return Boolean(session && session.state === "HUMAN_ACTIVE" &&
      Date.now() < session.sessionExpiresAt && session.operatorTokenHash &&
      verifyTokenHash(operatorToken, session.operatorTokenHash));
  }

  public async verifyInvitation(sessionId: string, invitationToken: string): Promise<boolean> {
    const session = await loadTakeoverSession(sessionId, this.config.sessionsDir);
    return Boolean(session && session.state === "HUMAN_READY" && !session.invitationRedeemed &&
      Date.now() < session.invitationExpiresAt && session.tokenHash &&
      verifyTokenHash(invitationToken, session.tokenHash));
  }

  public async expireStaleSessions(customDir?: string): Promise<number> {
    const sessions = await listTakeoverSessions(customDir || this.config.sessionsDir);
    const now = Date.now();
    let expiredCount = 0;

    for (const session of sessions) {
      if (
        session.state === "HUMAN_REQUESTED" ||
        session.state === "HUMAN_READY" ||
        session.state === "HUMAN_ACTIVE"
      ) {
        const isInvitationExpired = !session.invitationRedeemed && now > session.invitationExpiresAt;
        const isSessionExpired = now > session.sessionExpiresAt;

        if (isInvitationExpired || isSessionExpired) {
          this.revokeRemoteInput(session.sessionId);
          const expired = transitionSession(
            session,
            "EXPIRED",
            "system",
            isInvitationExpired ? "Invitation TTL expired." : "Session lifetime TTL expired."
          );
          await saveTakeoverSession(expired, customDir || this.config.sessionsDir);
          expiredCount++;
        }
      }
    }

    return expiredCount;
  }
}

// Global default singleton instance
let defaultManager: TakeoverSessionManager | null = null;
let takeoverSweepStarted = false;

export function getTakeoverSessionManager(config?: Partial<TakeoverConfig>): TakeoverSessionManager {
  if (!defaultManager || config) {
    defaultManager = new TakeoverSessionManager(config);
  }
  if (!takeoverSweepStarted && !config) {
    takeoverSweepStarted = true;
    const sweep = setInterval(() => {
      void defaultManager?.expireStaleSessions().catch(() => {});
    }, 15_000);
    sweep.unref();
  }
  return defaultManager;
}

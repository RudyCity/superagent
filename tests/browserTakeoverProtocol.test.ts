/**
 * Browser Takeover Protocol Unit & Integration Tests (Milestone M3)
 *
 * Validates the state machine, "hold-before-link" invariant,
 * single-use token redemption, replay prevention, URL sanitization,
 * and safe Return to Agent verification before releasing holds.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import {
  type TakeoverSession,
  type TakeoverState,
  canTransition,
  assertValidTransition,
  transitionSession,
  saveTakeoverSession,
  loadTakeoverSession,
  listTakeoverSessions,
  sanitizeUrlForAudit,
  TakeoverSessionManager,
  sanitizePublicSession,
} from "../src/core/browserTakeover/index.js";
import { resetManagedBrowserRegistrationsForTests } from "../src/core/tools/managedBrowserRegistry.js";
import { cdpGatewayRoot } from "../src/core/tools/chromeCdpSessionManager.js";

describe("Takeover State Machine Transitions", () => {
  it("allows legal state transitions", () => {
    expect(canTransition("AGENT_ACTIVE", "HUMAN_REQUESTED")).toBe(true);
    expect(canTransition("HUMAN_REQUESTED", "HUMAN_READY")).toBe(true);
    expect(canTransition("HUMAN_READY", "HUMAN_ACTIVE")).toBe(true);
    expect(canTransition("HUMAN_ACTIVE", "RETURN_REQUESTED")).toBe(true);
    expect(canTransition("RETURN_REQUESTED", "VERIFYING")).toBe(true);
    expect(canTransition("VERIFYING", "AGENT_ACTIVE")).toBe(true);
    expect(canTransition("VERIFYING", "PAUSED_NEEDS_REVIEW")).toBe(true);
    expect(canTransition("HUMAN_READY", "EXPIRED")).toBe(true);
    expect(canTransition("HUMAN_ACTIVE", "CANCELLED")).toBe(true);
  });

  it("rejects illegal transitions that violate the takeover protocol", () => {
    // Cannot skip directly from AGENT_ACTIVE to VERIFYING
    expect(canTransition("AGENT_ACTIVE", "VERIFYING")).toBe(false);
    expect(() => assertValidTransition("AGENT_ACTIVE", "VERIFYING")).toThrow();

    // Cannot resume from EXPIRED to AGENT_ACTIVE directly
    expect(canTransition("EXPIRED", "AGENT_ACTIVE")).toBe(false);
    expect(() => assertValidTransition("EXPIRED", "AGENT_ACTIVE")).toThrow();

    // CANCELLED is terminal
    expect(canTransition("CANCELLED", "AGENT_ACTIVE")).toBe(false);
    expect(canTransition("CANCELLED", "HUMAN_ACTIVE")).toBe(false);
  });

  it("sanitizes URLs before recording metadata, stripping query tokens and fragments", () => {
    const raw = "https://accounts.google.com/signin/v2/challenge/pwd?auth_token=secret_12345&client_id=xyz#state_token";
    const sanitized = sanitizeUrlForAudit(raw);
    expect(sanitized).toBe("https://accounts.google.com/signin/v2/challenge/pwd");
    expect(sanitized).not.toContain("secret_12345");
    expect(sanitized).not.toContain("state_token");
  });
});

describe("Takeover Session Persistence & Hashing", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `superagent-takeover-test-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`);
    await fsp.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await fsp.rm(testDir, { recursive: true, force: true });
    } catch {}
  });

  it("persists sessions with hashed token only (never plaintext token)", async () => {
    const sessionId = crypto.randomUUID();
    const token = crypto.randomBytes(32).toString("base64url");
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

    const session: TakeoverSession = {
      sessionId,
      targetId: "target-tab-101",
      port: 9222,
      profileId: "default",
      generation: "1-12345678",
      browserFingerprint: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      state: "HUMAN_READY",
      requestedBy: "agent-1",
      reason: "OTP verification required",
      targetUrl: "https://example.com/login?token=leak",
      tokenHash,
      invitationRedeemed: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      invitationExpiresAt: Date.now() + 300_000,
      sessionExpiresAt: Date.now() + 900_000,
      auditTrail: [],
    };

    await saveTakeoverSession(session, testDir);

    const loaded = await loadTakeoverSession(sessionId, testDir);
    expect(loaded).not.toBeNull();
    expect(loaded?.sessionId).toBe(sessionId);
    expect(loaded?.tokenHash).toBe(tokenHash);
    expect(loaded?.targetUrl).toBe("https://example.com/login"); // query stripped

    // Raw disk check: file on disk must NOT contain plaintext token
    const diskContent = await fsp.readFile(path.join(testDir, `${sessionId}.json`), "utf8");
    expect(diskContent).not.toContain(token);
    expect(diskContent).toContain(tokenHash);

    // Public representation scrubs tokenHash
    const publicSession = sanitizePublicSession(loaded!);
    expect((publicSession as any).tokenHash).toBeUndefined();
    expect(publicSession.sessionId).toBe(sessionId);
  });
});

describe("Takeover Session Manager Lifecycle & Invariants", () => {
  let testDir: string;
  let manager: TakeoverSessionManager;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `superagent-takeover-mgr-test-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`);
    await fsp.mkdir(testDir, { recursive: true });
    manager = new TakeoverSessionManager({
      sessionsDir: testDir,
      invitationTtlMs: 2000, // 2 seconds for test
      sessionTtlMs: 5000,
    });
  });

  afterEach(async () => {
    try {
      await fsp.rm(testDir, { recursive: true, force: true });
      resetManagedBrowserRegistrationsForTests();
    } catch {}
  });

  it("enforces single-use invitation token redemption and rejects replays", async () => {
    const sessionId = crypto.randomUUID();
    const token = crypto.randomBytes(32).toString("base64url");
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

    const session: TakeoverSession = {
      sessionId,
      targetId: "tab-replay-test",
      port: 9222,
      profileId: "test-profile",
      generation: "1-12345678",
      browserFingerprint: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      state: "HUMAN_READY",
      requestedBy: "agent",
      reason: "Testing single use",
      tokenHash,
      invitationRedeemed: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      invitationExpiresAt: Date.now() + 60_000,
      sessionExpiresAt: Date.now() + 120_000,
      auditTrail: [],
    };

    await saveTakeoverSession(session, testDir);

    // 1. First redemption should succeed
    const redeemResult = await manager.redeemInvitation({
      sessionId,
      invitationToken: token,
      actor: "human-operator",
    }, testDir);

    expect(redeemResult.authorized).toBe(true);
    expect(redeemResult.session.state).toBe("HUMAN_ACTIVE");
    expect(redeemResult.session.invitationRedeemed).toBe(true);

    // 2. Second redemption attempt (replay attack) MUST fail closed!
    await expect(manager.redeemInvitation({
      sessionId,
      invitationToken: token,
      actor: "malicious-actor",
    }, testDir)).rejects.toThrow(/already redeemed/i);
  });

  it("rejects redemption with wrong token (constant-time verification)", async () => {
    const sessionId = crypto.randomUUID();
    const token = "correct-invitation-token-12345";
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

    const session: TakeoverSession = {
      sessionId,
      targetId: "tab-wrong-token-test",
      port: 9222,
      profileId: "test-profile",
      generation: "1-12345678",
      browserFingerprint: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      state: "HUMAN_READY",
      requestedBy: "agent",
      reason: "Wrong token test",
      tokenHash,
      invitationRedeemed: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      invitationExpiresAt: Date.now() + 60_000,
      sessionExpiresAt: Date.now() + 120_000,
      auditTrail: [],
    };

    await saveTakeoverSession(session, testDir);

    await expect(manager.redeemInvitation({
      sessionId,
      invitationToken: "forged-attacker-token-99999",
      actor: "attacker",
    }, testDir)).rejects.toThrow(/Invalid invitation token/i);
  });

  it("fails closed on expired invitation tokens", async () => {
    const sessionId = crypto.randomUUID();
    const token = "expired-token-123";
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

    const session: TakeoverSession = {
      sessionId,
      targetId: "tab-expired-test",
      port: 9222,
      profileId: "test-profile",
      generation: "1-12345678",
      browserFingerprint: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      state: "HUMAN_READY",
      requestedBy: "agent",
      reason: "Expired token test",
      tokenHash,
      invitationRedeemed: false,
      createdAt: Date.now() - 10_000,
      updatedAt: Date.now() - 10_000,
      invitationExpiresAt: Date.now() - 1_000, // expired 1 second ago
      sessionExpiresAt: Date.now() + 60_000,
      auditTrail: [],
    };

    await saveTakeoverSession(session, testDir);

    await expect(manager.redeemInvitation({
      sessionId,
      invitationToken: token,
      actor: "human",
    }, testDir)).rejects.toThrow(/expired/i);

    const reloaded = await loadTakeoverSession(sessionId, testDir);
    expect(reloaded?.state).toBe("EXPIRED");
  });

  it("blocks a second concurrent redemption of a one-use invitation token", async () => {
    const sessionId = crypto.randomUUID();
    const token = crypto.randomBytes(32).toString("base64url");
    const now = Date.now();
    const session: TakeoverSession = {
      sessionId, targetId: "concurrent-tab", port: 9222,
      profileId: "test", generation: "g1", browserFingerprint: "a".repeat(64),
      state: "HUMAN_READY", requestedBy: "test", reason: "concurrent redemption",
      tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
      invitationRedeemed: false, createdAt: now, updatedAt: now,
      invitationExpiresAt: now + 300000, sessionExpiresAt: now + 600000, auditTrail: [],
    };
    await saveTakeoverSession(session, testDir);
    const [a, b] = await Promise.allSettled([
      manager.redeemInvitation({ sessionId, invitationToken: token }, testDir),
      manager.redeemInvitation({ sessionId, invitationToken: token }, testDir),
    ]);
    expect([a, b].filter(r => r.status === "fulfilled")).toHaveLength(1);
  });

  it("revokes remote input immediately upon return request", async () => {
    const sessionId = crypto.randomUUID();
    let revokerCalled = false;

    manager.registerInputRevoker(sessionId, () => {
      revokerCalled = true;
    });

    const session: TakeoverSession = {
      sessionId,
      targetId: "tab-return-revocation",
      port: 9222,
      profileId: "test-profile",
      generation: "1-12345678",
      browserFingerprint: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      state: "HUMAN_ACTIVE",
      requestedBy: "agent",
      reason: "Revocation test",
      tokenHash: "dummy",
      operatorTokenHash: crypto.createHash("sha256").update("operator-for-test").digest("hex"),
      invitationRedeemed: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      invitationExpiresAt: Date.now() + 60_000,
      sessionExpiresAt: Date.now() + 120_000,
      auditTrail: [],
    };

    await saveTakeoverSession(session, testDir);

    await expect(manager.requestReturn({ sessionId }, testDir)).rejects.toThrow(/Human operator authorization/i);
    const updated = await manager.requestReturn({ sessionId, operatorToken: "operator-for-test" }, testDir);
    expect(updated.state).toBe("VERIFYING");
    expect(revokerCalled).toBe(true);
  });

  it("expires stale sessions without releasing holds (fails closed)", async () => {
    const sessionId = crypto.randomUUID();
    const session: TakeoverSession = {
      sessionId,
      targetId: "tab-stale-sweep",
      port: 9222,
      profileId: "test-profile",
      generation: "1-12345678",
      browserFingerprint: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      state: "HUMAN_READY",
      requestedBy: "agent",
      reason: "Stale sweep test",
      tokenHash: "dummy",
      invitationRedeemed: false,
      createdAt: Date.now() - 20_000,
      updatedAt: Date.now() - 20_000,
      invitationExpiresAt: Date.now() - 5_000, // expired
      sessionExpiresAt: Date.now() + 10_000,
      auditTrail: [],
    };

    await saveTakeoverSession(session, testDir);

    const count = await manager.expireStaleSessions(testDir);
    expect(count).toBe(1);

    const reloaded = await loadTakeoverSession(sessionId, testDir);
    expect(reloaded?.state).toBe("EXPIRED");
    expect(reloaded?.resolution).toBe("expired");
  });
});

describe("Takeover human authorization regression", () => {
  it("cannot return a human-held tab using only a session ID", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "takeover-human-auth-"));
    try {
      const sessionId = crypto.randomUUID();
      const t = Date.now();
      await saveTakeoverSession({
        sessionId, targetId: "held-tab", port: 9222, profileId: "default",
        generation: "gen", browserFingerprint: "a".repeat(64),
        state: "HUMAN_ACTIVE", requestedBy: "agent", reason: "manual review",
        tokenHash: crypto.createHash("sha256").update("invite").digest("hex"),
        operatorTokenHash: crypto.createHash("sha256").update("human-only-secret").digest("hex"),
        invitationRedeemed: true, createdAt: t, updatedAt: t,
        invitationExpiresAt: t + 20000, sessionExpiresAt: t + 120000,
        auditTrail: [],
      }, dir);
      const manager = new TakeoverSessionManager({sessionsDir:dir});
      await expect(manager.requestReturn({sessionId,actor:"agent"},dir)).rejects.toThrow(/human operator authorization/i);
      await expect(manager.cancelTakeover({sessionId,reason:"agent request"},dir)).rejects.toThrow(/authorized human capability/i);
      expect((await loadTakeoverSession(sessionId,dir))?.state).toBe("HUMAN_ACTIVE");
      const cancelled = await manager.cancelTakeover({
        sessionId,operatorToken:"human-only-secret",reason:"human cancelled",
      },dir);
      expect(cancelled.state).toBe("CANCELLED");
    } finally {
      await fsp.rm(dir,{recursive:true,force:true});
    }
  });
});

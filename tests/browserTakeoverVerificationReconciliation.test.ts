import { afterEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TakeoverSessionManager } from "../src/core/browserTakeover/takeoverSessionManager.js";
import { saveTakeoverSession, loadTakeoverSession } from "../src/core/browserTakeover/takeoverStateMachine.js";
import { claimTakeoverTarget, readTakeoverTargetReservation } from "../src/core/browserTakeover/takeoverTargetLease.js";
import {
  claimVerificationLock, releaseVerificationLock, reconcileStaleVerificationLock,
  type VerificationOwner,
} from "../src/core/browserTakeover/takeoverVerificationLease.js";
import type { TakeoverSession, TakeoverState } from "../src/core/browserTakeover/types.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => fsp.rm(dir, { recursive: true, force: true })));
});
async function fixture(state: TakeoverState = "PAUSED_NEEDS_REVIEW", token = "operator-secret") {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "sa-verify-reconciliation-"));
  dirs.push(dir);
  const now = Date.now();
  const sessionId = crypto.randomUUID();
  const session: TakeoverSession = {
    sessionId, targetId: "locked-tab-" + sessionId, port: 9222,
    profileId: "m4b", generation: "1-123456",
    browserFingerprint: "a".repeat(64), requestedBy: "agent",
    state, reason: "stale verifier owner", tokenHash: "placeholder",
    operatorTokenHash: crypto.createHash("sha256").update(token).digest("hex"),
    invitationRedeemed: true, createdAt: now, updatedAt: now,
    invitationExpiresAt: now + 60000, sessionExpiresAt: now + 120000,
    auditTrail: [],
  };
  await saveTakeoverSession(session, dir);
  await claimTakeoverTarget(9222, session.targetId, sessionId, dir);
  return { dir, session, token, manager: new TakeoverSessionManager({ sessionsDir: dir }) };
}
async function fakeLock(dir: string, sessionId: string, owner: Partial<VerificationOwner>) {
  const lock = path.join(dir, sessionId + ".verify.lock");
  await fsp.mkdir(lock, { mode: 0o700 });
  if (Object.keys(owner).length) {
    const data: VerificationOwner = {
      sessionId, pid: 2147483647, creationIdentity: "win:638700000000000000",
      nonce: crypto.randomUUID(), acquiredAt: Date.now(), ...owner,
    };
    await fsp.writeFile(path.join(lock, "owner.json"), JSON.stringify(data), { mode: 0o600 });
  }
  return lock;
}

describe("M4-B2 operator-authenticated dead verification lock reconciliation", () => {
  it("refuses to clear the lock owned by the currently living verifier", async () => {
    const { dir, session, token, manager } = await fixture();
    const ticket = await claimVerificationLock(session.sessionId, dir);
    try {
      await expect(manager.reconcileInterruptedVerification({
        sessionId: session.sessionId, operatorToken: token,
        acknowledgeInterruptedVerification: true,
      }, dir)).rejects.toThrow(/process is present or unverified/i);
      await expect(claimVerificationLock(session.sessionId, dir)).rejects.toThrow(/verification is active or interrupted/i);
      const denied = await loadTakeoverSession(session.sessionId, dir);
      expect(denied?.state).toBe("PAUSED_NEEDS_REVIEW");
      expect(denied?.auditTrail).toEqual([]);
      expect((await readTakeoverTargetReservation(9222, session.targetId, dir))?.sessionId).toBe(session.sessionId);
    } finally {
      await releaseVerificationLock(ticket);
    }
  });

  it("denies wrong credentials and acknowledgement, then clears only a provably dead lock", async () => {
    const { dir, session, token, manager } = await fixture();
    const lock = await fakeLock(dir, session.sessionId, {});
    // Legacy empty locks are not proven safe.
    await expect(manager.reconcileInterruptedVerification({
      sessionId: session.sessionId, operatorToken: token,
      acknowledgeInterruptedVerification: true,
    }, dir)).rejects.toThrow(/missing, malformed or has unknown ownership/i);
    await fsp.rmdir(lock);
    await fakeLock(dir, session.sessionId, { pid: 2147483647 });
    await expect(manager.reconcileInterruptedVerification({
      sessionId: session.sessionId, operatorToken: "invalid",
      acknowledgeInterruptedVerification: true,
    }, dir)).rejects.toThrow(/Valid redeemed human operator capability required/i);
    await expect(manager.reconcileInterruptedVerification({
      sessionId: session.sessionId, operatorToken: token,
      acknowledgeInterruptedVerification: false as any,
    }, dir)).rejects.toThrow(/acknowledgement required/i);

    const result = await manager.reconcileInterruptedVerification({
      sessionId: session.sessionId, operatorToken: token,
      acknowledgeInterruptedVerification: true,
    }, dir);
    expect(result).toEqual({ recovered: true, sessionId: session.sessionId, state: "PAUSED_NEEDS_REVIEW" });
    await expect(fsp.stat(lock)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readTakeoverTargetReservation(9222, session.targetId, dir))?.sessionId)
      .toBe(session.sessionId);
    const persisted = await loadTakeoverSession(session.sessionId, dir);
    expect(persisted?.state).toBe("PAUSED_NEEDS_REVIEW");
    expect(persisted?.auditTrail.at(-1)?.actor).toBe("human");
    expect(persisted?.auditTrail.at(-1)?.details).toContain("dead verification owner");
    await expect(manager.reconcileInterruptedVerification({
      sessionId: session.sessionId, operatorToken: token,
      acknowledgeInterruptedVerification: true,
    }, dir)).rejects.toThrow(/missing, malformed or has unknown ownership/i);
    // The operator still has to request return; no automatic resume.
    expect((await manager.requestReturn({
      sessionId: session.sessionId, operatorToken: token,
    }, dir)).state).toBe("VERIFYING");
  });

  it("keeps expired, mismatched, ambiguous and non-review sessions locked", async () => {
    for (const variant of ["expired", "non-review", "foreign-lease", "no-birth"] as const) {
      const { dir, session, manager, token } = await fixture(
        variant === "non-review" ? "VERIFYING" : "PAUSED_NEEDS_REVIEW",
      );
      const lock = await fakeLock(dir, session.sessionId, {
        pid: 2147483647, creationIdentity: variant === "no-birth" ? null : "win:638700000000000000",
      });
      if (variant === "expired") {
        await saveTakeoverSession({ ...session, sessionExpiresAt: Date.now() - 1 }, dir);
      } else if (variant === "foreign-lease") {
        const lease = (await fsp.readdir(dir)).find(file => file.startsWith(".target-"));
        expect(lease).toBeDefined();
        await fsp.writeFile(path.join(dir, lease!, "owner.json"),
          JSON.stringify({ sessionId: crypto.randomUUID(), port: 9222, targetId: session.targetId }));
      }
      await expect(manager.reconcileInterruptedVerification({
        sessionId: session.sessionId, operatorToken: token,
        acknowledgeInterruptedVerification: true,
      }, dir)).rejects.toThrow();
      expect(await fsp.stat(lock)).toBeDefined();
      expect((await loadTakeoverSession(session.sessionId, dir))?.state)
        .toBe(variant === "non-review" ? "VERIFYING" : "PAUSED_NEEDS_REVIEW");
    }
  });

  it("cannot reconcile another session ID or a legacy empty mutex", async () => {
    const { dir, session } = await fixture();
    const lock = await fakeLock(dir, session.sessionId, {});
    await expect(reconcileStaleVerificationLock(session.sessionId, dir))
      .rejects.toThrow(/missing, malformed or has unknown ownership/i);
    await expect(reconcileStaleVerificationLock(crypto.randomUUID(), dir))
      .rejects.toThrow(/missing, malformed or has unknown ownership/i);
    expect(await fsp.stat(lock)).toBeDefined();
  });
});

import { afterEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TakeoverSessionManager } from "../src/core/browserTakeover/takeoverSessionManager.js";
import { loadTakeoverSession, saveTakeoverSession } from "../src/core/browserTakeover/takeoverStateMachine.js";
import type { TakeoverSession, TakeoverState } from "../src/core/browserTakeover/types.js";
import {
  claimTakeoverTarget, readTakeoverTargetReservation, releaseTakeoverTarget,
} from "../src/core/browserTakeover/takeoverTargetLease.js";

const workdirs: string[] = [];
afterEach(async () => {
  await Promise.all(workdirs.splice(0).map(dir => fsp.rm(dir, { recursive: true, force: true })));
});

async function newDir() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "sa-m4b-restart-"));
  workdirs.push(dir);
  return dir;
}
function createSession(state: TakeoverState, sessionId = crypto.randomUUID()): TakeoverSession {
  const now = Date.now();
  return {
    sessionId, port: 9222, targetId: "crashed-tab-" + sessionId,
    profileId: "m4b", generation: "1001-1793000000000000",
    browserFingerprint: "a".repeat(64),
    state, requestedBy: "agent", reason: "crash-recovery",
    tokenHash: crypto.createHash("sha256").update("invitation").digest("hex"),
    operatorTokenHash: crypto.createHash("sha256").update("human-secret").digest("hex"),
    invitationRedeemed: state !== "HUMAN_READY" && state !== "HUMAN_REQUESTED",
    createdAt: now, updatedAt: now, invitationExpiresAt: now + 60_000,
    sessionExpiresAt: now + 120_000, auditTrail: [],
  };
}

describe("M4-B durable takeover crash recovery", () => {
  it("returns null for an absent lock and fails closed for corrupt lock owners", async () => {
    const dir = await newDir();
    const id = crypto.randomUUID();
    expect(await readTakeoverTargetReservation(9222, "tab", dir)).toBeNull();
    await claimTakeoverTarget(9222, "tab", id, dir);
    expect((await readTakeoverTargetReservation(9222, "tab", dir))?.sessionId).toBe(id);
    const locks = (await fsp.readdir(dir)).filter(name => name.endsWith(".lock"));
    expect(locks).toHaveLength(1);
    await fsp.writeFile(path.join(dir, locks[0], "owner.json"), "{truncated");
    await expect(readTakeoverTargetReservation(9222, "tab", dir)).rejects.toThrow(/operator reconciliation/i);
    await expect(claimTakeoverTarget(9222, "tab", crypto.randomUUID(), dir)).rejects.toThrow(/already reserves/i);
    await expect(releaseTakeoverTarget(9222, "tab", id, dir)).rejects.toThrow(/operator reconciliation/i);
  });

  it("reconciles every pending session beyond the public 100-session listing limit", async () => {
    const dir = await newDir();
    const sessions = Array.from({ length: 106 }, () => createSession("HUMAN_READY"));
    await Promise.all(sessions.map(session => saveTakeoverSession(session, dir)));
    const manager = new TakeoverSessionManager({ sessionsDir: dir });
    expect(await manager.reconcileAfterRestart(dir)).toEqual({
      scanned: 106, reconciled: 106, requiresReview: 106,
    });
    const states = await Promise.all(sessions.map(s => loadTakeoverSession(s.sessionId, dir)));
    expect(states.every(s => s?.state === "EXPIRED")).toBe(true);
  });

  it("restarts active, returning and verifying sessions in paused review without releasing target leases", async () => {
    const dir = await newDir();
    const states: TakeoverState[] = ["HUMAN_ACTIVE", "RETURN_REQUESTED", "VERIFYING"];
    const sessions = states.map(state => createSession(state));
    for (const session of sessions) {
      await claimTakeoverTarget(session.port, session.targetId, session.sessionId, dir);
      await saveTakeoverSession(session, dir);
    }
    const manager = new TakeoverSessionManager({ sessionsDir: dir });
    expect(await manager.reconcileAfterRestart(dir)).toEqual({
      scanned: 3, reconciled: 3, requiresReview: 3,
    });
    for (const session of sessions) {
      const recovered = await loadTakeoverSession(session.sessionId, dir);
      expect(recovered?.state).toBe("PAUSED_NEEDS_REVIEW");
      expect(recovered?.resolution).toBe("needs_review");
      expect(recovered?.reviewReason).toMatch(/Core restart/);
      expect(recovered?.auditTrail.at(-1)?.actor).toBe("system");
      expect((await readTakeoverTargetReservation(9222, session.targetId, dir))?.sessionId)
        .toBe(session.sessionId);
    }
    // Valid persisted operator capability can request a NEW verification,
    // but no automatic agent release has occurred.
    const selected = sessions[0];
    await expect(manager.requestReturn({ sessionId: selected.sessionId, operatorToken: "wrong" }, dir))
      .rejects.toThrow(/authorization required/i);
    expect((await manager.requestReturn({
      sessionId: selected.sessionId, operatorToken: "human-secret",
    }, dir)).state).toBe("VERIFYING");
    expect((await readTakeoverTargetReservation(9222, selected.targetId, dir))?.sessionId)
      .toBe(selected.sessionId);
  });

  it("gates operator return on startup reconciliation before changing state", async () => {
    const dir = await newDir();
    const session = createSession("HUMAN_ACTIVE");
    await claimTakeoverTarget(session.port, session.targetId, session.sessionId, dir);
    await saveTakeoverSession(session, dir);
    const restarted = new TakeoverSessionManager({ sessionsDir: dir });
    restarted.beginStartupReconciliation();
    const retry = await restarted.requestReturn({
      sessionId: session.sessionId, operatorToken: "human-secret",
    }, dir);
    expect(retry.state).toBe("VERIFYING");
    const persisted = await loadTakeoverSession(session.sessionId, dir);
    expect(persisted?.auditTrail.map(entry => entry.details).some(note => note?.includes("Core restarted"))).toBe(true);
    expect(persisted?.auditTrail.at(-1)?.details).toContain("Operator-authorized return retry");
    expect((await readTakeoverTargetReservation(9222, session.targetId, dir))?.sessionId)
      .toBe(session.sessionId);
  });

  it("never steals an interrupted verification lock based only on age", async () => {
    const dir = await newDir();
    const session = createSession("VERIFYING");
    await claimTakeoverTarget(session.port, session.targetId, session.sessionId, dir);
    await saveTakeoverSession(session, dir);
    const verificationLock = path.join(dir, session.sessionId + ".verify.lock");
    await fsp.mkdir(verificationLock);
    const manager = new TakeoverSessionManager({ sessionsDir: dir });
    await expect(manager.verifyAndResume(session.sessionId, dir))
      .rejects.toThrow(/verification is active or interrupted/i);
    expect((await loadTakeoverSession(session.sessionId, dir))?.state).toBe("VERIFYING");
    expect((await readTakeoverTargetReservation(9222, session.targetId, dir))?.sessionId)
      .toBe(session.sessionId);
    expect(await fsp.stat(verificationLock)).toBeDefined();
  });

  it("invalidates unredeemed invitations after restart and retains their reservations", async () => {
    const dir = await newDir();
    const session = createSession("HUMAN_READY");
    await claimTakeoverTarget(session.port, session.targetId, session.sessionId, dir);
    await saveTakeoverSession(session, dir);
    const manager = new TakeoverSessionManager({ sessionsDir: dir });
    expect((await manager.reconcileAfterRestart()).reconciled).toBe(1);
    const expired = await loadTakeoverSession(session.sessionId, dir);
    expect(expired?.state).toBe("EXPIRED");
    await expect(manager.redeemInvitation({ sessionId: session.sessionId, invitationToken: "invitation" }, dir))
      .rejects.toThrow(/expired|Cannot redeem/i);
    await expect(claimTakeoverTarget(session.port, session.targetId, crypto.randomUUID(), dir))
      .rejects.toThrow(/already reserves/i);
    expect((await manager.reconcileAfterRestart()).reconciled).toBe(0);
  });
});

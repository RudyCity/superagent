import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  createDelegateLeaseJournal, type DurableDelegateLease,
} from "../src/core/browserTransport/delegateLeaseJournal.js";

const SECRET = Buffer.alloc(32, 42);
const A = "a".repeat(32);
const B = "b".repeat(32);
const PROFILE_A = "chrome-profile-alpha";
const PROFILE_B = "chrome-profile-beta";
const ownerHash = (token: string) => createHash("sha256").update(token).digest("hex");
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "delegate-durable-lease-"));
  vi.resetModules();
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(directory, { recursive: true, force: true });
});
function store(epoch = A, now?: () => number, previousEpochRetired?: (previousEpoch: string) => boolean) {
  return createDelegateLeaseJournal({ directory, integrityKey: SECRET, epoch, now, previousEpochRetired });
}
async function coordinator() {
  // Emulates a new Core module instance without starting/restarting a live Core.
  return import("../src/core/browserTransport/sessionCoordinator.js");
}
function lease(now: number, clientId = PROFILE_A, tabId = 100, token = "owner-secret-super-long-321") : DurableDelegateLease {
  return {
    clientId, tabId, agentId: "owner", tokenHash: ownerHash(token),
    claimedAt: now, expiresAt: now + 90_000, revision: 0, sharing: false,
    participants: [], invitations: [], recoveredEpoch: A,
  };
}
describe("durable Delegate-CDP ownership journal (isolated temp filesystem only)", () => {
  it("fails closed on missing state, requires explicit initialization, and never exposes plaintext tokens", async () => {
    const journal = store();
    expect(() => journal.read()).toThrowError(expect.objectContaining({ code: "DELEGATE_LEASE_MISSING" }));
    const core = await coordinator();
    expect(() => core.configureDelegateLeaseJournal(journal)).toThrow(/absent/i);
    expect(() => core.authorizeDelegateTarget(PROFILE_A, 100)).toThrow(/unavailable/i);
    expect(core.hasDelegateClaim(PROFILE_A, 100)).toBe(true);
    expect(() => journal.initialize()).not.toThrow();
    expect(() => journal.initialize()).toThrow(/overwrite/i);
    const raw = readFileSync(journal.path, "utf8");
    expect(JSON.parse(raw)).toMatchObject({ schema: 1, sequence: 0, leases: [] });
  });

  it("persists only digests, roles, invitations, revocation, and revision changes", async () => {
    const journal = store();
    journal.initialize();
    const core = await coordinator();
    core.configureDelegateLeaseJournal(journal);
    const own = core.claimDelegateTarget(PROFILE_A, 100, "owner");
    core.setDelegateSharing(PROFILE_A, 100, "owner", own.sessionToken, true);
    const observerInvite = core.inviteDelegateAgent(PROFILE_A, 100, "owner", own.sessionToken, "observer", "observer");
    const observer = core.joinDelegateTarget(PROFILE_A, 100, "observer", observerInvite.inviteId, observerInvite.invitationToken);
    const writerInvite = core.inviteDelegateAgent(PROFILE_A, 100, "owner", own.sessionToken, "writer", "contributor");
    const writer = core.joinDelegateTarget(PROFILE_A, 100, "writer", writerInvite.inviteId, writerInvite.invitationToken);
    const disk = readFileSync(journal.path, "utf8");
    for (const plaintext of [own.sessionToken, observer.sessionToken, writer.sessionToken,
      observerInvite.invitationToken, writerInvite.invitationToken]) {
      expect(disk).not.toContain(plaintext);
    }
    const persisted = journal.read().leases[0];
    expect(persisted).toBeDefined();
    expect(persisted.tokenHash).toBe(ownerHash(own.sessionToken));
    expect(persisted.participants).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentId: "observer", role: "observer" }),
      expect.objectContaining({ agentId: "writer", role: "contributor" }),
    ]));
    expect(() => core.authorizeDelegateTarget(PROFILE_A, 100, "observer", observer.sessionToken, true, observer.revision))
      .toThrow(/observer|read-only/i);
    core.authorizeDelegateTarget(PROFILE_A, 100, "writer", writer.sessionToken, true, writer.revision);
    core.noteDelegateWriteSuccess(PROFILE_A, 100, "writer", writer.sessionToken);
    expect(journal.read().leases[0]?.revision).toBeGreaterThan(writer.revision);
    core.revokeDelegateAgent(PROFILE_A, 100, "owner", own.sessionToken, "writer");
    expect(journal.read().leases[0]?.participants.some(p => p.agentId === "writer")).toBe(false);
    expect(() => core.authorizeDelegateTarget(PROFILE_A, 100, "writer", writer.sessionToken)).toThrow(/claimed/i);
    core.releaseDelegateTarget(PROFILE_A, 100, "owner", own.sessionToken);
    expect(journal.read().leases).toHaveLength(0);
  });

  it("blocks anonymous access after restart and recovers with the original owner token only", async () => {
    const initial = store(A);
    initial.initialize();
    const oldCore = await coordinator();
    oldCore.configureDelegateLeaseJournal(initial);
    const owner = oldCore.claimDelegateTarget(PROFILE_A, 101, "owner");
    oldCore.setDelegateSharing(PROFILE_A, 101, "owner", owner.sessionToken, true);
    const invitation = oldCore.inviteDelegateAgent(PROFILE_A, 101, "owner", owner.sessionToken, "writer", "contributor");
    const writer = oldCore.joinDelegateTarget(PROFILE_A, 101, "writer", invitation.inviteId, invitation.invitationToken);
    const priorRevision = writer.revision;
    vi.resetModules();
    const newCore = await coordinator();
    const unverified = store(B);
    expect(() => unverified.recover(PROFILE_A, 101, "owner", owner.sessionToken, initial.read().sequence))
      .toThrowError(expect.objectContaining({ code: "DELEGATE_LEASE_EPOCH_AMBIGUOUS" }));
    const restarted = store(B, undefined, () => true);
    newCore.configureDelegateLeaseJournal(restarted);
    expect(newCore.hasDelegateClaim(PROFILE_A, 101)).toBe(true);
    expect(() => newCore.authorizeDelegateTarget(PROFILE_A, 101)).toThrow(/stale|recover|unavailable/i);
    expect(() => newCore.authorizeDelegateTarget(PROFILE_A, 101, "writer", writer.sessionToken, true, priorRevision))
      .toThrow(/stale|recover|unavailable/i);
    expect(() => newCore.recoverDelegateTarget(PROFILE_B, 101, "owner", owner.sessionToken))
      .toThrow(/recovery|matching/i);
    expect(() => newCore.recoverDelegateTarget(PROFILE_A, 101, "owner", "fake-secret"))
      .toThrow(/capability/i);
    expect(() => newCore.recoverDelegateTarget(PROFILE_A, 101, "imposter", owner.sessionToken))
      .toThrow(/capability/i);
    const recovered = newCore.recoverDelegateTarget(PROFILE_A, 101, "owner", owner.sessionToken);
    expect(recovered.revision).toBe(priorRevision + 1);
    expect(recovered.recoveryRequired).toBe(false);
    expect(() => newCore.authorizeDelegateTarget(PROFILE_A, 101, "writer", writer.sessionToken, true, priorRevision))
      .toThrow(/stale revision/i);
    newCore.authorizeDelegateTarget(PROFILE_A, 101, "writer", writer.sessionToken, true, recovered.revision);
    expect(() => oldCore.authorizeDelegateTarget(PROFILE_A, 101, "owner", owner.sessionToken))
      .toThrow(/another Core|revision/i);
    newCore.releaseDelegateTarget(PROFILE_A, 101, "owner", owner.sessionToken);
  });

  it("keeps unrelated profiles/tabs quarantined until their respective owner recovers", async () => {
    const oldJournal = store(A);
    oldJournal.initialize();
    const oldCore = await coordinator();
    oldCore.configureDelegateLeaseJournal(oldJournal);
    const alpha = oldCore.claimDelegateTarget(PROFILE_A, 200, "owner-alpha");
    const beta = oldCore.claimDelegateTarget(PROFILE_B, 200, "owner-beta");
    vi.resetModules();
    const restarted = store(B, undefined, () => true);
    const newCore = await coordinator();
    newCore.configureDelegateLeaseJournal(restarted);
    newCore.recoverDelegateTarget(PROFILE_A, 200, "owner-alpha", alpha.sessionToken);
    newCore.authorizeDelegateTarget(PROFILE_A, 200, "owner-alpha", alpha.sessionToken);
    expect(() => newCore.authorizeDelegateTarget(PROFILE_B, 200, "owner-beta", beta.sessionToken))
      .toThrow(/recover/i);
    expect(() => newCore.recoverDelegateTarget(PROFILE_A, 200, "owner-beta", beta.sessionToken))
      .toThrow(/capability/i);
    newCore.recoverDelegateTarget(PROFILE_B, 200, "owner-beta", beta.sessionToken);
    newCore.authorizeDelegateTarget(PROFILE_B, 200, "owner-beta", beta.sessionToken);
  });

  it("honors expiry for owners and participants, preserving unexpired owner recovery", async () => {
    vi.useFakeTimers();
    const t0 = Date.parse("2026-11-06T01:00:00.000Z");
    vi.setSystemTime(t0);
    const oldJournal = store(A);
    oldJournal.initialize();
    const oldCore = await coordinator();
    oldCore.configureDelegateLeaseJournal(oldJournal);
    const owner = oldCore.claimDelegateTarget(PROFILE_A, 301, "owner");
    oldCore.setDelegateSharing(PROFILE_A, 301, "owner", owner.sessionToken, true);
    const invitation = oldCore.inviteDelegateAgent(PROFILE_A, 301, "owner", owner.sessionToken, "guest", "observer");
    const guest = oldCore.joinDelegateTarget(PROFILE_A, 301, "guest", invitation.inviteId, invitation.invitationToken);
    vi.setSystemTime(t0 + 70_000);
    oldCore.heartbeatDelegateSession(PROFILE_A, 301, "owner", owner.sessionToken);
    vi.setSystemTime(t0 + 100_000);
    vi.resetModules();
    const newCore = await coordinator();
    newCore.configureDelegateLeaseJournal(store(B, undefined, () => true));
    newCore.recoverDelegateTarget(PROFILE_A, 301, "owner", owner.sessionToken);
    expect(() => newCore.authorizeDelegateTarget(PROFILE_A, 301, "guest", guest.sessionToken))
      .toThrow(/claimed/i);
    newCore.authorizeDelegateTarget(PROFILE_A, 301, "owner", owner.sessionToken);
    vi.setSystemTime(t0 + 200_000);
    vi.resetModules();
    const lastCore = await coordinator();
    lastCore.configureDelegateLeaseJournal(store("c".repeat(32)));
    expect(() => lastCore.recoverDelegateTarget(PROFILE_A, 301, "owner", owner.sessionToken))
      .toThrow(/unexpired/i);
  });

  it("rejects stale CAS writers, ambiguous lock state, corruption, and unauthorized replacement", () => {
    const first = store(A);
    first.initialize();
    const t = Date.now();
    const a = lease(t);
    first.commit(0, [a]);
    expect(() => first.commit(0, [])).toThrowError(expect.objectContaining({ code: "DELEGATE_LEASE_STALE" }));
    const other = store(B);
    expect(() => other.commit(1, [])).toThrow(/another process/i);
    const raw = readFileSync(first.path, "utf8");
    const state = JSON.parse(raw);
    state.leases[0].agentId = "intruder";
    writeFileSync(first.path, JSON.stringify(state), "utf8");
    expect(() => first.read()).toThrowError(expect.objectContaining({ code: "DELEGATE_LEASE_CORRUPT" }));
    writeFileSync(first.path, raw, "utf8");
    const lockFile = first.path + ".lock";
    writeFileSync(lockFile, "ambiguous");
    expect(() => first.commit(1, [])).toThrowError(expect.objectContaining({ code: "DELEGATE_LEASE_LOCKED" }));
    unlinkSync(lockFile); // Only our isolated fixture lock, never a live ledger.
    expect(first.read().leases).toHaveLength(1);
    unlinkSync(first.path); // Simulate missing journal in isolated fixture.
    expect(() => first.read()).toThrowError(expect.objectContaining({ code: "DELEGATE_LEASE_MISSING" }));
  });

  it("denies expired owner recovery and refuses unsafe paths or weak integrity keys", () => {
    let now = 500_000;
    const first = store(A, () => now);
    first.initialize();
    first.commit(0, [lease(now)]);
    now += 91_000;
    expect(() => store(B, () => now).recover(PROFILE_A, 100, "owner", "owner-secret-super-long-321", 1))
      .toThrow(/unexpired/i);
    expect(() => createDelegateLeaseJournal({ directory, integrityKey: Buffer.alloc(3) }))
      .toThrow(/32-byte/i);
    expect(() => createDelegateLeaseJournal({ directory: "relative/path", integrityKey: SECRET }))
      .toThrow(/absolute/i);
    if (process.platform !== "win32") {
      chmodSync(directory, 0o755);
      expect(() => store().read()).toThrow(/owner-only/i);
    }
  });
  it("never silently breaks live leases when an epoch rotates, but retires all expired claims with verified evidence", async () => {
    let now = 1_000_000;
    const initial = store(A, () => now);
    initial.initialize();
    initial.commit(0, [lease(now)]);
    const unverified = store(B, () => now);
    const verified = store(B, () => now, () => true);
    expect(() => verified.retireExpired(1)).toThrowError(expect.objectContaining({ code: "DELEGATE_LEASE_ACTIVE" }));
    now += 91_000;
    expect(() => unverified.retireExpired(1)).toThrowError(expect.objectContaining({ code: "DELEGATE_LEASE_EPOCH_AMBIGUOUS" }));
    const retired = verified.retireExpired(1);
    expect(retired.writerEpoch).toBe(B);
    expect(retired.leases).toHaveLength(0);
    expect(() => initial.commit(2, [])).toThrow(/another process/i);
    expect(() => verified.recover(PROFILE_A, 100, "owner", "owner-secret-super-long-321", 2))
      .toThrow(/matching/i);
  });

  it("does not recover expired invitations or grant participants revoked after restart", async () => {
    vi.useFakeTimers();
    const t0 = Date.parse("2026-11-06T01:00:00.000Z");
    vi.setSystemTime(t0);
    const initial = store(A);
    initial.initialize();
    const core = await coordinator();
    core.configureDelegateLeaseJournal(initial);
    const owner = core.claimDelegateTarget(PROFILE_A, 502, "owner");
    core.setDelegateSharing(PROFILE_A, 502, "owner", owner.sessionToken, true);
    const invite = core.inviteDelegateAgent(PROFILE_A, 502, "owner", owner.sessionToken, "guest", "observer");
    vi.setSystemTime(t0 + 65_000);
    core.heartbeatDelegateSession(PROFILE_A, 502, "owner", owner.sessionToken);
    vi.resetModules();
    const reboot = await coordinator();
    reboot.configureDelegateLeaseJournal(store(B, undefined, () => true));
    reboot.recoverDelegateTarget(PROFILE_A, 502, "owner", owner.sessionToken);
    expect(() => reboot.joinDelegateTarget(PROFILE_A, 502, "guest", invite.inviteId, invite.invitationToken))
      .toThrow(/invitation/i);
    const newInvite = reboot.inviteDelegateAgent(PROFILE_A, 502, "owner", owner.sessionToken, "guest", "observer");
    const joined = reboot.joinDelegateTarget(PROFILE_A, 502, "guest", newInvite.inviteId, newInvite.invitationToken);
    reboot.revokeDelegateAgent(PROFILE_A, 502, "owner", owner.sessionToken, "guest");
    vi.resetModules();
    const afterRevoke = await coordinator();
    afterRevoke.configureDelegateLeaseJournal(store("c".repeat(32), undefined, () => true));
    afterRevoke.recoverDelegateTarget(PROFILE_A, 502, "owner", owner.sessionToken);
    expect(() => afterRevoke.authorizeDelegateTarget(PROFILE_A, 502, "guest", joined.sessionToken))
      .toThrow(/claimed/i);
  });

  it("fails closed on runtime corruption and does not silently reopen after the file is repaired", async () => {
    const journal = store(A);
    journal.initialize();
    const core = await coordinator();
    core.configureDelegateLeaseJournal(journal);
    const owner = core.claimDelegateTarget(PROFILE_A, 530, "owner");
    const validBytes = readFileSync(journal.path, "utf8");
    writeFileSync(journal.path, "{this is not json");
    expect(() => core.authorizeDelegateTarget(PROFILE_A, 530, "owner", owner.sessionToken))
      .toThrow(/journal cannot be read/i);
    expect(core.hasDelegateClaim(PROFILE_A, 530)).toBe(true);
    writeFileSync(journal.path, validBytes);
    expect(() => core.authorizeDelegateTarget(PROFILE_A, 530, "owner", owner.sessionToken))
      .toThrow(/unavailable/i);
  });

});

/**
 * Two independently authenticated MCP contexts exercise the production CDP
 * boundary against a deterministic in-memory Delegate bridge. Never binds a
 * port, opens Chrome, or calls live MCP/Core/Tray.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { delegateBridge } from "../src/core/delegate/bridge.js";
import { executeDelegateChromeCommand } from "../src/core/delegate/cdpTransport.js";
import { createDelegateLeaseJournal } from "../src/core/browserTransport/delegateLeaseJournal.js";
import {
  createDelegateForwardedSigner, createDelegateForwardedVerifier,
  generateDelegateForwardedChannelMaterial,
} from "../src/core/browserTransport/delegateForwardedPrincipal.js";
import {
  getDelegateMcpPrincipalId, runWithAuthenticatedDelegatePrincipal,
  runWithDelegateMcpBoundary,
  type AuthenticatedDelegateMcpConnection,
} from "../src/core/browserTransport/delegatePrincipalPolicy.js";
import {
  authorizeDelegateTarget, claimDelegateTarget, releaseDelegateTarget,
  withDelegateTargetLock,
} from "../src/core/browserTransport/sessionCoordinator.js";
import {
  DelegateMultiTabOrchestrator, type MultiTabBridge,
} from "../src/core/delegate/multiTabOrchestrator.js";

const A: AuthenticatedDelegateMcpConnection = {
  sessionId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", mode: "oauth", subject: "fixture-user",
};
const B: AuthenticatedDelegateMcpConnection = {
  sessionId: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb", mode: "oauth", subject: "fixture-user",
};
const PROFILE = "e2e-fixture-profile-01";
const target = (tabId: number) => "delegate:" + PROFILE + ":" + tabId;
let nextTabId = 1_800_000;
const freshTab = () => ++nextTabId;
const agent = (identity: AuthenticatedDelegateMcpConnection) =>
  runWithAuthenticatedDelegatePrincipal(identity, () => getDelegateMcpPrincipalId()!);
const call = (
  identity: AuthenticatedDelegateMcpConnection, command: string, tabId?: number,
  args: Record<string, unknown> = {}, payload: Record<string, unknown> = {},
) => runWithAuthenticatedDelegatePrincipal(identity, () =>
  executeDelegateChromeCommand(command, {
    ...(tabId === undefined ? {} : { targetId: target(tabId) }), ...args,
  }, payload));

function fakeBridge() {
  const clients = [{
    clientId: PROFILE, label: "fixture only", extensionId: "fixture",
    extensionVersion: "1.8.1", capabilities: ["delegate-cdp-v1"], connectedAt: Date.now(),
  }];
  vi.spyOn(delegateBridge, "listConnections").mockReturnValue(clients);
  return vi.spyOn(delegateBridge, "request").mockImplementation(async method => {
    if (method === "delegate.cdp.command") return JSON.stringify({ result: { value: 4 } });
    if (method === "delegate.cdp.list_targets") return "[]";
    return "{}";
  });
}
afterEach(() => vi.restoreAllMocks());

describe("two authenticated MCP sessions, real Delegate-CDP command boundary, fixture transport", () => {
  it("denies untrusted principals and cross-session actor spoof, isolates claims and status", async () => {
    const rpc = fakeBridge();
    const first = freshTab(), second = freshTab();
    const ownerA = agent(A), ownerB = agent(B);
    expect(ownerA).not.toBe(ownerB);
    await expect(runWithDelegateMcpBoundary(() =>
      executeDelegateChromeCommand("claim_target", { targetId: target(first) }, {})))
      .rejects.toMatchObject({ code: "DELEGATE_MCP_PRINCIPAL_REQUIRED" });
    await expect(call(B, "claim_target", first, { agentId: ownerA }))
      .rejects.toMatchObject({ code: "DELEGATE_MCP_AGENT_SPOOFED" });
    const claimedA = JSON.parse(await call(A, "claim_target", first));
    const claimedB = JSON.parse(await call(B, "claim_target", second));
    try {
      expect(claimedA.agentId).toBe(ownerA);
      expect(claimedB.agentId).toBe(ownerB);
      expect(claimedA.sessionToken).not.toBe(claimedB.sessionToken);
      await expect(call(B, "claim_target", first))
        .rejects.toMatchObject({ code: "DELEGATE_CDP_TARGET_CLAIMED" });
      await expect(call(B, "evaluate", first, {
        sessionToken: claimedA.sessionToken, expectedRevision: claimedA.revision,
      }, { expression: "2+2" })).rejects.toMatchObject({ code: "DELEGATE_CDP_TARGET_CLAIMED" });
      const visibleA = JSON.parse(await call(A, "list_sessions"));
      const visibleB = JSON.parse(await call(B, "list_sessions"));
      expect(visibleA.sessions.map((s: { tabId: number }) => s.tabId)).toContain(first);
      expect(visibleA.sessions.map((s: { tabId: number }) => s.tabId)).not.toContain(second);
      expect(visibleB.sessions.map((s: { tabId: number }) => s.tabId)).toContain(second);
      expect(visibleB.sessions.map((s: { tabId: number }) => s.tabId)).not.toContain(first);
      expect(JSON.stringify(visibleA) + JSON.stringify(visibleB))
        .not.toContain(claimedA.sessionToken);
      expect(rpc.mock.calls.filter(([method]) => method === "delegate.cdp.command")).toHaveLength(0);
    } finally {
      await call(A, "release_target", first, { sessionToken: claimedA.sessionToken });
      await call(B, "release_target", second, { sessionToken: claimedB.sessionToken });
    }
  });

  it("one-use invite, observer denial, FIFO lock, stale contributor fencing, safe owner handover", async () => {
    const rpc = fakeBridge();
    const tabId = freshTab(), ownerA = agent(A), memberB = agent(B);
    const owner = JSON.parse(await call(A, "claim_target", tabId));
    let currentOwner = ownerA, currentToken = owner.sessionToken;
    try {
      await call(A, "share_target", tabId, { sessionToken: owner.sessionToken });
      const observerInvite = JSON.parse(await call(A, "invite_agent", tabId, {
        sessionToken: owner.sessionToken, memberId: memberB, role: "observer",
      }));
      await expect(call(A, "join_target", tabId, {
        inviteId: observerInvite.inviteId, invitationToken: observerInvite.invitationToken,
        agentId: memberB,
      })).rejects.toMatchObject({ code: "DELEGATE_MCP_AGENT_SPOOFED" });
      const observer = JSON.parse(await call(B, "join_target", tabId, {
        inviteId: observerInvite.inviteId, invitationToken: observerInvite.invitationToken,
      }));
      await expect(call(B, "join_target", tabId, {
        inviteId: observerInvite.inviteId, invitationToken: observerInvite.invitationToken,
      })).rejects.toMatchObject({ code: "DELEGATE_CDP_INVITATION_INVALID" });
      await expect(call(B, "evaluate", tabId, {
        sessionToken: observer.sessionToken, expectedRevision: observer.revision,
      }, { expression: "2+2" })).rejects.toMatchObject({ code: "DELEGATE_CDP_READ_ONLY" });

      // Participant identity is the second authenticated MCP transport, not a
      // supplied agentId. Leave observer and re-invite as a contributor.
      await call(B, "leave_target", tabId, { sessionToken: observer.sessionToken });
      const writerInvite = JSON.parse(await call(A, "invite_agent", tabId, {
        sessionToken: owner.sessionToken, memberId: memberB, role: "contributor",
      }));
      const writer = JSON.parse(await call(B, "join_target", tabId, {
        inviteId: writerInvite.inviteId, invitationToken: writerInvite.invitationToken,
      }));
      // Two calls bearing the SAME revision race for the one target lock. Only
      // one operation may reach the fake CDP command, never two stale writes.
      const attempts = await Promise.allSettled([
        call(B, "evaluate", tabId, {
          sessionToken: writer.sessionToken, expectedRevision: writer.revision,
        }, { expression: "2+2" }),
        call(B, "evaluate", tabId, {
          sessionToken: writer.sessionToken, expectedRevision: writer.revision,
        }, { expression: "2+2" }),
      ]);
      expect(attempts.filter(item => item.status === "fulfilled")).toHaveLength(1);
      const rejected = attempts.filter(item => item.status === "rejected") as PromiseRejectedResult[];
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toMatchObject({ code: "DELEGATE_CDP_STALE_REVISION" });
      expect(rpc.mock.calls.filter(([method]) => method === "delegate.cdp.command")).toHaveLength(1);
      const handover = JSON.parse(await call(A, "handover_target", tabId, {
        sessionToken: owner.sessionToken, memberId: memberB,
      }));
      expect(handover.session.agentId).toBe(memberB);
      currentOwner = memberB; currentToken = writer.sessionToken;
      await expect(call(A, "release_target", tabId, {
        sessionToken: owner.sessionToken,
      })).rejects.toMatchObject({ code: "DELEGATE_CDP_OWNER_REQUIRED" });
      await expect(call(B, "evaluate", tabId, {
        sessionToken: writer.sessionToken, expectedRevision: writer.revision,
      }, { expression: "2+2" })).rejects.toMatchObject({ code: "DELEGATE_CDP_STALE_REVISION" });
      const status = JSON.parse(await call(B, "list_sessions"));
      expect(status.sessions).toEqual(expect.arrayContaining([
        expect.objectContaining({ tabId, agentId: memberB, revision: handover.session.revision }),
      ]));
    } finally {
      releaseDelegateTarget(PROFILE, tabId, currentOwner, currentToken);
    }
  });

  it("serializes cross-session operations on same tab without invoking a browser", async () => {
    const tabId = freshTab();
    const entered: string[] = [];
    let unblock!: () => void;
    let markStarted!: () => void;
    const gate = new Promise<void>(resolve => { unblock = resolve; });
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const first = runWithAuthenticatedDelegatePrincipal(A, () =>
      withDelegateTargetLock(PROFILE, tabId, async () => {
        entered.push("A:start");
        markStarted();
        await gate;
        entered.push("A:end");
      }));
    await started;
    const second = runWithAuthenticatedDelegatePrincipal(B, () =>
      withDelegateTargetLock(PROFILE, tabId, async () => { entered.push("B"); }));
    expect(entered).toEqual(["A:start"]);
    unblock();
    await Promise.all([first, second]);
    expect(entered).toEqual(["A:start", "A:end", "B"]);
  });

  it("multi-tab scheduler cannot reserve a tab already claimed by CDP", () => {
    const dir = mkdtempSync(join(tmpdir(), "delegate-two-orchestrator-"));
    const tabId = freshTab();
    const bridge: MultiTabBridge = {
      listConnections: () => [{ clientId: PROFILE }],
      request: async () => { throw new Error("fixture must not perform browser actions"); },
    };
    const scheduler = new DelegateMultiTabOrchestrator(
      bridge, join(dir, "multitab-ledger.json"), { maxConcurrent: 2, pollMs: 100 },
    );
    const claimed = claimDelegateTarget(PROFILE, tabId, agent(A));
    try {
      expect(() => scheduler.claim(PROFILE, tabId, "worker-b"))
        .toThrow("MULTITAB_CDP_TAB_CLAIMED");
    } finally {
      releaseDelegateTarget(PROFILE, tabId, agent(A), claimed.sessionToken);
    }
    try {
      const reserved = scheduler.claim(PROFILE, tabId, "worker-b");
      expect(reserved.workerId).toBe("worker-b");
      expect(() => scheduler.claim(PROFILE, tabId, "worker-a"))
        .toThrow("MULTITAB_TAB_OWNED_BY_OTHER_WORKER");
      scheduler.release(PROFILE, tabId, "worker-b");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("two distinct signed MCP forwarding envelopes cannot be spoofed, tampered or replayed", () => {
    // In-process channel material, no live key provisioning / HTTP socket.
    const channel = generateDelegateForwardedChannelMaterial();
    const sign = createDelegateForwardedSigner(channel);
    const verify = createDelegateForwardedVerifier(channel, { maxReplayEntries: 8 });
    const args = { transport: "delegate", command: "list_sessions" };
    const signedA = runWithAuthenticatedDelegatePrincipal(A, () =>
      sign("superagent_chrome_cdp", args, A));
    const signedB = runWithAuthenticatedDelegatePrincipal(B, () =>
      sign("superagent_chrome_cdp", args, B));
    expect(signedA.attestation.principalId).toBe(agent(A));
    expect(signedB.attestation.principalId).toBe(agent(B));
    expect(signedA.attestation.principalId).not.toBe(signedB.attestation.principalId);
    expect(() => sign("superagent_chrome_cdp", args, A))
      .toThrow("DELEGATE_FORWARD_PRINCIPAL_REQUIRED");
    expect(() => runWithAuthenticatedDelegatePrincipal(B, () =>
      sign("superagent_chrome_cdp", args, A)))
      .toThrow("DELEGATE_FORWARD_PRINCIPAL_REQUIRED");
    expect(verify(signedA).principalId).toBe(agent(A));
    expect(() => verify(signedA)).toThrow("DELEGATE_FORWARD_REPLAY");
    expect(() => verify({ ...signedB, arguments: { ...args, command: "evaluate" } }))
      .toThrow("DELEGATE_FORWARD_ATTESTATION_INVALID");
    expect(verify(signedB).principalId).toBe(agent(B));
    const other = createDelegateForwardedVerifier(generateDelegateForwardedChannelMaterial());
    expect(() => other(signedA)).toThrow("DELEGATE_FORWARD_ATTESTATION_INVALID");
  });

  it("simulates Core crash/failover: durable owner-only recovery fences stale writers", async () => {
    // A NEW coordinator module stands in for the next Core generation; the
    // journal is in a fresh OS temp directory, not a live durable store.
    const dir = mkdtempSync(join(tmpdir(), "delegate-two-core-epochs-"));
    const tabId = freshTab();
    const ownerId = agent(A), memberId = agent(B);
    const key = Buffer.alloc(32, 67);
    const epochA = "c".repeat(32), epochB = "d".repeat(32);
    try {
      vi.resetModules();
      const oldCore = await import("../src/core/browserTransport/sessionCoordinator.js");
      const firstJournal = createDelegateLeaseJournal({
        directory: dir, integrityKey: key, epoch: epochA,
      });
      firstJournal.initialize();
      oldCore.configureDelegateLeaseJournal(firstJournal);
      const owner = oldCore.claimDelegateTarget(PROFILE, tabId, ownerId);
      oldCore.setDelegateSharing(PROFILE, tabId, ownerId, owner.sessionToken, true);
      const invite = oldCore.inviteDelegateAgent(
        PROFILE, tabId, ownerId, owner.sessionToken, memberId, "contributor",
      );
      const contributor = oldCore.joinDelegateTarget(
        PROFILE, tabId, memberId, invite.inviteId, invite.invitationToken,
      );
      const oldRevision = contributor.revision;

      // A second Core epoch is ambiguous until an independent supervisor
      // explicitly attests the first writer is retired.
      const ambiguous = createDelegateLeaseJournal({
        directory: dir, integrityKey: key, epoch: epochB,
      });
      expect(() => ambiguous.recover(
        PROFILE, tabId, ownerId, owner.sessionToken, firstJournal.read().sequence,
      )).toThrowError(expect.objectContaining({ code: "DELEGATE_LEASE_EPOCH_AMBIGUOUS" }));

      vi.resetModules();
      const nextCore = await import("../src/core/browserTransport/sessionCoordinator.js");
      nextCore.configureDelegateLeaseJournal(createDelegateLeaseJournal({
        directory: dir, integrityKey: key, epoch: epochB,
        // This callback is a TEST fixture, not actual live process attestation.
        previousEpochRetired: previous => previous === epochA,
      }));
      expect(() => nextCore.authorizeDelegateTarget(
        PROFILE, tabId, ownerId, owner.sessionToken,
      )).toThrowError(expect.objectContaining({ code: "DELEGATE_LEASE_STALE" }));
      // Rejected pre-recovery reads stay fail-closed without blocking a later
      // explicit recovery. An invalid member or wrong token gets no ownership.
      expect(() => nextCore.recoverDelegateTarget(
        PROFILE, tabId, memberId, owner.sessionToken,
      )).toThrowError(expect.objectContaining({ code: "DELEGATE_LEASE_RECOVERY_DENIED" }));
      expect(() => nextCore.recoverDelegateTarget(
        PROFILE, tabId, ownerId, "stolen-but-not-the-owner-token",
      )).toThrowError(expect.objectContaining({ code: "DELEGATE_LEASE_RECOVERY_DENIED" }));
      const recovered = nextCore.recoverDelegateTarget(
        PROFILE, tabId, ownerId, owner.sessionToken,
      );
      expect(recovered.recoveryRequired).toBe(false);
      expect(recovered.revision).toBe(oldRevision + 1);
      expect(() => nextCore.authorizeDelegateTarget(
        PROFILE, tabId, memberId, contributor.sessionToken, true, oldRevision,
      )).toThrowError(expect.objectContaining({ code: "DELEGATE_CDP_STALE_REVISION" }));
      nextCore.authorizeDelegateTarget(
        PROFILE, tabId, memberId, contributor.sessionToken, true, recovered.revision,
      );
      expect(() => oldCore.authorizeDelegateTarget(
        PROFILE, tabId, ownerId, owner.sessionToken,
      )).toThrowError(expect.objectContaining({ code: "DELEGATE_LEASE_STALE" }));
      nextCore.releaseDelegateTarget(PROFILE, tabId, ownerId, owner.sessionToken);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { delegateBridge } from "../src/core/delegate/bridge.js";
import { executeDelegateChromeCommand } from "../src/core/delegate/cdpTransport.js";
import {
  authorizeDelegateTarget, claimDelegateTarget, getDelegateParticipation,
  handoverDelegateTarget, heartbeatDelegateSession, inviteDelegateAgent,
  joinDelegateTarget, leaveDelegateTarget, listDelegateSessions,
  noteDelegateWriteSuccess, releaseDelegateTarget, revokeDelegateAgent,
  setDelegateSharing, withDelegateTargetLock,
} from "../src/core/browserTransport/sessionCoordinator.js";

let nextTab = 501000;
const tab = () => ++nextTab;
const A = "chrome-test-profile-A";
const B = "chrome-test-profile-B";

afterEach(() => vi.restoreAllMocks());

function owner(clientId = A, tabId = tab(), agentId = "orchestrator-a") {
  return claimDelegateTarget(clientId, tabId, agentId);
}

function delegateRpcMock() {
  vi.spyOn(delegateBridge, "listConnections").mockReturnValue([{
    clientId: A, label: "Test", extensionId: "a".repeat(32),
    extensionVersion: "1.8.1", capabilities: ["delegate-cdp-v1"], connectedAt: Date.now(),
  }]);
  return vi.spyOn(delegateBridge, "request").mockImplementation(async (method) => {
    if (method === "delegate.cdp.command") return JSON.stringify({ result: { value: 4 } });
    if (method === "delegate.cdp.list_targets") return "[]";
    return "{}";
  });
}

describe("Delegate-CDP multiple orchestrator sessions (isolated mocks)", () => {
  it("isolates ownership across two browser profiles and independent tabs", () => {
    const target = tab();
    const first = owner(A, target, "agent-a");
    const second = owner(A, target + 1, "agent-b");
    const third = owner(B, target, "agent-c");
    expect(first.targetId).not.toBe(second.targetId);
    expect(first.targetId).not.toBe(third.targetId);
    expect(() => authorizeDelegateTarget(A, target, "agent-b", second.sessionToken, true))
      .toThrow(/claimed/i);
    authorizeDelegateTarget(A, target + 1, "agent-b", second.sessionToken, true);
    authorizeDelegateTarget(B, target, "agent-c", third.sessionToken, true);
    expect(listDelegateSessions()).toEqual(expect.arrayContaining([
      expect.objectContaining({ targetId: first.targetId, agentId: "agent-a" }),
      expect.objectContaining({ targetId: second.targetId, agentId: "agent-b" }),
      expect.objectContaining({ targetId: third.targetId, agentId: "agent-c" }),
    ]));
    releaseDelegateTarget(A, target, "agent-a", first.sessionToken);
    releaseDelegateTarget(A, target + 1, "agent-b", second.sessionToken);
    releaseDelegateTarget(B, target, "agent-c", third.sessionToken);
  });

  it("uses one-time invite capabilities with exact participant identity", () => {
    const target = tab();
    const own = owner(A, target);
    expect(() => inviteDelegateAgent(A, target, "orchestrator-a", own.sessionToken, "guest", "observer"))
      .toThrow(/sharing/i);
    setDelegateSharing(A, target, "orchestrator-a", own.sessionToken, true);
    const invite = inviteDelegateAgent(A, target, "orchestrator-a", own.sessionToken, "guest", "observer");
    expect(invite).toEqual(expect.objectContaining({ inviteId: expect.any(String), invitationToken: expect.any(String) }));
    expect(() => joinDelegateTarget(A, target, "imposter", invite.inviteId, invite.invitationToken))
      .toThrow(/invitation/i);
    const joined = joinDelegateTarget(A, target, "guest", invite.inviteId, invite.invitationToken);
    expect(joined.role).toBe("observer");
    expect(joined).not.toHaveProperty("tokenHash");
    expect(() => joinDelegateTarget(A, target, "guest", invite.inviteId, invite.invitationToken))
      .toThrow(/invitation/i);
    expect(getDelegateParticipation(A, target, "guest", joined.sessionToken).participants)
      .toEqual(expect.arrayContaining([expect.objectContaining({ agentId: "guest", role: "observer" })]));
    releaseDelegateTarget(A, target, "orchestrator-a", own.sessionToken);
  });

  it("prevents observer writes and requires a matching revision for contributors", () => {
    const target = tab();
    const own = owner(A, target);
    setDelegateSharing(A, target, "orchestrator-a", own.sessionToken, true);
    const observe = inviteDelegateAgent(A, target, "orchestrator-a", own.sessionToken, "watcher", "observer");
    const watcher = joinDelegateTarget(A, target, "watcher", observe.inviteId, observe.invitationToken);
    authorizeDelegateTarget(A, target, "watcher", watcher.sessionToken, false);
    expect(() => authorizeDelegateTarget(A, target, "watcher", watcher.sessionToken, true, watcher.revision))
      .toThrow(/observer|read-only/i);
    expect(() => authorizeDelegateTarget(A, target, "watcher", watcher.sessionToken, false, undefined, true))
      .toThrow(/owner/i);
    const invite = inviteDelegateAgent(A, target, "orchestrator-a", own.sessionToken, "writer", "contributor");
    const writer = joinDelegateTarget(A, target, "writer", invite.inviteId, invite.invitationToken);
    expect(() => authorizeDelegateTarget(A, target, "writer", writer.sessionToken, true))
      .toThrow(/revision/i);
    authorizeDelegateTarget(A, target, "writer", writer.sessionToken, true, writer.revision);
    noteDelegateWriteSuccess(A, target, "writer", writer.sessionToken);
    expect(() => authorizeDelegateTarget(A, target, "writer", writer.sessionToken, true, writer.revision))
      .toThrow(/stale revision/i);
    releaseDelegateTarget(A, target, "orchestrator-a", own.sessionToken);
  });

  it("invalidates revoked and unshared capability tokens immediately", () => {
    const target = tab();
    const own = owner(A, target);
    setDelegateSharing(A, target, "orchestrator-a", own.sessionToken, true);
    const invitation = inviteDelegateAgent(A, target, "orchestrator-a", own.sessionToken, "guest", "contributor");
    const joined = joinDelegateTarget(A, target, "guest", invitation.inviteId, invitation.invitationToken);
    heartbeatDelegateSession(A, target, "guest", joined.sessionToken);
    revokeDelegateAgent(A, target, "orchestrator-a", own.sessionToken, "guest");
    expect(() => authorizeDelegateTarget(A, target, "guest", joined.sessionToken)).toThrow(/claimed/i);
    const fresh = inviteDelegateAgent(A, target, "orchestrator-a", own.sessionToken, "guest", "observer");
    const again = joinDelegateTarget(A, target, "guest", fresh.inviteId, fresh.invitationToken);
    setDelegateSharing(A, target, "orchestrator-a", own.sessionToken, false);
    expect(() => authorizeDelegateTarget(A, target, "guest", again.sessionToken)).toThrow(/claimed/i);
    releaseDelegateTarget(A, target, "orchestrator-a", own.sessionToken);
  });

  it("requires a joined contributor for ownership handover and revokes the prior owner", () => {
    const target = tab();
    const own = owner(A, target);
    setDelegateSharing(A, target, "orchestrator-a", own.sessionToken, true);
    const invite = inviteDelegateAgent(A, target, "orchestrator-a", own.sessionToken, "writer", "contributor");
    const writer = joinDelegateTarget(A, target, "writer", invite.inviteId, invite.invitationToken);
    const next = handoverDelegateTarget(A, target, "orchestrator-a", own.sessionToken, "writer");
    expect(next.agentId).toBe("writer");
    expect(() => authorizeDelegateTarget(A, target, "orchestrator-a", own.sessionToken)).toThrow(/claimed/i);
    authorizeDelegateTarget(A, target, "writer", writer.sessionToken, true, next.revision, true);
    expect(() => releaseDelegateTarget(A, target, "orchestrator-a", own.sessionToken)).toThrow(/owner/i);
    releaseDelegateTarget(A, target, "writer", writer.sessionToken);
  });

  it("serializes same-tab writes and rejects a concurrent stale contributor revision before CDP RPC", async () => {
    const request = delegateRpcMock();
    const target = tab();
    const own = owner(A, target);
    setDelegateSharing(A, target, "orchestrator-a", own.sessionToken, true);
    const invite = inviteDelegateAgent(A, target, "orchestrator-a", own.sessionToken, "writer", "contributor");
    const writer = joinDelegateTarget(A, target, "writer", invite.inviteId, invite.invitationToken);
    const args = {
      targetId: own.targetId, agentId: "writer",
      sessionToken: writer.sessionToken, expectedRevision: writer.revision,
    };
    const results = await Promise.allSettled([
      executeDelegateChromeCommand("evaluate", args, { expression: "2+2" }),
      executeDelegateChromeCommand("evaluate", args, { expression: "2+2" }),
    ]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
    expect(String((results.find(r => r.status === "rejected") as PromiseRejectedResult).reason))
      .toMatch(/stale revision/i);
    expect(request.mock.calls.filter(c => c[0] === "delegate.cdp.command")).toHaveLength(1);
    releaseDelegateTarget(A, target, "orchestrator-a", own.sessionToken);
  });

  it("routes shared snapshot and owner-only tab commands through capability checks", async () => {
    const request = delegateRpcMock();
    const target = tab();
    const own = owner(A, target);
    setDelegateSharing(A, target, "orchestrator-a", own.sessionToken, true);
    const invite = inviteDelegateAgent(A, target, "orchestrator-a", own.sessionToken, "watcher", "observer");
    const watcher = joinDelegateTarget(A, target, "watcher", invite.inviteId, invite.invitationToken);
    const scope = { targetId: own.targetId, agentId: "watcher", sessionToken: watcher.sessionToken };
    const snapshot = await executeDelegateChromeCommand("shared_snapshot", scope, {});
    expect(snapshot).toMatch(/snapshot/i);
    await expect(executeDelegateChromeCommand("activate", scope, {})).rejects.toMatchObject({
      code: "DELEGATE_CDP_OWNER_REQUIRED",
    });
    expect(request.mock.calls.filter(c => c[0] === "delegate.cdp.tab_action")).toHaveLength(0);
    leaveDelegateTarget(A, target, "watcher", watcher.sessionToken);
    releaseDelegateTarget(A, target, "orchestrator-a", own.sessionToken);
  });
});

import { describe, expect, test } from "bun:test";
import { executeDelegateChromeCommand } from "../src/core/delegate/cdpTransport.js";
import { dispatchChromeMcpTool } from "../src/core/mcp/tools/chromeMcpTools.js";
import {
  runWithAuthenticatedDelegatePrincipal, runWithDelegateMcpBoundary,
  resolveDelegatePrincipalAgent, assertDelegateMcpActorForCommand,
  visibleDelegateSessions, getDelegateMcpPrincipalId,
} from "../src/core/browserTransport/delegatePrincipalPolicy.js";
import {
  claimDelegateTarget, authorizeDelegateTarget, noteDelegateWriteSuccess,
  setDelegateSharing, inviteDelegateAgent, joinDelegateTarget, releaseDelegateTarget,
} from "../src/core/browserTransport/sessionCoordinator.js";

const identity = (id: string) => ({ sessionId: id, mode: "oauth" as const, subject: "verified-user" });
const a = identity("aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa");
const b = identity("bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb");

describe("Delegate MCP authenticated principal boundary (isolated coordinator, no Chrome)", () => {
  test("two distinct verified MCP sessions cannot spoof the other's owner ID", () => {
    const owner = runWithAuthenticatedDelegatePrincipal(a, () => resolveDelegatePrincipalAgent(undefined, undefined, true)!);
    const other = runWithAuthenticatedDelegatePrincipal(b, () => resolveDelegatePrincipalAgent(undefined, undefined, true)!);
    expect(owner).not.toBe(other);
    expect(owner).toMatch(/^mcp-[a-f0-9]{32}$/);
    runWithAuthenticatedDelegatePrincipal(b, () => {
      expect(() => resolveDelegatePrincipalAgent(owner, undefined, true)).toThrow("agentId");
      expect(() => resolveDelegatePrincipalAgent(undefined, owner, true)).toThrow("agentId");
    });
    runWithAuthenticatedDelegatePrincipal(a, () => {
      expect(resolveDelegatePrincipalAgent(owner, owner, true)).toBe(owner);
      expect(getDelegateMcpPrincipalId()).toBe(owner);
    });
  });

  test("MCP calls without trusted context fail closed while legacy local actor remains supported", () => {
    runWithDelegateMcpBoundary(() => {
      expect(() => assertDelegateMcpActorForCommand("claim_target", "forged", undefined)).toThrow("verified MCP");
      expect(() => assertDelegateMcpActorForCommand("navigate", undefined, undefined)).toThrow("verified MCP");
      expect(assertDelegateMcpActorForCommand("list_targets", undefined, undefined)).toBeUndefined();
      expect(visibleDelegateSessions([{agentId:"legacy"}])).toEqual([]);
    });
    expect(resolveDelegatePrincipalAgent("legacy", undefined, true)).toBe("legacy");
    expect(() => runWithAuthenticatedDelegatePrincipal(
      { sessionId: "fake", mode: "oauth", subject: "test" }, () => "ok")).toThrow("Verified");
  });

  test("owner token and agent ID cannot cross tabs, profiles, or MCP principals", () => {
    const profileA = "profileAlpha123", profileB = "profileBravo123";
    const owner = runWithAuthenticatedDelegatePrincipal(a, () => resolveDelegatePrincipalAgent(undefined, undefined, true)!);
    const intruder = runWithAuthenticatedDelegatePrincipal(b, () => resolveDelegatePrincipalAgent(undefined, undefined, true)!);
    const claimed = claimDelegateTarget(profileA, 98721, owner);
    try {
      authorizeDelegateTarget(profileA, 98721, owner, claimed.sessionToken, true, 0);
      expect(() => authorizeDelegateTarget(profileA, 98721, intruder, claimed.sessionToken, true, 0)).toThrow();
      expect(() => authorizeDelegateTarget(profileB, 98721, owner, claimed.sessionToken, true, 0)).toThrow();
      expect(() => authorizeDelegateTarget(profileA, 98722, owner, claimed.sessionToken, true, 0)).toThrow();
      noteDelegateWriteSuccess(profileA, 98721, owner, claimed.sessionToken);
      expect(() => authorizeDelegateTarget(profileA, 98721, owner, claimed.sessionToken, true, 0)).toThrow("stale revision");
      authorizeDelegateTarget(profileA, 98721, owner, claimed.sessionToken, true, 1);
    } finally { releaseDelegateTarget(profileA, 98721, owner, claimed.sessionToken); }
  });

  test("shared owner and invited participant retain their roles under distinct principals", () => {
    const owner = runWithAuthenticatedDelegatePrincipal(a, () => resolveDelegatePrincipalAgent(undefined, undefined, true)!);
    const member = runWithAuthenticatedDelegatePrincipal(b, () => resolveDelegatePrincipalAgent(undefined, undefined, true)!);
    const c = claimDelegateTarget("profileOwner123", 98723, owner);
    try {
      setDelegateSharing("profileOwner123", 98723, owner, c.sessionToken, true);
      const invite = inviteDelegateAgent("profileOwner123", 98723, owner, c.sessionToken, member, "observer");
      const joined = joinDelegateTarget("profileOwner123", 98723, member, invite.inviteId, invite.invitationToken);
      authorizeDelegateTarget("profileOwner123", 98723, member, joined.sessionToken, false);
      expect(() => authorizeDelegateTarget("profileOwner123", 98723, member, joined.sessionToken, true, joined.revision)).toThrow();
      expect(visibleDelegateSessions([{agentId:owner, participants:[{agentId:member}]}]).length).toBe(1);
      runWithAuthenticatedDelegatePrincipal(b, () => {
        expect(visibleDelegateSessions([{agentId:owner, participants:[{agentId:member}]}]).length).toBe(1);
      });
      runWithAuthenticatedDelegatePrincipal(a, () => {
        expect(resolveDelegatePrincipalAgent(owner, undefined, true)).toBe(owner);
      });
    } finally { releaseDelegateTarget("profileOwner123", 98723, owner, c.sessionToken); }
  });

  test("conflicting outer and payload agent IDs are never silently resolved", () => {
    expect(() => resolveDelegatePrincipalAgent("agentA", "agentB", false)).toThrow("Conflicting");
  });
});


describe("Delegate-CDP selected target and MCP tool boundaries (no live browser)", () => {
  test("qualified target cannot be redirected to a different profile or tab", async () => {
    const targetId = "delegate:profileAlpha123:92751";
    await expect(executeDelegateChromeCommand("snapshot",
      { targetId, delegateClientId: "profileBravo123" }, {})).rejects.toThrow("profile selector");
    await expect(executeDelegateChromeCommand("snapshot",
      { targetId, delegateTabId: 92752 }, {})).rejects.toThrow("tab selector");
    await expect(executeDelegateChromeCommand("snapshot",
      { targetId: "delegate:profileAlpha123:92751" },
      { targetId: "delegate:profileAlpha123:92752" })).rejects.toThrow("targetId");
    await expect(executeDelegateChromeCommand("snapshot",
      { targetId: "delegate:profileAlpha123:92751", delegateTabId: 92751 },
      { delegateTabId: 92752 })).rejects.toThrow("tab selector");
  });

  test("unbound MCP cannot create a claimed session and cannot substitute stolen identity", async () => {
    await runWithDelegateMcpBoundary(async () => {
      await expect(executeDelegateChromeCommand("claim_target",
        { targetId: "delegate:profileAlpha123:92753" }, {})).rejects.toThrow("verified MCP");
    });
    await runWithAuthenticatedDelegatePrincipal(a, async () => {
      await expect(executeDelegateChromeCommand("list_sessions", { agentId: "attacker" }, {}))
        .rejects.toThrow("agentId");
    });
  });

  test("list_sessions hides other claimed profiles and never reveals capabilities", async () => {
    const owner = runWithAuthenticatedDelegatePrincipal(a, () => getDelegateMcpPrincipalId()!);
    const other = runWithAuthenticatedDelegatePrincipal(b, () => getDelegateMcpPrincipalId()!);
    const own = claimDelegateTarget("profileAlpha123", 92754, owner);
    const unrelated = claimDelegateTarget("profileBravo123", 92755, other);
    try {
      const data = await runWithAuthenticatedDelegatePrincipal(a, async () =>
        JSON.parse(await executeDelegateChromeCommand("list_sessions", {}, {})));
      expect(data.sessions.some((s: any) => s.tabId === 92754)).toBe(true);
      expect(data.sessions.some((s: any) => s.tabId === 92755)).toBe(false);
      expect(JSON.stringify(data)).not.toContain("sessionToken");
      const unknown = await runWithDelegateMcpBoundary(async () =>
        JSON.parse(await executeDelegateChromeCommand("list_sessions", {}, {})));
      expect(unknown.sessions).toEqual([]);
    } finally {
      releaseDelegateTarget("profileAlpha123", 92754, owner, own.sessionToken);
      releaseDelegateTarget("profileBravo123", 92755, other, unrelated.sessionToken);
    }
  });
});


test("public MCP dispatcher rejects forged actor before forwarding any Core RPC", async () => {
  const args = {
    command: "claim_target", transport: "delegate",
    targetId: "delegate:profileAlpha123:92781", agentId: "another-mcp-session",
  };
  const unbound = await dispatchChromeMcpTool("superagent_chrome_cdp", args);
  expect(unbound?.isError).toBe(true);
  expect(unbound?.content?.[0]?.text).toContain("verified MCP");
  const spoofed = await dispatchChromeMcpTool("superagent_chrome_cdp", args, a);
  expect(spoofed?.isError).toBe(true);
  expect(spoofed?.content?.[0]?.text).toContain("agentId does not match");
});

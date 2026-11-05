import { describe, expect, it } from "vitest";
import {
  authorizeDelegateTarget, claimDelegateTarget, listDelegateSessions, noteDelegateWriteSuccess, releaseDelegateTarget, withDelegateTargetLock,
} from "../src/core/browserTransport/sessionCoordinator.js";

describe("Delegate browser session coordinator", () => {
  it("requires an explicit claim when agentId is supplied", () => {
    expect(() => authorizeDelegateTarget("chrome-unclaimed-001", 6999, "agent-a", undefined, true))
      .toThrow(/claim_target/i);
  });

  it("serializes operations on the same unclaimed Delegate tab", async () => {
    const order: string[] = [];
    let unblock!: () => void;
    const hold = new Promise<void>((resolve) => { unblock = resolve; });
    const first = withDelegateTargetLock("chrome-lock-001", 7000, async () => {
      order.push("first-start");
      await hold;
      order.push("first-end");
    });
    await Promise.resolve();
    const second = withDelegateTargetLock("chrome-lock-001", 7000, async () => {
      order.push("second");
    });
    await Promise.resolve();
    expect(order).toEqual(["first-start"]);
    unblock();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "first-end", "second"]);
  });

  it("issues secret capability, renews owner, and rejects competing mutation", () => {
    const clientId = "chrome-session-001";
    const tabId = 7001;
    const first = claimDelegateTarget(clientId, tabId, "agent-a");
    expect(first.sessionToken).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(first).not.toHaveProperty("tokenHash");
    expect(() => authorizeDelegateTarget(clientId, tabId, "agent-b", "wrong", true))
      .toThrow(/claimed/i);
    const renewed = claimDelegateTarget(clientId, tabId, "agent-a", first.sessionToken);
    expect(renewed.sessionToken).toBe(first.sessionToken);
    authorizeDelegateTarget(clientId, tabId, "agent-a", first.sessionToken, true, 0);
    noteDelegateWriteSuccess(clientId, tabId, "agent-a", first.sessionToken);
    expect(listDelegateSessions().find(s => s.clientId === clientId && s.tabId === tabId)?.revision).toBe(1);
    expect(() => authorizeDelegateTarget(clientId, tabId, "agent-a", first.sessionToken, true, 0))
      .toThrow(/stale revision/i);
    authorizeDelegateTarget(clientId, tabId, "agent-a", first.sessionToken, true, 1);
    releaseDelegateTarget(clientId, tabId, "agent-a", first.sessionToken);
    expect(listDelegateSessions().some(s => s.clientId === clientId && s.tabId === tabId)).toBe(false);
  });
});

import { afterEach, describe, expect, it } from "vitest";
import {
  claimDelegateTarget,
  listDelegateSessions,
  revokeDelegateTargetByHuman,
  releaseDelegateTarget,
} from "../../src/core/browserTransport/sessionCoordinator.js";

const client="tray-test-client-001";
const tab=901;
afterEach(async()=>{
  const current=listDelegateSessions().find(x=>x.clientId===client&&x.tabId===tab);
  // A test-owned lease can be closed only with its token; every successful test
  // below explicitly releases/revokes it, so an unowned lease signals a failure.
  if(current)throw Error("Leaked test-owned Delegate tab claim");
});
describe("human takes over exactly one Delegate tab, not the browser profile",()=>{
  it("rejects stale revisions, then revokes one claimed tab without closing Chrome",async()=>{
    const claimed=claimDelegateTarget(client,tab,"agent-workspace-one");
    expect(claimed.revision).toBe(0);
    expect(listDelegateSessions().some(x=>x.clientId===client&&x.tabId===tab)).toBe(true);
    await expect(revokeDelegateTargetByHuman(client,tab,1)).rejects.toThrow("revocation");
    expect(listDelegateSessions().some(x=>x.clientId===client&&x.tabId===tab)).toBe(true);
    expect(await revokeDelegateTargetByHuman(client,tab,0)).toBe(true);
    expect(listDelegateSessions().some(x=>x.clientId===client&&x.tabId===tab)).toBe(false);
    expect(()=>releaseDelegateTarget(client,tab,"agent-workspace-one",claimed.sessionToken)).toThrow();
  });
  it("requires exact client identity and revision, never revokes an arbitrary tab",async()=>{
    await expect(revokeDelegateTargetByHuman("../evil",tab,0)).rejects.toThrow();
    await expect(revokeDelegateTargetByHuman(client,-3,0)).rejects.toThrow();
    await expect(revokeDelegateTargetByHuman(client,tab,0)).rejects.toThrow();
  });
});

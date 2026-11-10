import {afterEach,describe,expect,test} from "vitest";
import {
  managedCdpLiveDigest, watchManagedCdpLive, activeManagedCdpLiveConnections,
} from "../src/core/tools/chromeCdpLiveFeed.js";

const base = (queued:number, observedAt=Date.now()) => ({
  status:"known" as const, observedAt, sessions:[], truncated:false,
  summary:{agents:0,tabs:0,queued,busy:0},
});
describe("native authenticated managed CDP change feed",()=>{
  afterEach(()=>expect(activeManagedCdpLiveConnections()).toBe(0));
  test("ignores refresh timestamp; never fabricates changed events",async()=>{
    const first=base(0,1000);
    expect(managedCdpLiveDigest(first)).toBe(managedCdpLiveDigest(base(0,9999)));
    const result=await watchManagedCdpLive(null,{read:async()=>first as any,waitMs:0});
    expect(result.status).toBe("changed");
    expect(result.cursor).toMatch(/^[a-f0-9]{64}$/);
    const unchanged=await watchManagedCdpLive(result.cursor,{read:async()=>base(0) as any,waitMs:20});
    expect(unchanged.status).toBe("heartbeat");
  });
  test("wakes on real state change and preserves ordering",async()=>{
    const first=base(0),second=base(1);
    const since=managedCdpLiveDigest(first);
    let calls=0;
    const result=await watchManagedCdpLive(since,{waitMs:1000,
      read:async()=>++calls>=2 ? second as any : first as any});
    expect(result.status).toBe("changed");
    expect(result.managedCdp.summary.queued).toBe(1);
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(result.cursor).not.toBe(since);
  });
  test("rejects invalid cursor and terminates disconnected consumers",async()=>{
    await expect(watchManagedCdpLive("private-token",{waitMs:0})).rejects.toThrow(/cursor/);
    const controller=new AbortController();
    controller.abort();
    await expect(watchManagedCdpLive(managedCdpLiveDigest(base(0)),
      {signal:controller.signal,read:async()=>base(0) as any,waitMs:500}))
      .rejects.toThrow(/disconnected/);
  });
});

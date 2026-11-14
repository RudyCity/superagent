import {describe,expect,it,vi} from "vitest";
import {
  observeMcpTunnelAnchor,type AnchorObserverDependencies,
} from "../src/core/runtime/mcpTunnelAnchorObserver.js";

const port=19320,ownerPort=19321;
const nonce="a".repeat(64);
const anchor={
  version:1 as const,kind:"mcp_tunnel_anchor" as const,
  pid:21001,port,createdAt:1794610000000,
  publicUrl:"https://stable-observer.trycloudflare.com/mcp",
  nonce,tunnelPid:21002,
};
const owner={
  version:1 as const,kind:"managed_mcp_tunnel_owner" as const,
  pid:21003,port:ownerPort,createdAt:1794610000100,
  nonce:"b".repeat(64),workspace:"C:\\stage",
};
const tunnel={
  pid:anchor.tunnelPid,port,startedAt:anchor.createdAt,
  localUrl:"http://127.0.0.1:"+port,serviceKind:"mcp-http" as const,
  publicUrl:"https://stable-observer.trycloudflare.com",
};
const proof={
  pid:anchor.pid,port,startedAt:anchor.createdAt,
  publicUrl:anchor.publicUrl,tunnelPid:anchor.tunnelPid,
  currentOwnerPid:owner.pid,currentOwnerPort:ownerPort,
  inFlightRequests:0,ready:true,
};
const status={
  version:1 as const,kind:"private_mcp_owner" as const,
  pid:owner.pid,port:ownerPort,startedAt:owner.createdAt,
  mode:"managed-tunnel" as const,
  activeSessions:0,inFlightRequests:0,
  draining:false,inflightToolEffects:"unknown" as const,
  safeToolsOnly:true,oauthEnabled:false,publicTunnelStarted:true as const,
  reloadable:true,backendHealthy:true,backendPid:21004,
  publicUrl:anchor.publicUrl,ingressMode:"external-anchor",
};
function harness():AnchorObserverDependencies{
  return {
    readAnchorLease:vi.fn(()=>anchor),
    probeAnchor:vi.fn(async()=>proof),
    readTunnel:vi.fn(()=>tunnel),
    verifyTunnel:vi.fn(async()=>true),
    readOwnerLease:vi.fn(()=>owner),
    readListeners:vi.fn(()=>new Map([[ownerPort,owner.pid]])),
    verifyOwnerBirth:vi.fn(()=>true),
    probeOwner:vi.fn(async()=>status),
  };
}
describe("read-only independent MCP Anchor observation",()=>{
  it("verifies local tunnel/owner identities without promising public reachability",async()=>{
    const deps=harness();
    const result=await observeMcpTunnelAnchor(port,deps);
    expect(result).toMatchObject({
      level:"verified_local",code:"ANCHOR_VERIFIED_LOCAL",port,
      publicUrl:anchor.publicUrl,anchorPid:anchor.pid,tunnelPid:anchor.tunnelPid,
      ownerPid:owner.pid,operatorReviewRequired:false,
      noAutomaticTunnelRestart:true,remoteEdgeCertified:false,
    });
    expect(JSON.stringify(result)).not.toContain(nonce);
    expect(deps.verifyTunnel).toHaveBeenCalledExactlyOnceWith(
      anchor.tunnelPid,"http://127.0.0.1:"+port);
  });
  it("never adopts a missing or unreadable anchor lease",async()=>{
    expect((await observeMcpTunnelAnchor(port,{
      ...harness(),readAnchorLease:()=>null,
    })).code).toBe("ANCHOR_LEASE_UNAVAILABLE");
    const unavailable=await observeMcpTunnelAnchor(port,{
      ...harness(),probeAnchor:async()=>{throw Error("unverified")},
    });
    expect(unavailable).toMatchObject({
      level:"unavailable",code:"ANCHOR_IDENTITY_UNVERIFIED",
      publicUrl:null,operatorReviewRequired:true,
    });
  });
  it("rejects a tunnel PID, URL, or target change even with a valid lease",async()=>{
    const invalid=await observeMcpTunnelAnchor(port,{
      ...harness(),readTunnel:()=>({...tunnel,pid:90999}),
    });
    expect(invalid.code).toBe("TUNNEL_STATE_MISMATCH");
    const rerouted=await observeMcpTunnelAnchor(port,{
      ...harness(),readTunnel:()=>({...tunnel,localUrl:"http://127.0.0.1:9888"}),
    });
    expect(rerouted.code).toBe("TUNNEL_STATE_MISMATCH");
    const rotated=await observeMcpTunnelAnchor(port,{
      ...harness(),readTunnel:()=>({...tunnel,publicUrl:"https://changed.trycloudflare.com"}),
    });
    expect(rotated.code).toBe("TUNNEL_STATE_MISMATCH");
  });
  it("fails closed when cloudflared identity cannot be attested",async()=>{
    const deps=harness();
    deps.verifyTunnel=vi.fn(async()=>false);
    const result=await observeMcpTunnelAnchor(port,deps);
    expect(result).toMatchObject({
      level:"degraded",code:"TUNNEL_PROCESS_UNVERIFIED",
      noAutomaticTunnelRestart:true,
    });
    expect(deps.probeOwner).not.toHaveBeenCalled();
  });
  it("reports a verified empty Anchor as unattached, not a healthy service",async()=>{
    const result=await observeMcpTunnelAnchor(port,{
      ...harness(),probeAnchor:async()=>({
        ...proof,currentOwnerPid:null,currentOwnerPort:null,ready:false,
      }),
    });
    expect(result).toMatchObject({
      level:"unattached",code:"ANCHOR_UNATTACHED",
      operatorReviewRequired:false,
    });
  });
  it("rejects stale owner leases and foreign listener PIDs",async()=>{
    const wrongLease=await observeMcpTunnelAnchor(port,{
      ...harness(),readOwnerLease:()=>({...owner,pid:99999}),
    });
    expect(wrongLease.code).toBe("OWNER_LEASE_UNVERIFIED");
    const foreignListener=await observeMcpTunnelAnchor(port,{
      ...harness(),readListeners:()=>new Map([[ownerPort,99999]]),
    });
    expect(foreignListener.code).toBe("OWNER_PROCESS_UNVERIFIED");
    const falseBirth=await observeMcpTunnelAnchor(port,{
      ...harness(),verifyOwnerBirth:()=>false,
    });
    expect(falseBirth.code).toBe("OWNER_PROCESS_UNVERIFIED");
  });
  it("rejects untrusted, unhealthy, drained or non-persistent OAuth owner",async()=>{
    const missing=await observeMcpTunnelAnchor(port,{
      ...harness(),probeOwner:async()=>null,
    });
    expect(missing.code).toBe("OWNER_STATUS_UNVERIFIED");
    const unhealthy=await observeMcpTunnelAnchor(port,{
      ...harness(),probeOwner:async()=>({...status,backendHealthy:false}),
    });
    expect(unhealthy.code).toBe("OWNER_NOT_SERVING");
    const drained=await observeMcpTunnelAnchor(port,{
      ...harness(),probeOwner:async()=>({...status,draining:true}),
    });
    expect(drained.code).toBe("OWNER_NOT_SERVING");
    const memoryOAuth=await observeMcpTunnelAnchor(port,{
      ...harness(),probeOwner:async()=>({
        ...status,oauthEnabled:true,oauthStatePersistent:false,
      }),
    });
    expect(memoryOAuth.code).toBe("OWNER_NOT_SERVING");
  });
  it("never reports external named Cloudflare connector as verified from a local lease",async()=>{
    const result=await observeMcpTunnelAnchor(port,{
      ...harness(),readAnchorLease:()=>({...anchor,tunnelMode:"named-external",tunnelPid:null}),
      probeAnchor:async()=>({...proof,tunnelPid:null}),
    });
    expect(result).toMatchObject({level:"degraded",code:"NAMED_CONNECTOR_UNVERIFIED",
      operatorReviewRequired:true,remoteEdgeCertified:false});
  });
  it("rejects invalid or protected observer ports",async()=>{
    await expect(observeMcpTunnelAnchor(7888,harness()))
      .rejects.toThrow("MCP_ANCHOR_OBSERVER_INVALID_PORT");
  });
});

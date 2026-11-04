import {describe,it,expect} from "vitest";
import {manageServices} from "../src/core/runtime/serviceManager.js";
import {planOwnedTunnelStop,stopOwnedTunnel} from "../src/core/runtime/ownedTunnelLifecycle.js";

describe("destructive public Quick Tunnel management refuses unsafe operations",()=>{
  it("cannot create a tunnel stop plan without an exact verified cloudflared owner",async()=>{
    await expect(planOwnedTunnelStop("rest_tunnel",19931))
      .rejects.toThrow("TUNNEL_NO_MATCHING_OWNED_SERVICE");
    await expect(manageServices({action:"plan",service:"muse_tunnel",port:19931,targetAction:"stop"}))
      .rejects.toThrow("TUNNEL_NO_MATCHING_OWNED_SERVICE");
  });
  it("rejects stop unless the operator separately acknowledges URL disruption",async()=>{
    const options={
      service:"rest_tunnel" as const,action:"stop",port:19931,confirm:true,
      operationId:"tunnel-safe-stop-unique-0001",
      expectedOwnerPid:21111,
      expectedPublicUrl:"https://fake.trycloudflare.com",
      expectedLocalUrl:"http://127.0.0.1:19931",
      allowPublicDisruption:false,
    };
    await expect(manageServices(options))
      .rejects.toThrow("SERVICE_PUBLIC_TUNNEL_STOP_PLAN_AND_ACK_REQUIRED");
    await expect(stopOwnedTunnel(options))
      .rejects.toThrow("TUNNEL_EXPLICIT_PUBLIC_DISRUPTION_APPROVAL_REQUIRED");
    await expect(stopOwnedTunnel({...options,allowPublicDisruption:true,confirm:false}))
      .rejects.toThrow("TUNNEL_EXPLICIT_PUBLIC_DISRUPTION_APPROVAL_REQUIRED");
    await expect(stopOwnedTunnel({...options,allowPublicDisruption:true}))
      .rejects.toThrow("TUNNEL_NO_MATCHING_OWNED_SERVICE");
  });
  it("never offers automatic URL-changing tunnel restart",async()=>{
    const result=await manageServices({
      action:"plan",service:"muse_tunnel",port:19931,targetAction:"restart",
    }) as any;
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("SERVICE_UNSUPPORTED_MUTATION");
  });
});

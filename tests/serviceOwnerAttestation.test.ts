import {describe,expect,it} from "vitest";
import {summarizeServiceOwnerAttestation} from "../src/core/runtime/serviceOwnerAttestation.js";
import type {ServiceStatus} from "../src/core/runtime/serviceManager.js";
const a="a".repeat(64),b="b".repeat(64);
const status=(v:Partial<ServiceStatus>={}):ServiceStatus=>({
  service:"core",port:7888,state:"active",ownerPid:123,
  ownershipVerified:true,actions:["status"],reason:"verified",
  details:{activeBuildDigest:a,sourceBuildDigest:a},...v,
});
describe("owner_status fail-closed parity",()=>{
  it("never treats a known PID as owner verification",()=>{
    const result=summarizeServiceOwnerAttestation([status({ownershipVerified:false})]);
    expect(result.services[0]).toMatchObject({code:"HOST_OWNER_UNVERIFIED",
      ready:false,owner:{verified:false,pid:null}});
  });
  it("separates stale source from missing build and unstarted Tray",()=>{
    const result=summarizeServiceOwnerAttestation([
      status({details:{activeBuildDigest:b,sourceBuildDigest:a}}),
      status({service:"mcp",details:{backendReleaseDigest:null}}),
      status({service:"tray",state:"inactive",ownerPid:null,ownershipVerified:false}),
    ]);
    expect(result.services.map(x=>x.code)).toEqual([
      "SOURCE_CHANGED_NOT_LOADED","RUNTIME_DIGEST_UNAVAILABLE","NOT_RUNNING"]);
    expect(result.ready).toBe(false);
  });
  it("requires WebView resource digest, not version alone",()=>{
    expect(summarizeServiceOwnerAttestation([status({service:"tray",details:{
      installedReleaseDigest:a,sourceBuildDigest:a}})]).services[0].code)
      .toBe("WEBVIEW_DIGEST_UNAVAILABLE");
    expect(summarizeServiceOwnerAttestation([status({service:"tray",details:{
      installedReleaseDigest:a,sourceBuildDigest:a,webviewBundleDigest:b}})]).ready).toBe(true);
  });
  it("never leaks arbitrary paths, tokens, private details or operation IDs",()=>{
    const result=summarizeServiceOwnerAttestation([status({details:{
      sourceBuildDigest:a,activeBuildDigest:a,exePath:"DO_NOT_ECHO_PATH",
      authToken:"DO_NOT_ECHO_SECRET"}})]);
    expect(JSON.stringify(result)).not.toMatch(/DO_NOT_ECHO|operationId/);
    expect(result.readOnly).toBe(true);
  });
});

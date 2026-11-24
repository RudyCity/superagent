import {describe,expect,it,vi} from "vitest";
import {summarizeServiceOwnerAttestation,observeVerifiedServiceProcessBirth} from "../src/core/runtime/serviceOwnerAttestation.js";
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
      installedReleaseDigest:a,sourceBuildDigest:a,webviewBundleDigest:b}})])
      .services[0].code).toBe("SOURCE_REVISION_UNAVAILABLE");
    expect(summarizeServiceOwnerAttestation([status({service:"tray",details:{
      installedReleaseDigest:a,sourceBuildDigest:a,webviewBundleDigest:b,
      sourceRevision:"c".repeat(40),loadedSourceRevision:"d".repeat(40)}})])
      .services[0].code).toBe("SOURCE_CHANGED_NOT_LOADED");
    expect(summarizeServiceOwnerAttestation([status({service:"tray",details:{
      installedReleaseDigest:a,sourceBuildDigest:a,webviewBundleDigest:b,
      sourceRevision:"c".repeat(40),loadedSourceRevision:"c".repeat(40)}})]).ready)
      .toBe(true);
  });
  it("does not compare a local workspace build with the immutable release-slot digest",()=>{
    const row=summarizeServiceOwnerAttestation([status({service:"tray",details:{
      installedReleaseDigest:a,sourceBuildDigest:b,runtimeKind:"workspace-build",
      webviewBundleDigest:b,sourceRevision:"c".repeat(40),
      loadedSourceRevision:"c".repeat(40),
    }})]).services[0];
    expect(row).toMatchObject({code:"OWNER_BUILD_ATTESTED",ready:true,
      build:{runtimeDigest:a,sourceDigest:b,runtimeKind:"workspace-build"}});
  });
  it("still rejects an active release whose running binary differs from the active slot",()=>{
    const row=summarizeServiceOwnerAttestation([status({service:"tray",details:{
      installedReleaseDigest:a,sourceBuildDigest:b,runtimeKind:"active-release",
      webviewBundleDigest:b,sourceRevision:"c".repeat(40),
      loadedSourceRevision:"c".repeat(40),
    }})]).services[0];
    expect(row.code).toBe("SOURCE_CHANGED_NOT_LOADED");
    expect(row.ready).toBe(false);
  });
  it("still detects a workspace binary compiled from a different checkout revision",()=>{
    const row=summarizeServiceOwnerAttestation([status({service:"tray",details:{
      installedReleaseDigest:a,sourceBuildDigest:b,runtimeKind:"workspace-build",
      webviewBundleDigest:b,sourceRevision:"c".repeat(40),
      loadedSourceRevision:"d".repeat(40),
    }})]).services[0];
    expect(row.code).toBe("SOURCE_CHANGED_NOT_LOADED");
  });
  it("never leaks arbitrary paths, tokens, private details or operation IDs",()=>{
    const result=summarizeServiceOwnerAttestation([status({details:{
      sourceBuildDigest:a,activeBuildDigest:a,exePath:"DO_NOT_ECHO_PATH",
      authToken:"DO_NOT_ECHO_SECRET"}})]);
    expect(JSON.stringify(result)).not.toMatch(/DO_NOT_ECHO|operationId/);
    expect(result.readOnly).toBe(true);
  });
  it("keeps observed birth, authenticated supervisor and native signer evidence independent",()=>{
    const row=summarizeServiceOwnerAttestation([status({details:{activeBuildDigest:a,sourceBuildDigest:a,
      observedProcessBirthIdentity:"win:638991234567890123",supervisorLifecycleVersion:2,
      activeWorkerPid:456,activeWorkerSince:123456,activeWorkerBuildMode:"compiled"}})]).services[0];
    expect(row.owner.processBirth).toEqual({state:"observed",identity:"win:638991234567890123",observationOnly:true});
    expect(row.supervisor).toEqual({state:"authenticated",safeLifecycleVersion:2});
    expect(row.build.worker).toEqual({pid:456,since:123456,mode:"compiled"});
    expect(row.nativeSigner).toEqual({state:"unknown",reasonCode:"NATIVE_SIGNER_NOT_ATTESTED"});
    expect(row.ready).toBe(true);
    expect(row.releaseCertified).toBe(false);
    expect(row.mutationAuthorized).toBe(false);
    expect(row.evidenceComplete).toBe(false);
  });
  it("does not reflect forged or missing process evidence or grant authority from a fingerprint",()=>{
    const row=summarizeServiceOwnerAttestation([status({ownershipVerified:false,details:{
      observedProcessBirthIdentity:"win:638991234567890123",supervisorLifecycleVersion:2,
      activeWorkerPid:456,activeWorkerSince:123456,activeWorkerBuildMode:"compiled",
      nativeSigner:"PRIVATE_PATH_OR_SIGNER",activeBuildDigest:a,sourceBuildDigest:a}})]).services[0];
    expect(row.owner.processBirth).toEqual({state:"unknown",identity:null,observationOnly:true});
    expect(row.supervisor).toEqual({state:"unknown",safeLifecycleVersion:null});
    expect(row.build.worker).toEqual({pid:null,since:null,mode:null});
    expect(row.nativeSigner.state).toBe("unknown");
    expect(JSON.stringify(row)).not.toContain("PRIVATE_PATH_OR_SIGNER");
    expect(row.ready).toBe(false);
    const malformed=summarizeServiceOwnerAttestation([status({details:{
      observedProcessBirthIdentity:"C:/PRIVATE_PATH_OR_SIGNER",activeWorkerPid:-1,activeWorkerSince:-1}})]).services[0];
    expect(malformed.owner.processBirth).toEqual({state:"unknown",identity:null,observationOnly:true});
    expect(JSON.stringify(malformed)).not.toContain("PRIVATE_PATH_OR_SIGNER");
  });
  it("observes birth only for a verified positive owner and keeps unavailable evidence unknown",async()=>{
    const read=vi.fn(async()=>null);
    const rows=[status(),status({ownershipVerified:false,ownerPid:456}),status({ownerPid:null})];
    const observed=await observeVerifiedServiceProcessBirth(rows,read);
    expect(read).toHaveBeenCalledExactlyOnceWith(123);
    expect(rows[0].details).not.toHaveProperty("observedProcessBirthIdentity");
    expect(summarizeServiceOwnerAttestation(observed).services.every(row=>row.owner.processBirth.state==="unknown")).toBe(true);
    expect(observed[1]).toBe(rows[1]);
  });
  it("bounds unavailable OS birth probes without leaking errors or claiming complete attestation",async()=>{
    const observed=await observeVerifiedServiceProcessBirth([status()],async()=>{throw new Error("C:/PRIVATE_OS_PATH_AND_TOKEN");});
    const report=summarizeServiceOwnerAttestation(observed);
    expect(report.services[0].owner.processBirth).toEqual({state:"unknown",identity:null,observationOnly:true});
    expect(report.evidenceComplete).toBe(false);
    expect(JSON.stringify(report)).not.toContain("PRIVATE_OS_PATH_AND_TOKEN");
  });
});

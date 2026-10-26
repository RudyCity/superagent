/**
 * R6 threat/chaos regression matrix. Deliberately non-mutating:
 * security gates are tested using synthesized adverse evidence, never by
 * terminating a live listener or requesting production OAuth credentials.
 */
import {describe,it,expect} from "vitest";
import {assessRuntimeRollout,type RuntimeRolloutEvidence}
  from "../src/core/runtime/runtimeReleaseGateR7.js";
import {assessRuntimeColdRecovery,type RuntimeColdRecoveryEvidence}
  from "../src/core/runtime/runtimeColdRecoveryR5.js";
import {isPermittedMcpIngressPath}
  from "../src/core/runtime/mcpIngressStage.js";
import {isR1OwnerToolCallAllowed}
  from "../src/core/mcp/mcpSafeOwnerPolicy.js";
import {assessMcpOAuthMigration}
  from "../src/core/runtime/mcpOAuthMigrationPolicy.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const verified: RuntimeRolloutEvidence={
  topology:{
    ownershipTopology:"separate_owners_needs_operator_review",
    core:{port:58911,listenerPid:14200,
      state:"verified_supervisor",authenticatedSupervisorPid:14200},
    mcp:[{port:58912,recordedPid:14201,listenerPid:14201,
      state:"os_pid_correlated_only",authMode:"oauth",
      authenticationVerified:true,sessionsDrainVerified:true}],
  },
  privateOAuthIssuerVerified:true,windowsKeystoreAndAclVerified:true,
  liveIssuerTlsVerified:true,separateIngressVerified:true,
  desktopNativeE2EVerified:true,extendedSoakVerified:true,
  oauthClientsReauthorized:true,legacyMcpSessions:0,pendingExternalEffects:0,
  reversibleClientRoutingVerified:true,operatorApprovalForLiveCutover:true,
};
describe("R6 release gate adversarial matrix",()=>{
  it("blocks on each absent production certificate even if others are satisfied",()=>{
    const critical=(Object.keys(verified) as (keyof RuntimeRolloutEvidence)[])
      .filter(k=>typeof verified[k]==="boolean");
    for(const key of critical){
      const candidate={...verified,[key]:false};
      const decision=assessRuntimeRollout(candidate);
      expect(decision.status,key).toBe("blocked");
      expect(decision.blockers.length,key).toBeGreaterThan(0);
      expect(decision.decisions.automaticLiveCutoverAllowed).toBe(false);
    }
  });
  it("refuses unknown, pending or malformed external effect counts",()=>{
    for(const pending of [null,1,75]){
      const result=assessRuntimeRollout({...verified,pendingExternalEffects:pending});
      expect(result.status).toBe("blocked");
      expect(result.blockers).toContain("UNKNOWN_EXTERNAL_TOOL_EFFECTS");
    }
    for(const sessions of [null,1,3]){
      expect(assessRuntimeRollout({...verified,legacyMcpSessions:sessions})
        .blockers).toContain("LEGACY_SESSION_DRAIN_NOT_PROVEN");
    }
    expect(()=>assessRuntimeRollout({...verified,pendingExternalEffects:-1})).toThrow();
  });
  it("never interprets a synthetically complete review as permission to terminate processes",()=>{
    const result=assessRuntimeRollout(verified);
    expect(result.status).toBe("manual_cutover_review_candidate");
    expect(Object.values(result.decisions).every(value=>value===false)).toBe(true);
    const shared=assessRuntimeRollout({...verified,topology:{
      ...verified.topology,ownershipTopology:"shared_owner_do_not_cutover",
    }});
    expect(shared.status).toBe("blocked");
    expect(shared.blockers).toContain("LEGACY_CORE_AND_MCP_SHARE_PROCESS");
    const unknownMcp=assessRuntimeRollout({...verified,topology:{
      ...verified.topology,
      mcp:[{...verified.topology.mcp[0],sessionsDrainVerified:false}],
    }});
    expect(unknownMcp.blockers).toContain("MCP_AUTHENTICATION_OR_DRAIN_NOT_VERIFIED");
  });
});
const goodBoot:RuntimeColdRecoveryEvidence={
 coreCheckpoint:"absent",coreOwner:"absent",mcpOwner:"absent",
 oauthStorage:"integrity_verified",ingressOwner:"absent",
 pendingExternalEffects:0,stalePidReused:false,
};
describe("R6 Windows restart/crash threat matrix",()=>{
  it("requires manual review for every independent unknown/reused/corrupt owner",()=>{
    for(const changed of [
      {coreCheckpoint:"stale_or_corrupt"},
      {coreOwner:"unverified"},
      {mcpOwner:"stale_or_unverified"},
      {oauthStorage:"corrupt_or_key_missing"},
      {ingressOwner:"stale_or_unverified"},
      {pendingExternalEffects:null},
      {pendingExternalEffects:1},
      {stalePidReused:true},
    ] as Array<Partial<RuntimeColdRecoveryEvidence>>){
      const d=assessRuntimeColdRecovery({...goodBoot,...changed});
      expect(d.status,JSON.stringify(changed)).toBe("manual_review");
      expect(d.canRestartProduction).toBe(false);
      expect(d.automaticToolReplayAllowed).toBe(false);
      expect(d.canAdoptLegacyProcess).toBe(false);
    }
  });
  it("even an idealized cold boot may only launch isolated staging probe",()=>{
    const d=assessRuntimeColdRecovery(goodBoot);
    expect(d.status).toBe("isolated_staging_probe_candidate");
    expect(d.canRestoreMcpSession).toBe(false);
    expect(d.canRestartProduction).toBe(false);
  });
});
describe("R6 transport and cross-workspace attack coverage",()=>{
  it("rejects overlong, escaped, or internal MCP ingress targets",()=>{
    for(const target of [
      "/_internal/owner/status","/api/chat","/api/status",
      "/mcp/../_internal/owner/status", "/mcp%2F..%2Fapi/status",
      "/mcp%5c..%5capi/status","/oauth/token/../../api/status",
      "/mcp"+"x".repeat(3000),"/mcp%00",
    ]) expect(isPermittedMcpIngressPath("GET",target),target).toBe(false);
    expect(isPermittedMcpIngressPath("POST","/oauth/token")).toBe(true);
    expect(isPermittedMcpIngressPath("GET","/oauth/token")).toBe(false);
  });
  it("blocks external/symlinked paths for the independent local MCP owner",()=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),"r6-owned-"));
    const outsider=fs.mkdtempSync(path.join(os.tmpdir(),"r6-external-"));
    try{
      fs.writeFileSync(path.join(dir,"ok.txt"),"ok");
      fs.writeFileSync(path.join(outsider,"private.txt"),"not part of test profile");
      const bad=path.join(outsider,"private.txt");
      expect(isR1OwnerToolCallAllowed("superagent_read_files",
        {files:[bad]},dir)).toBe(false);
      expect(isR1OwnerToolCallAllowed("superagent_read_files",
        {files:["ok.txt"],workspace:outsider},dir)).toBe(false);
      expect(isR1OwnerToolCallAllowed("superagent_exec_command",{},dir)).toBe(false);
      expect(isR1OwnerToolCallAllowed("superagent_grant_project_access",{},dir)).toBe(false);
      expect(isR1OwnerToolCallAllowed("superagent_tool_execute",
        {name:"superagent_read_files",arguments:{files:[bad]}},dir)).toBe(true);
      expect(isR1OwnerToolCallAllowed("superagent_read_files",{files:[bad]},dir)).toBe(false);
    }finally{
      fs.rmSync(dir,{recursive:true,force:true});
      fs.rmSync(outsider,{recursive:true,force:true});
    }
  });
  it("blocks legacy OAuth session/token inheritance regardless of entitlement",()=>{
    const d=assessMcpOAuthMigration({
      sharedLegacyCoreOwner:false,independentOwnerVerified:true,
      newIssuerConfigured:true,publicMcpEndpointMatched:true,
      clientsReauthorized:true,activeLegacySessions:0,pendingToolEffects:0,
      rollbackPathVerified:true,operatorApproved:true,
    });
    expect(d.tokenExportPermitted).toBe(false);
    expect(d.liveSessionTransferPermitted).toBe(false);
    expect(d.automaticCutoverPermitted).toBe(false);
  });
});

import {describe,it,expect} from "vitest";
import {assessRuntimeColdRecovery} from "../src/core/runtime/runtimeColdRecoveryR5.js";
import {assessRuntimeRollout} from "../src/core/runtime/runtimeReleaseGateR7.js";
const boot={coreCheckpoint:"absent",coreOwner:"absent",
  mcpOwner:"absent",oauthStorage:"absent",
  ingressOwner:"absent",pendingExternalEffects:0,
  stalePidReused:false} as const;
describe("R5 cold reboot never replays unfinished work",()=>{
 it("treats completely fresh isolated boot as staging-only review candidate",()=>{
  const v=assessRuntimeColdRecovery(boot);
  expect(v.status).toBe("isolated_staging_probe_candidate");
  expect(v.canRestartProduction).toBe(false);
  expect(v.automaticToolReplayAllowed).toBe(false);
 });
 it("rejects dead owner and ambiguous external tool effects",()=>{
  const v=assessRuntimeColdRecovery({
   ...boot,coreCheckpoint:"stale_or_corrupt",
   coreOwner:"unverified",mcpOwner:"stale_or_unverified",
   oauthStorage:"corrupt_or_key_missing",ingressOwner:"stale_or_unverified",
   pendingExternalEffects:null,stalePidReused:true});
  expect(v.status).toBe("manual_review");
  expect(v.blockers).toContain("KERNEL_PID_REUSE_DETECTED");
  expect(v.blockers).toContain("OAUTH_STORAGE_OR_KEY_UNVERIFIED");
  expect(v.blockers).toContain("EXTERNAL_EFFECTS_UNRECONCILED");
  expect(v.canAdoptLegacyProcess).toBe(false);
 });
});
const topology={
 ownershipTopology:"shared_owner_do_not_cutover" as const,
 core:{port:7888,listenerPid:13424,state:"unverified" as const,
   authenticatedSupervisorPid:null},
 mcp:[{port:6789,recordedPid:13424,listenerPid:13424,
   authMode:"oauth" as const,state:"os_pid_correlated_only" as const,
   authenticationVerified:false as const,sessionsDrainVerified:false as const}],
};
describe("R6/R7 live cutover certificate",()=>{
 it("refuses production with shared owner even if canary stages pass",()=>{
  const report=assessRuntimeRollout({
    topology,privateOAuthIssuerVerified:true,
    windowsKeystoreAndAclVerified:false,liveIssuerTlsVerified:false,
    separateIngressVerified:true,desktopNativeE2EVerified:false,
    extendedSoakVerified:false,oauthClientsReauthorized:false,
    legacyMcpSessions:null,pendingExternalEffects:null,
    reversibleClientRoutingVerified:false,operatorApprovalForLiveCutover:false,
  });
  expect(report.status).toBe("blocked");
  expect(report.blockers).toContain("LEGACY_CORE_AND_MCP_SHARE_PROCESS");
  expect(report.blockers).toContain("OS_KEYSTORE_AND_ACL_NOT_CERTIFIED");
  expect(report.blockers).toContain("INSTALLED_TLINE_E2E_NOT_CERTIFIED");
  expect(report.decisions).toMatchObject({automaticLiveCutoverAllowed:false,
    oauthTokenImportAllowed:false,canStopSharedCorePid:false});
 });
});

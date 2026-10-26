import {describe,expect,it} from "vitest";
import {assessRuntimeColdRecovery} from "../src/core/runtime/runtimeColdRecoveryR5.js";
import type {RuntimeColdRecoveryEvidence} from "../src/core/runtime/runtimeColdRecoveryR5.js";
const fresh:RuntimeColdRecoveryEvidence={
 coreCheckpoint:"absent",coreOwner:"absent",
 mcpOwner:"absent",oauthStorage:"absent",ingressOwner:"absent",
 pendingExternalEffects:0,stalePidReused:false,
};
describe("R5 Windows cold recovery deny-by-default matrix",()=>{
 it("never authorizes production restart, MCP session import or unknown tool replay",()=>{
  const d=assessRuntimeColdRecovery(fresh);
  expect(d.status).toBe("isolated_staging_probe_candidate");
  expect(d).toMatchObject({canRestartProduction:false,canRestoreMcpSession:false,
   canAdoptLegacyProcess:false,automaticToolReplayAllowed:false});
 });
 it("blocks unknown or pending external effects after reboot",()=>{
  for(const count of [null,1,23]){
   const d=assessRuntimeColdRecovery({...fresh,pendingExternalEffects:count});
   expect(d.blockers).toContain("EXTERNAL_EFFECTS_UNRECONCILED");
  }
 });
 it("rejects reused Windows PID even with otherwise clean stage evidence",()=>{
  const d=assessRuntimeColdRecovery({...fresh,stalePidReused:true});
  expect(d.status).toBe("manual_review");
  expect(d.blockers).toContain("KERNEL_PID_REUSE_DETECTED");
 });
 it("does not adopt checkpoint workers without authenticated supervisor",()=>{
  const d=assessRuntimeColdRecovery({...fresh,
   coreCheckpoint:"valid_surviving_workers",coreOwner:"absent"});
  expect(d.blockers).toContain("CHECKPOINT_WORKER_OWNERSHIP_NOT_AUTHENTICATED");
 });
 it("does not boot from stale owner or corrupted OAuth storage metadata",()=>{
  const d=assessRuntimeColdRecovery({...fresh,
   coreOwner:"unverified",mcpOwner:"stale_or_unverified",
   oauthStorage:"corrupt_or_key_missing",ingressOwner:"stale_or_unverified",
   coreCheckpoint:"stale_or_corrupt"});
  expect(d.status).toBe("manual_review");
  expect(d.blockers).toContain("CORE_OWNER_IDENTITY_UNVERIFIED");
  expect(d.blockers).toContain("MCP_OWNER_LEASE_UNVERIFIED");
  expect(d.blockers).toContain("OAUTH_STORAGE_OR_KEY_UNVERIFIED");
  expect(d.blockers).toContain("INGRESS_OWNER_UNVERIFIED");
  expect(d.blockers).toContain("CORE_CHECKPOINT_REQUIRES_RECONCILIATION");
 });
 it("refuses malformed external-effect counters before making any decision",()=>{
  for(const pendingExternalEffects of [-1,1.5,NaN,Infinity]){
   expect(()=>assessRuntimeColdRecovery({...fresh,pendingExternalEffects}))
    .toThrow(/Invalid pending/);
  }
 });
});

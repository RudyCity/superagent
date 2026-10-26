/**
 * R5 fail-closed boot/reboot decision across independent runtime owners.
 * Hardware reboot cannot be simulated by creating a new PID. Unknown
 * external side effects always require explicit operator reconciliation.
 */
export interface RuntimeColdRecoveryEvidence {
  coreCheckpoint:"absent"|"valid_surviving_workers"|"stale_or_corrupt";
  coreOwner:"absent"|"authenticated"|"unverified";
  mcpOwner:"absent"|"authenticated"|"stale_or_unverified";
  oauthStorage:"absent"|"integrity_verified"|"corrupt_or_key_missing";
  ingressOwner:"absent"|"authenticated"|"stale_or_unverified";
  pendingExternalEffects:number|null;
  stalePidReused:boolean;
}
export interface RuntimeColdRecoveryDecision {
  version:1;phase:"cold_reboot_preflight";
  status:"manual_review"|"isolated_staging_probe_candidate";
  blockers:string[];
  automaticToolReplayAllowed:false;
  canAdoptLegacyProcess:false;
  canRestoreMcpSession:false;
  canRestartProduction:false;
}
export function assessRuntimeColdRecovery(
  e:RuntimeColdRecoveryEvidence,
):RuntimeColdRecoveryDecision {
  if(e.pendingExternalEffects!==null &&
     (!Number.isSafeInteger(e.pendingExternalEffects)||e.pendingExternalEffects<0))
    throw new Error("Invalid pending external-effect count");
  const blockers:string[]=[];
  if(e.coreCheckpoint==="stale_or_corrupt")blockers.push("CORE_CHECKPOINT_REQUIRES_RECONCILIATION");
  if(e.coreOwner==="unverified")blockers.push("CORE_OWNER_IDENTITY_UNVERIFIED");
  if(e.mcpOwner==="stale_or_unverified")blockers.push("MCP_OWNER_LEASE_UNVERIFIED");
  if(e.oauthStorage==="corrupt_or_key_missing")blockers.push("OAUTH_STORAGE_OR_KEY_UNVERIFIED");
  if(e.ingressOwner==="stale_or_unverified")blockers.push("INGRESS_OWNER_UNVERIFIED");
  if(e.pendingExternalEffects===null||e.pendingExternalEffects>0)
    blockers.push("EXTERNAL_EFFECTS_UNRECONCILED");
  if(e.stalePidReused)blockers.push("KERNEL_PID_REUSE_DETECTED");
  if(e.coreCheckpoint==="valid_surviving_workers"&&e.coreOwner!=="authenticated")
    blockers.push("CHECKPOINT_WORKER_OWNERSHIP_NOT_AUTHENTICATED");
  return {version:1,phase:"cold_reboot_preflight",
    status:blockers.length?"manual_review":"isolated_staging_probe_candidate",
    blockers,automaticToolReplayAllowed:false,
    canAdoptLegacyProcess:false,canRestoreMcpSession:false,
    canRestartProduction:false};
}

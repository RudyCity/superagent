/**
 * Phase 5h — owner-scoped service lifecycle policy.
 * A restart recommendation is not a process signal. No foreign process, auth
 * token, API request or scheduled task is changed by this module.
 */
export type CoreService = "core_guardian"|"core_supervisor"|"tline_frontdoor"|
  "channel_host"|"mcp_tunnel"|"muse"|"telegram";
export type ServiceCondition = "healthy"|"degraded"|"unknown"|"dead";
export interface ServiceEvidence {
  service:CoreService; condition:ServiceCondition;
  ownership:"verified_local"|"external"|"unverified";
  consecutiveHealthFailures:number; checkpointProtected:boolean;
}
export interface ServiceLifecycleInstruction {
  service:CoreService;
  action:"observe"|"read_only_probe"|"operator_review"|"review_guarded_recovery";
  reason:string; mayKillProcess:false; mayRestartExternalChannel:false;
  retryBudget:number;
}
const external=new Set<CoreService>(["mcp_tunnel","muse","telegram"]);
export function evaluateCoreServiceLifecycle(e:ServiceEvidence):ServiceLifecycleInstruction {
  if(!Number.isInteger(e.consecutiveHealthFailures)||e.consecutiveHealthFailures<0||
     e.consecutiveHealthFailures>1_000_000) throw new Error("Invalid health sample counter");
  const finish=(action:ServiceLifecycleInstruction["action"],reason:string,retryBudget=0):
      ServiceLifecycleInstruction=>({service:e.service,action,reason,
        mayKillProcess:false,mayRestartExternalChannel:false,retryBudget});
  if(external.has(e.service)||e.ownership==="external")
    return finish("observe","EXTERNAL_CHANNEL_OWNER_OUTSIDE_CORE_LIFECYCLE");
  if(e.ownership!=="verified_local")
    return finish("operator_review","UNKNOWN_PROCESS_OWNERSHIP");
  if(e.condition==="healthy") return finish("observe","VERIFIED_HEALTHY");
  if(e.condition==="unknown"||e.consecutiveHealthFailures<3)
    return finish("read_only_probe","HEALTH_FAILURE_NOT_VERIFIED",Math.max(0,3-e.consecutiveHealthFailures));
  if(e.checkpointProtected) return finish("operator_review","CHECKPOINT_OR_SIDE_EFFECT_RECONCILIATION_REQUIRED");
  if(e.service==="core_guardian" || e.service==="core_supervisor")
    return finish("review_guarded_recovery","REQUIRES_ORIGINAL_WORKER_AUTH_AND_RETRY_BUDGET",3);
  return finish("operator_review","NON_CORE_SERVICE_NEEDS_OWN_LIFECYCLE_MANAGER");
}
export interface ServiceLifecyclePlan {
  version:1; activation:"manual_preview_only";
  services:CoreService[]; startOrder:CoreService[];
  stopOrder:CoreService[];
  automaticToolReplayAllowed:false;
  schedulerInstalled:false; externalChannelRestartAllowed:false;
}
export function buildCoreLifecyclePlan():ServiceLifecyclePlan {
  const startOrder:CoreService[]=["tline_frontdoor","channel_host","core_guardian","core_supervisor"];
  return {version:1,activation:"manual_preview_only",
    services:[...startOrder,"mcp_tunnel","muse","telegram"],
    startOrder,stopOrder:[...startOrder].reverse(),
    automaticToolReplayAllowed:false,schedulerInstalled:false,externalChannelRestartAllowed:false};
}

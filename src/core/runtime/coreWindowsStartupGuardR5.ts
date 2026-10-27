import type { CoreColdAssessment } from "./coreColdStartPolicy.js";
export interface WindowsStartupRegistrationEvidenceR5 {
  port:number; stageProfileVerified:boolean; ownerInventoryVerified:boolean;
  listenerPid:number|null; scheduledTaskPresent:boolean|null; coldAssessment:CoreColdAssessment;
  productionRequested?:boolean; supervisedCoreVerified?:boolean; guardianVerified?:boolean;
  independentMcpVerified?:boolean;
}
export interface WindowsStartupRegistrationDecisionR5 {
  version:1; status:"staging_registration_candidate"|"production_registration_candidate"|"blocked";
  blockers:string[]; productionApproved:boolean; startScheduledTaskAllowed:false; automaticReplayAllowed:false;
}
export function assessWindowsStartupRegistrationR5(e:WindowsStartupRegistrationEvidenceR5):WindowsStartupRegistrationDecisionR5 {
  const blockers:string[]=[]; const production=e.productionRequested===true;
  if(!Number.isSafeInteger(e.port)||e.port<1024||e.port>65535) blockers.push("INVALID_PORT");
  if(production){
    if(e.port!==7888) blockers.push("PRODUCTION_CORE_PORT_MUST_BE_7888");
    if(!e.supervisedCoreVerified) blockers.push("SUPERVISED_CORE_NOT_VERIFIED");
    if(!e.guardianVerified) blockers.push("CORE_GUARDIAN_NOT_VERIFIED");
    if(!e.independentMcpVerified) blockers.push("INDEPENDENT_MCP_OWNERS_NOT_VERIFIED");
    if(!e.ownerInventoryVerified||e.listenerPid===null) blockers.push("LIVE_CORE_LISTENER_NOT_VERIFIED");
    if(e.coldAssessment.decision!=="already_running") blockers.push("LIVE_CORE_COLD_AUDIT_NOT_ALREADY_RUNNING");
  }else{
    if([6789,7888,9877].includes(e.port)) blockers.push("LEGACY_OR_INVALID_PORT_PROHIBITED");
    if(!e.stageProfileVerified) blockers.push("ISOLATED_PROFILE_NOT_VERIFIED");
    if(!e.ownerInventoryVerified||e.listenerPid!==null) blockers.push("TCP_OWNER_FREE_NOT_VERIFIED");
    if(e.coldAssessment.decision!=="fresh_guard_allowed"||
       e.coldAssessment.automaticToolReplay!==false||e.coldAssessment.mayDeleteCheckpoint!==false)
      blockers.push("COLD_START_NAMESPACE_UNSAFE");
  }
  if(e.scheduledTaskPresent!==false) blockers.push("SCHEDULED_TASK_ABSENCE_NOT_VERIFIED");
  if(e.coldAssessment.automaticToolReplay!==false) blockers.push("AUTOMATIC_REPLAY_MUST_REMAIN_DISABLED");
  return {version:1,
    status:blockers.length?"blocked":production?"production_registration_candidate":"staging_registration_candidate",
    blockers,productionApproved:production&&blockers.length===0,
    startScheduledTaskAllowed:false,automaticReplayAllowed:false};
}

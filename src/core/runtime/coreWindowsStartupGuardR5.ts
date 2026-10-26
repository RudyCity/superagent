/**
 * Fail-closed per-user Windows Scheduled Task registration policy.
 * This only authorizes a NEW isolated staging task, never production startup.
 */
import type {CoreColdAssessment} from "./coreColdStartPolicy.js";

export interface WindowsStartupRegistrationEvidenceR5 {
  port:number;
  stageProfileVerified:boolean;
  ownerInventoryVerified:boolean;
  listenerPid:number|null;
  scheduledTaskPresent:boolean|null;
  coldAssessment:CoreColdAssessment;
}
export interface WindowsStartupRegistrationDecisionR5 {
  version:1;status:"staging_registration_candidate"|"blocked";
  blockers:string[];productionApproved:false;
  startScheduledTaskAllowed:false;automaticReplayAllowed:false;
}
export function assessWindowsStartupRegistrationR5(
  evidence:WindowsStartupRegistrationEvidenceR5,
):WindowsStartupRegistrationDecisionR5{
  const blockers:string[]=[];
  if(!Number.isSafeInteger(evidence.port)||evidence.port<1024||evidence.port>65535||
     [6789,7888,9877].includes(evidence.port))
    blockers.push("LEGACY_OR_INVALID_PORT_PROHIBITED");
  if(!evidence.stageProfileVerified)blockers.push("ISOLATED_PROFILE_NOT_VERIFIED");
  if(!evidence.ownerInventoryVerified||evidence.listenerPid!==null)
    blockers.push("TCP_OWNER_FREE_NOT_VERIFIED");
  if(evidence.scheduledTaskPresent!==false)
    blockers.push("SCHEDULED_TASK_ABSENCE_NOT_VERIFIED");
  if(evidence.coldAssessment.decision!=="fresh_guard_allowed"||
     evidence.coldAssessment.automaticToolReplay!==false||
     evidence.coldAssessment.mayDeleteCheckpoint!==false)
    blockers.push("COLD_START_NAMESPACE_UNSAFE");
  return {version:1,
    status:blockers.length?"blocked":"staging_registration_candidate",
    blockers,productionApproved:false,
    startScheduledTaskAllowed:false,automaticReplayAllowed:false};
}

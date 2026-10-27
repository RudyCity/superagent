/**
 * Fail-closed Windows Scheduled Task registration policy.
 * Staging remains the default. Production registration requires an explicit
 * production request plus an already authenticated supervised Core/guardian.
 */
import type { CoreColdAssessment } from "./coreColdStartPolicy.js";

export interface WindowsStartupRegistrationEvidenceR5 {
  port: number;
  stageProfileVerified: boolean;
  ownerInventoryVerified: boolean;
  listenerPid: number | null;
  scheduledTaskPresent: boolean | null;
  coldAssessment: CoreColdAssessment;
  productionRequested?: boolean;
  supervisedCoreVerified?: boolean;
  guardianVerified?: boolean;
  independentMcpVerified?: boolean;
}

export interface WindowsStartupRegistrationDecisionR5 {
  version: 1;
  status: "staging_registration_candidate" | "production_registration_candidate" | "blocked";
  blockers: string[];
  productionApproved: boolean;
  startScheduledTaskAllowed: false;
  automaticReplayAllowed: false;
}

export function assessWindowsStartupRegistrationR5(
  evidence: WindowsStartupRegistrationEvidenceR5,
): WindowsStartupRegistrationDecisionR5 {
  const blockers: string[] = [];
  const production = evidence.productionRequested === true;

  if (!Number.isSafeInteger(evidence.port) || evidence.port < 1024 || evidence.port > 65535) {
    blockers.push("INVALID_PORT");
  }

  if (production) {
    if (evidence.port !== 7888) blockers.push("PRODUCTION_CORE_PORT_MUST_BE_7888");
    if (!evidence.supervisedCoreVerified) blockers.push("SUPERVISED_CORE_NOT_VERIFIED");
    if (!evidence.guardianVerified) blockers.push("CORE_GUARDIAN_NOT_VERIFIED");
    if (!evidence.independentMcpVerified) blockers.push("INDEPENDENT_MCP_OWNERS_NOT_VERIFIED");
    if (!evidence.ownerInventoryVerified || evidence.listenerPid === null)
      blockers.push("LIVE_CORE_LISTENER_NOT_VERIFIED");
    if (evidence.coldAssessment.decision !== "already_running")
      blockers.push("LIVE_CORE_COLD_AUDIT_NOT_ALREADY_RUNNING");
  } else {
    if ([6789, 7888, 9877].includes(evidence.port))
      blockers.push("LEGACY_OR_INVALID_PORT_PROHIBITED");
    if (!evidence.stageProfileVerified) blockers.push("ISOLATED_PROFILE_NOT_VERIFIED");
    if (!evidence.ownerInventoryVerified || evidence.listenerPid !== null)
      blockers.push("TCP_OWNER_FREE_NOT_VERIFIED");
    if (evidence.coldAssessment.decision !== "fresh_guard_allowed" ||
        evidence.coldAssessment.automaticToolReplay !== false ||
        evidence.coldAssessment.mayDeleteCheckpoint !== false) {
      blockers.push("COLD_START_NAMESPACE_UNSAFE");
    }
  }

  if (evidence.scheduledTaskPresent !== false)
    blockers.push("SCHEDULED_TASK_ABSENCE_NOT_VERIFIED");
  if (evidence.coldAssessment.automaticToolReplay !== false)
    blockers.push("AUTOMATIC_REPLAY_MUST_REMAIN_DISABLED");

  return {
    version: 1,
    status: blockers.length
      ? "blocked"
      : production ? "production_registration_candidate" : "staging_registration_candidate",
    blockers,
    productionApproved: production && blockers.length === 0,
    startScheduledTaskAllowed: false,
    automaticReplayAllowed: false,
  };
}

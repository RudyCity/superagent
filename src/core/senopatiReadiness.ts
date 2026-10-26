/** Cheap, read-only inference readiness for CLI and authenticated desktop status.
 * Does NOT perform IPC, allocate ONNX, restart any process, or authorize actions.
 * A heartbeat snapshot is last-known health, not a guarantee of next inference.
 */
import {getModernPolicy, type ModernPolicy} from "./senopatiModernBert.js";
import {readSenopatiWatchdogStatus, type SenopatiWatchdogHealth}
  from "./senopatiWatchdogStatus.js";

export type SenopatiInferencePhase="healthy"|"degraded"|"disabled";
export interface SenopatiReadiness {
  phase:SenopatiInferencePhase;
  reason:"watchdog-last-known-healthy"|"no-fresh-healthy-watchdog"|"policy-disabled";
  fallback:"legacy-on-error"|"legacy-active";
  automaticChatReplayAllowed:false;
  toolAuthorizationFromModel:false;
}
export function projectSenopatiReadiness(
  policy:Pick<ModernPolicy,"enabled"|"backend"|"inferenceMode">,
  watch:SenopatiWatchdogHealth|null,
):SenopatiReadiness {
  const enabled=policy.enabled && policy.backend==="mmbert-v64-seed73" &&
    policy.inferenceMode==="shared_only";
  const shared={automaticChatReplayAllowed:false as const,
    toolAuthorizationFromModel:false as const};
  if(!enabled)return {phase:"disabled",reason:"policy-disabled",
    fallback:"legacy-active",...shared};
  if(!watch?.alive || !watch.heartbeatFresh || !watch.healthy || !watch.modelPid)
    return {phase:"degraded",reason:"no-fresh-healthy-watchdog",
      fallback:"legacy-active",...shared};
  return {phase:"healthy",reason:"watchdog-last-known-healthy",
    fallback:"legacy-on-error",...shared};
}
export function readSenopatiReadiness():SenopatiReadiness {
  return projectSenopatiReadiness(getModernPolicy(),readSenopatiWatchdogStatus());
}

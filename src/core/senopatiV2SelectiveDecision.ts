/**
 * Experimental Senopati V2 selective decision layer. NEVER a tool permission.
 * Similarity shares are not calibrated probabilities; runtime only reports
 * head-level read-only routing suggestions and conservative abstention.
 */
import type { SenopatiV2ShadowPrediction } from "./senopatiV2Shadow.js";

const HEADS = ["domain","intent","action","risk","approval"] as const;
export type DecisionHead = (typeof HEADS)[number];
export interface SelectivePolicyHead {
  threshold: number | null;
  accept_enabled: boolean;
  safety_head_requires_independent_verification: boolean;
  oof_count: number;
}
export interface SelectivePolicyProfile {
  schema: 1;
  model_family: "senopati-v2-sparse";
  mode: "DEVELOPMENT_ONLY";
  calibration_certified: false;
  true_probability_calibration: false;
  independent_blind_test: false;
  release_authorized: false;
  authorizes_execution: false;
  scores_are_relative_similarity_not_probabilities: true;
  heads: Record<DecisionHead, SelectivePolicyHead>;
}
export interface SelectiveHeadObservation {
  readonly label: string;
  readonly relativeScore: number;
  readonly advisoryAccept: boolean;
  readonly abstain: boolean;
  readonly reason: "weak_relative_signal" | "research_safety_head" | "threshold_not_supported" | "relative_signal_only";
}
export interface SelectiveDecision {
  readonly source: "senopati-v2-selective-shadow";
  readonly heads: Record<DecisionHead, SelectiveHeadObservation>;
  readonly abstain: boolean;
  readonly fallback: "existing_superagent_routing_or_clarification";
  readonly confidenceCalibrated: false;
  readonly authorizesExecution: false;
  readonly eligibleForAutomaticToolRouting: false;
}
export function validateSelectiveProfile(value: unknown): asserts value is SelectivePolicyProfile {
  if (typeof value !== "object" || !value) throw new Error("Missing selective policy profile");
  const v = value as Record<string, any>;
  if (v.schema !== 1 || v.model_family !== "senopati-v2-sparse" || v.mode !== "DEVELOPMENT_ONLY" ||
      v.calibration_certified !== false || v.true_probability_calibration !== false ||
      v.independent_blind_test !== false || v.release_authorized !== false ||
      v.authorizes_execution !== false || v.scores_are_relative_similarity_not_probabilities !== true) {
    throw new Error("Unapproved or incompatible selective profile");
  }
  if (!v.heads || typeof v.heads !== "object") throw new Error("Missing selective heads");
  for (const head of HEADS) {
    const item = v.heads[head];
    if (!item || typeof item !== "object" || typeof item.accept_enabled !== "boolean" ||
        typeof item.oof_count !== "number" || item.oof_count < 1 ||
        typeof item.safety_head_requires_independent_verification !== "boolean" ||
        !(item.threshold === null || (typeof item.threshold === "number" && Number.isFinite(item.threshold) && item.threshold >= 0 && item.threshold <= 1))) {
      throw new Error("Malformed selective policy head " + head);
    }
    if (item.accept_enabled !== (item.threshold !== null)) {
      throw new Error("Invalid selective threshold/availability for " + head);
    }
    if ((head === "risk" || head === "approval") &&
        (!item.safety_head_requires_independent_verification || item.threshold !== null || item.accept_enabled)) {
      throw new Error("Safety head acceptance is forbidden until independent certification: " + head);
    }
  }
}
export function assessSelectiveShadow(
  prediction: SenopatiV2ShadowPrediction,
  profile: SelectivePolicyProfile,
): SelectiveDecision {
  validateSelectiveProfile(profile);
  if (prediction.authorizesExecution !== false || prediction.source !== "senopati-v2-sparse-shadow")
    throw new Error("Non-shadow Senopati result cannot be assessed");
  const heads = {} as Record<DecisionHead, SelectiveHeadObservation>;
  for (const head of HEADS) {
    const score = prediction.relativeScores[head];
    if (!Number.isFinite(score) || score < 0 || score > 1)
      throw new Error("Invalid relative similarity score: " + head);
    const item = profile.heads[head];
    const safety = head === "risk" || head === "approval";
    const accept = !safety && item.accept_enabled && item.threshold !== null && score >= item.threshold;
    const reason: SelectiveHeadObservation["reason"] = safety
      ? "research_safety_head"
      : item.threshold === null
        ? "threshold_not_supported"
        : accept ? "relative_signal_only" : "weak_relative_signal";
    heads[head] = {
      label: prediction.labels[head], relativeScore: score,
      advisoryAccept: accept, abstain: !accept, reason,
    };
  }
  // Current candidate is *always* advisory-only. A future independently
  // certified policy must be a separately reviewed implementation.
  return {
    source: "senopati-v2-selective-shadow", heads, abstain: true,
    fallback: "existing_superagent_routing_or_clarification",
    confidenceCalibrated: false,
    authorizesExecution: false,
    eligibleForAutomaticToolRouting: false,
  };
}

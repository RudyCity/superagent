/** Pure, advisory lifecycle readiness assessment. Never performs or authorizes a mutation. */
import { MAX_RETAINED_CORE_WORKERS } from "./coreGenerationPolicy.js";

export type LifecycleService = "core" | "tray";
export type LifecycleAction = "start" | "stop" | "restart" | "rollback" | "drain" | "upgrade";
export type LifecycleReason =
  | "EVIDENCE_MISSING" | "SCOPE_INVALID" | "PLAN_INVALID" | "OPERATION_INVALID"
  | "OWNER_UNVERIFIED" | "OWNER_CHANGED" | "BUILD_STALE" | "BUILD_INVALID"
  | "BUILD_MISMATCH" | "UNCERTAIN_OPERATION" | "FOREIGN_PROCESS_UNVERIFIED"
  | "SESSION_EVIDENCE_MISSING" | "RETAINED_LIMIT" | "CORE_PROTECTION_MISSING"
  | "SUPERVISOR_PROTOCOL_UNVERIFIED";
export type LifecyclePlan = Readonly<{
  service: LifecycleService;
  action: LifecycleAction;
  operationId: string;
  expectedBuildDigest: string;
  port?: number;
  supervisorPid?: number;
  activeWorkerPid?: number;
  expectedOwnerPid?: number;
  expectedInstanceId?: string;
  noCoreShutdown?: boolean;
  expectedCurrentDigest?: string | null;
  expectedReleaseRevision?: string;
}>;
export type LifecycleEvidence = Readonly<{
  service: LifecycleService;
  ownerVerified: boolean;
  ownerPid: number | null;
  port?: number;
  instanceId?: string;
  activeWorkerPid?: number;
  buildFresh: boolean;
  buildDigest: string | null;
  /** Explicit confirmation from the authoritative owner-specific ledger. */
  pendingUncertainOperations: number;
  /** Number of unverified processes from an authoritative process inventory. */
  unverifiedForeignProcesses: number;
  /** Only a supervisor that advertises the verified transient handover protocol is eligible. */
  supervisorLifecycleVersion?: number;
  /** Only required by Core. Missing is not equivalent to zero. */
  sessionCount?: number;
  retainedWorkerCount?: number;
  /** Checked separately from a caller-supplied action string. */
  permittedActions: readonly LifecycleAction[];
  /** Latest independently computed source/build or executable digest. */
  observedBuildDigest: string | null;
}>;
export type LifecycleVerdict = Readonly<{
  service: LifecycleService;
  action: LifecycleAction | null;
  status: "ready" | "blocked";
  ready: boolean;
  reasons: readonly LifecycleReason[];
  /** Advisory only; still requires an authenticated fresh plan and human approval. */
  mutationAuthorized: false;
}>;

const digest = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const pid = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const port = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 1024 && (v as number) <= 65535;
const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const uuid = (v: unknown): v is string => typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const instance = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{32}$/.test(v);
const coreActions = new Set<LifecycleAction>(["restart", "rollback", "drain"]);
const trayActions = new Set<LifecycleAction>(["start", "stop", "restart", "rollback", "upgrade"]);

/**
 * Evaluates independently collected plan and runtime evidence.
 * Evidence must be obtained using authenticated lifecycle and process inventory APIs.
 * This function does not probe processes, access tokens, mutate ledgers or restart anything.
 */
export function assessSafeLifecycleReadiness(
  plan: LifecyclePlan | null | undefined,
  evidence: LifecycleEvidence | null | undefined,
  scope: LifecycleService,
): LifecycleVerdict {
  const reasons = new Set<LifecycleReason>();
  const service = scope;
  const action = plan?.action ?? null;
  if (!plan || !evidence) reasons.add("EVIDENCE_MISSING");
  if (scope !== "core" && scope !== "tray") reasons.add("SCOPE_INVALID");
  if (plan && (plan.service !== scope || !(scope === "core" ? coreActions : trayActions).has(plan.action)))
    reasons.add("SCOPE_INVALID");
  if (evidence?.service !== scope) reasons.add("SCOPE_INVALID");
  if (!plan || !uuid(plan.operationId)) reasons.add("OPERATION_INVALID");
  if (!plan || !digest(plan.expectedBuildDigest)) reasons.add("PLAN_INVALID");
  if (!evidence || evidence.ownerVerified !== true) reasons.add("OWNER_UNVERIFIED");
  if (!evidence || !Array.isArray(evidence.permittedActions) ||
      !plan || !evidence.permittedActions.includes(plan.action)) reasons.add("SCOPE_INVALID");
  if (!evidence || !count(evidence.pendingUncertainOperations) ||
      evidence.pendingUncertainOperations !== 0) reasons.add("UNCERTAIN_OPERATION");
  if (!evidence || !count(evidence.unverifiedForeignProcesses) ||
      evidence.unverifiedForeignProcesses !== 0) reasons.add("FOREIGN_PROCESS_UNVERIFIED");
  if (!evidence || evidence.buildFresh !== true) reasons.add("BUILD_STALE");
  if (!evidence || !digest(evidence.buildDigest) || !digest(evidence.observedBuildDigest))
    reasons.add("BUILD_INVALID");
  if (plan && evidence && (plan.expectedBuildDigest !== evidence.buildDigest ||
      plan.expectedBuildDigest !== evidence.observedBuildDigest)) reasons.add("BUILD_MISMATCH");

  if (scope === "core") {
    if (evidence?.supervisorLifecycleVersion !== 2)
      reasons.add("SUPERVISOR_PROTOCOL_UNVERIFIED");
    if (!plan || !evidence || !pid(plan.supervisorPid) ||
        !pid(evidence.ownerPid) || plan.supervisorPid !== evidence.ownerPid ||
        !port(plan.port) || plan.port !== evidence.port ||
        !pid(plan.activeWorkerPid) || plan.activeWorkerPid !== evidence.activeWorkerPid)
      reasons.add("OWNER_CHANGED");
    if (!evidence || !count(evidence.sessionCount) || !count(evidence.retainedWorkerCount))
      reasons.add("SESSION_EVIDENCE_MISSING");
    // A restart creates another retained generation. Drain/rollback have different policies.
    if (plan?.action === "restart" && evidence &&
        (!count(evidence.retainedWorkerCount) ||
         evidence.retainedWorkerCount >= MAX_RETAINED_CORE_WORKERS))
      reasons.add("RETAINED_LIMIT");
  } else {
    if (!plan || !evidence || plan.noCoreShutdown !== true)
      reasons.add("CORE_PROTECTION_MISSING");
    if (plan?.action === "start") {
      if (!evidence || evidence.ownerPid !== null ||
          plan.expectedOwnerPid !== 0 || plan.expectedInstanceId !== "absent" ||
          plan.port !== undefined || evidence.instanceId !== undefined)
        reasons.add("OWNER_CHANGED");
    } else if (!plan || !evidence || !pid(evidence.ownerPid) ||
        plan.expectedOwnerPid !== evidence.ownerPid ||
        !instance(plan.expectedInstanceId) ||
        plan.expectedInstanceId !== evidence.instanceId ||
        !port(plan.port) || plan.port !== evidence.port)
      reasons.add("OWNER_CHANGED");
    if (plan?.action === "upgrade" || plan?.action === "rollback") {
      if (!plan || !/^[a-f0-9]{24}$/.test(plan.expectedReleaseRevision ?? "") ||
          !digest(plan.expectedCurrentDigest)) reasons.add("PLAN_INVALID");
    }
  }
  const result = [...reasons].sort();
  return Object.freeze({
    service, action,
    status: result.length ? "blocked" : "ready",
    ready: result.length === 0,
    reasons: Object.freeze(result),
    mutationAuthorized: false as const,
  });
}

export function assessIndependentLifecycleReadiness(input: Readonly<{
  core: Readonly<{plan: LifecyclePlan | null; evidence: LifecycleEvidence | null}>;
  tray: Readonly<{plan: LifecyclePlan | null; evidence: LifecycleEvidence | null}>;
}>): Readonly<{core: LifecycleVerdict; tray: LifecycleVerdict}> {
  return Object.freeze({
    core: assessSafeLifecycleReadiness(input.core.plan, input.core.evidence, "core"),
    tray: assessSafeLifecycleReadiness(input.tray.plan, input.tray.evidence, "tray"),
  });
}

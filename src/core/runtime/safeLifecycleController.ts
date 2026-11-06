/** Read-only Core/Tray lifecycle health checkpoint. Never restarts, stops or signs a plan.
 * A "ready" verdict is advisory: owner-specific transaction must still revalidate
 * a fresh plan, operation ID, digest, identity and explicit user confirmation.
 */
import { assessSafeLifecycleReadiness, type LifecyclePlan, type LifecycleEvidence } from "./safeLifecycleReadiness.js";
import { requestCoreSupervisor, type CoreRuntimeStatus } from "./coreSupervisor.js";
import { prepareCoreLifecycle } from "./coreLifecycleControl.js";
import { CoreLifecycleLedger } from "./coreLifecycleLedger.js";
import { ManagedSidecarLedger } from "./managedSidecarLedger.js";
import { readListenerOwners } from "./coreMcpOwnershipAudit.js";
import { inspectManagedTray, readManagedTrayOwner, planManagedTray, legacyTrayProcessPids } from "./managedTrayControl.js";
import { fileSha256 } from "./trayReleaseStore.js";
import { readDelegateListenerPreference } from "../delegate/delegateListenerPreference.js";
import type { ServiceStatus } from "./serviceManager.js";

export interface SafeLifecycleInspectionProvider {
  inspectServices(): Promise<readonly ServiceStatus[]>;
  coreStatus(): Promise<CoreRuntimeStatus>;
  corePlan(): Promise<LifecyclePlan>;
  corePending(): number;
  delegatePortOwner(): number | null; // 0 = unbound; null = unavailable evidence
  delegateDesiredEnabled(): boolean;
  trayOwner(): { pid: number; instanceId: string; controlPort: number; executablePath: string } | null;
  trayPlan(): Promise<LifecyclePlan>;
  trayPending(): number;
  trayForeign(ownedPid: number | null): number;
  trayDigest(file: string): string;
}

export const liveSafeLifecycleProvider: SafeLifecycleInspectionProvider = {
  inspectServices: async () => (await import("./serviceManager.js")).inspectServices("all"),
  coreStatus: () => requestCoreSupervisor("status", 7888, 2500),
  corePlan: async () => ({service: "core" as const, ...await prepareCoreLifecycle("restart", 7888)}),
  corePending: () => new CoreLifecycleLedger(7888).inspect().filter(x => x.state === "pending").length,
  delegatePortOwner: () => {
    const owners = readListenerOwners();
    return owners === null ? null : owners.get(17341) ?? 0;
  },
  delegateDesiredEnabled: () => readDelegateListenerPreference(),
  trayOwner: () => readManagedTrayOwner(),
  trayPlan: () => planManagedTray("restart"),
  trayPending: () => [45321, 45322].reduce((n, port) =>
    n + new ManagedSidecarLedger("tray", port).inspect().filter(x => x.state === "pending").length, 0),
  trayForeign: (ownedPid) => legacyTrayProcessPids(ownedPid).length,
  trayDigest: file => fileSha256(file),
};

function code(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.match(/\b[A-Z][A-Z0-9_]{5,90}\b/)?.[0] ?? "INSPECTION_UNAVAILABLE";
}

function permitted(status: ServiceStatus | undefined, values: readonly ("restart" | "rollback" | "drain" | "stop" | "start" | "upgrade")[]) {
  return (status?.actions ?? []).filter((value): value is typeof values[number] =>
    values.includes(value as typeof values[number]));
}

async function planOrNull(task: () => Promise<LifecyclePlan>): Promise<{
  plan: LifecyclePlan | null; errorCode: string | null;
}> {
  try {
    return { plan: await task(), errorCode: null };
  } catch (e) {
    return { plan: null, errorCode: code(e) };
  }
}

/** All owner IDs are numeric. Tokens, pairing codes, operation IDs and paths are never returned. */
export async function inspectSafeLifecycleReadiness(
  provider: SafeLifecycleInspectionProvider = liveSafeLifecycleProvider,
  previouslyInspectedServices?: readonly ServiceStatus[],
) {
  let services: readonly ServiceStatus[];
  try { services = previouslyInspectedServices ?? await provider.inspectServices(); }
  catch (error) {
    return { readOnly: true as const,
      inspectionErrorCode: code(error),
      core: { ...assessSafeLifecycleReadiness(null, null, "core"), planAvailable: false },
      tray: { ...assessSafeLifecycleReadiness(null, null, "tray"), planAvailable: false },
    };
  }
  const coreService = services.find(x => x.service === "core");
  const trayService = services.find(x => x.service === "tray");
  const core = async () => {
    try {
      const status = await provider.coreStatus();
      const pending = provider.corePending();
      // A stale or legacy supervisor is already NO-GO. Do not perform a
      // costly Windows listener inventory in that state; unknown stays blocked.
      const probeListener = pending === 0 && status.currentBuild?.fresh === true &&
        status.ownerContract?.safeLifecycleVersion === 2 &&
        status.retained.length < 4;
      const listener = probeListener ? provider.delegatePortOwner() : null;
      const desired = provider.delegateDesiredEnabled();
      // A listener on a retained or foreign PID is not proof that active Core owns it.
      const foreign = listener === null ? -1 :
        desired ? Number(listener !== status.active.pid) : Number(listener !== 0);
      const currentDigest = status.currentBuild?.digest ?? null;
      const evidence: LifecycleEvidence = {
        service: "core",
        ownerVerified: coreService?.ownershipVerified === true &&
          status.supervisorPid === coreService.ownerPid &&
          status.ownerContract?.role === "core-supervisor" &&
          status.ownerContract?.mcpLifecycle === "not-owned",
        ownerPid: coreService?.ownerPid ?? null,
        port: coreService?.port,
        activeWorkerPid: status.active.pid,
        buildFresh: status.currentBuild?.fresh === true,
        buildDigest: currentDigest,
        observedBuildDigest: currentDigest,
        pendingUncertainOperations: pending,
        unverifiedForeignProcesses: foreign,
        supervisorLifecycleVersion: status.ownerContract?.safeLifecycleVersion ?? 0,
        sessionCount: status.affinitySessions,
        retainedWorkerCount: status.retained.length,
        permittedActions: permitted(coreService, ["restart", "rollback", "drain"]),
      };
      // When a required safety gate already fails, do not create even a
      // non-executable lifecycle plan or perform another supervisor probe.
      const preblocked = !evidence.ownerVerified || !evidence.buildFresh ||
        evidence.supervisorLifecycleVersion !== 2 ||
        pending !== 0 || foreign !== 0 ||
        !Number.isSafeInteger(evidence.retainedWorkerCount) ||
        status.retained.length >= 4 ||
        !Number.isSafeInteger(evidence.sessionCount);
      const attempt = preblocked
        ? { plan: null, errorCode: !evidence.buildFresh ? "CORE_BUILD_UNVERIFIED" :
            evidence.supervisorLifecycleVersion !== 2 ? "SUPERVISOR_PROTOCOL_UNVERIFIED" :
            foreign !== 0 ? "DELEGATE_PORT_OWNER_UNVERIFIED" :
            pending !== 0 ? "CORE_OPERATION_UNCERTAIN_PENDING" :
            "CORE_RESTART_PREFLIGHT_BLOCKED" }
        : await planOrNull(provider.corePlan);
      const verdict = assessSafeLifecycleReadiness(attempt.plan, evidence, "core");
      const capacityBlocked = status.retained.length >= 4;
      const reasons = capacityBlocked
        ? Object.freeze([...new Set([...verdict.reasons, "RETAINED_LIMIT" as const])].sort())
        : verdict.reasons;
      return { ...verdict, reasons, ready: !capacityBlocked && verdict.ready,
        status: capacityBlocked ? "blocked" as const : verdict.status,
        planAvailable: attempt.plan !== null,
        ...(attempt.errorCode ? { planErrorCode: attempt.errorCode } : {}),
        supervisorPid: status.supervisorPid, activeWorkerPid: status.active.pid,
        retainedWorkers: status.retained.length, sessions: status.affinitySessions ?? null,
        delegatePortOwnerVerified: foreign === 0 };
    } catch (error) {
      return { ...assessSafeLifecycleReadiness(null, null, "core"),
        planAvailable: false, inspectionErrorCode: code(error) };
    }
  };
  const tray = async () => {
    try {
      const owner = provider.trayOwner();
      const pending = provider.trayPending();
      // Unknown is never considered zero, but a pending journal already
      // blocks a restart without scanning the Windows process table again.
      const foreign = pending === 0 ? provider.trayForeign(owner?.pid ?? null) : -1;
      const digest = owner ? provider.trayDigest(owner.executablePath) : null;
      const observed = owner ? provider.trayDigest(owner.executablePath) : null;
      const evidence: LifecycleEvidence = {
        service: "tray", ownerVerified: trayService?.ownershipVerified === true &&
          owner?.pid === trayService.ownerPid && owner?.controlPort === trayService.port,
        ownerPid: trayService?.ownerPid ?? null,
        port: trayService?.port,
        instanceId: owner?.instanceId,
        buildFresh: digest !== null && observed === digest,
        buildDigest: digest,
        observedBuildDigest: observed,
        pendingUncertainOperations: pending,
        unverifiedForeignProcesses: foreign,
        permittedActions: permitted(trayService, ["restart", "start", "stop", "rollback", "upgrade"]),
      };
      const preblocked = !evidence.ownerVerified || !evidence.buildFresh ||
        pending !== 0 || foreign !== 0;
      const attempt = preblocked
        ? { plan: null, errorCode: pending !== 0 ? "TRAY_LIFECYCLE_UNCERTAIN_PENDING_OPERATOR_REVIEW" :
            foreign !== 0 ? "TRAY_LEGACY_PROCESS_REQUIRES_USER_QUIT" :
            "TRAY_RESTART_PREFLIGHT_BLOCKED" }
        : await planOrNull(provider.trayPlan);
      return { ...assessSafeLifecycleReadiness(attempt.plan, evidence, "tray"),
        planAvailable: attempt.plan !== null,
        ...(attempt.errorCode ? { planErrorCode: attempt.errorCode } : {}),
        ownerPid: owner?.pid ?? null,
        foreignProcessCount: foreign,
        pendingOperations: pending,
        releaseActivated: false as const };
    } catch (error) {
      return { ...assessSafeLifecycleReadiness(null, null, "tray"),
        planAvailable: false, inspectionErrorCode: code(error) };
    }
  };
  const [coreResult, trayResult] = await Promise.all([core(), tray()]);
  return {
    readOnly: true as const,
    core: coreResult, tray: trayResult,
    note: "Advisory preflight only. No process was changed. Owner-specific lifecycle still requires a fresh plan and explicit confirmation.",
  };
}

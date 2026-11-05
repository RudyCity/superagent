/** Manual-only repair of a fixed-port Delegate listener left on a retained
 * Core worker. No PID killing, arbitrary-port scanning or automatic RPC replay.
 * Every former owner is verified by the supervisor's generation capability.
 */
import { readCoreCheckpoint, type CoreSupervisorCheckpoint, type CoreCheckpointWorker } from "../runtime/coreSupervisorCheckpoint.js";
import { callCoreWorkerDelegateBridge, type DelegateBridgeCall } from "../runtime/coreDelegateHandover.js";

export type InspectVerifiedDelegateWorker = (
  worker: CoreCheckpointWorker, checkpoint: CoreSupervisorCheckpoint,
) => Promise<boolean>;

export const inspectVerifiedDelegateWorker: InspectVerifiedDelegateWorker = async (worker, checkpoint) => {
  try {
    const response = await fetch("http://127.0.0.1:" + worker.port + "/_core/internal/drain", {
      headers: { "x-superagent-internal-token": checkpoint.inspectToken },
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return false;
    const raw = await response.text();
    if (raw.length > 8192) return false;
    const result: unknown = JSON.parse(raw);
    if (!result || typeof result !== "object" || Array.isArray(result)) return false;
    const report = result as Record<string, unknown>;
    return report.pid === worker.pid &&
      report.workerGenerationId === worker.generationId &&
      report.transportIsolated === worker.drainEligible;
  } catch { return false; }
};

export interface RetainedDelegateOptions {
  checkpoint?: CoreSupervisorCheckpoint;
  currentPid?: number;
  currentGenerationId?: string;
  serverToken?: string;
  inspect?: InspectVerifiedDelegateWorker;
  call?: DelegateBridgeCall;
}
async function locateRetainedListener(options: RetainedDelegateOptions, allowAbsent: boolean) {
  const publicPort = Number(process.env.SUPERAGENT_CORE_PUBLIC_PORT || "7888");
  const checkpoint = options.checkpoint ?? readCoreCheckpoint(publicPort);
  const pid = options.currentPid ?? process.pid;
  const generationId = options.currentGenerationId ?? process.env.SUPERAGENT_CORE_GENERATION_ID;
  const token = options.serverToken ?? process.env.SUPERAGENT_SERVER_AUTH_TOKEN;
  const active = checkpoint.workers.find(worker =>
    worker.pid === pid && worker.generationId === generationId);
  if (checkpoint.activePid !== pid || !active || !generationId ||
      token !== checkpoint.serverToken)
    throw new Error("DELEGATE_RECOVERY_ACTIVE_WORKER_UNVERIFIED");
  const inspect = options.inspect ?? inspectVerifiedDelegateWorker;
  const call = options.call ?? callCoreWorkerDelegateBridge;
  const possible: CoreCheckpointWorker[] = [];
  for (const worker of checkpoint.workers) {
    if (worker.pid === pid) continue;
    if (!await inspect(worker, checkpoint)) continue;
    const state = await call(worker.port, "status", token);
    if (!state.running) continue;
    // A legacy worker may not expose pendingRequests. With zero sockets
    // it cannot have active Delegate RPC; otherwise fail closed.
    if ((state.pendingRequests === undefined && state.openSockets > 0) ||
        (state.pendingRequests !== undefined && state.pendingRequests > 0))
      throw new Error("DELEGATE_RECOVERY_OWNER_INFLIGHT_UNVERIFIED");
    possible.push(worker);
  }
  if (possible.length === 0 && allowAbsent) return null;
  if (possible.length !== 1)
    throw new Error("DELEGATE_RECOVERY_NO_UNIQUE_VERIFIED_OWNER");
  const owner = possible[0];
  // Recheck the supervisor's durable active generation immediately before
  // modifying a retained listener. Never act using stale checkpoint metadata.
  if (!options.checkpoint) {
    const latest = readCoreCheckpoint(publicPort);
    if (latest.activePid !== checkpoint.activePid ||
        !latest.workers.some(worker => worker.pid === owner.pid &&
          worker.port === owner.port && worker.generationId === owner.generationId) ||
        !latest.workers.some(worker => worker.pid === pid &&
          worker.generationId === generationId)) {
      throw new Error("DELEGATE_RECOVERY_CHECKPOINT_CHANGED");
    }
  }
  return { owner, call, token, inspectToken: checkpoint.inspectToken };
}

/** Stop the only verified retained listener when the active worker owns none. */
export async function stopRetainedDelegateListener(options: RetainedDelegateOptions = {}): Promise<void> {
  const located = await locateRetainedListener(options, true);
  if (!located) return;
  const { owner, call, token, inspectToken } = located;
  const stopped = await call(owner.port, "stop", token, { transient: true, inspectToken });
  if (stopped.running) throw new Error("DELEGATE_RECOVERY_OWNER_STILL_RUNNING");
}

/** Transfer the only verified old listener to an active worker. */
export async function recoverDelegateListenerFromRetained(
  startCurrent: () => Promise<void>,
  options: RetainedDelegateOptions = {},
): Promise<void> {
  const located = await locateRetainedListener(options, false);
  if (!located) throw new Error("DELEGATE_RECOVERY_NO_UNIQUE_VERIFIED_OWNER");
  const { owner, call, token, inspectToken } = located;
  const stopped = await call(owner.port, "stop", token, { transient: true, inspectToken });
  if (stopped.running) throw new Error("DELEGATE_RECOVERY_OWNER_STILL_RUNNING");
  try { await startCurrent(); }
  catch (error) {
    try {
      const restored = await call(owner.port, "start", token, { transient: true, inspectToken });
      if (!restored.running) throw new Error("DELEGATE_RECOVERY_ROLLBACK_UNVERIFIED");
    } catch { throw new Error("DELEGATE_RECOVERY_AND_ROLLBACK_FAILED"); }
    throw error;
  }
}

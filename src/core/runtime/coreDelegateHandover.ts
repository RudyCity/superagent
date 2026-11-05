/** Hand off the single fixed Delegate WebSocket listener between verified Core workers.
 *
 * This runs only in the supervisor and uses authenticated loopback worker
 * routes. No process is killed, no browser command is replayed, and a failed
 * handover restores the previous listener wherever possible.
 */
export interface DelegateWorkerBridgeStatus {
  running: boolean;
  port: number;
  openSockets: number;
  pendingRequests?: number;
  activeProfiles: Array<{ clientId: string }>;
}

export type DelegateBridgeOperation = "status" | "start" | "stop";
export type DelegateBridgeCall = (
  workerPort: number, action: DelegateBridgeOperation, serverToken: string,
) => Promise<DelegateWorkerBridgeStatus>;

export const callCoreWorkerDelegateBridge: DelegateBridgeCall = async (workerPort, action, serverToken) => {
  if (!Number.isSafeInteger(workerPort) || workerPort < 1024 || workerPort > 65535 ||
      typeof serverToken !== "string" || serverToken.length < 24)
    throw new Error("CORE_DELEGATE_UNVERIFIED_WORKER");
  const response = await fetch(
    "http://127.0.0.1:" + workerPort + "/api/desktop/delegate/" +
      (action === "status" ? "status" : "lifecycle"),
    {
      method: action === "status" ? "GET" : "POST",
      headers: {
        Authorization: "Bearer " + serverToken,
        ...(action === "status" ? {} : { "Content-Type": "application/json" }),
      },
      ...(action === "status" ? {} : { body: JSON.stringify({ action }) }),
      signal: AbortSignal.timeout(5000),
    },
  );
  if (!response.ok) throw new Error("CORE_DELEGATE_WORKER_ACTION_REJECTED");
  const raw = await response.text();
  if (raw.length > 16384) throw new Error("CORE_DELEGATE_WORKER_STATUS_TOO_LARGE");
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object") throw new Error("CORE_DELEGATE_WORKER_BAD_STATUS");
  const state = value as Record<string, unknown>;
  if (state.success !== true || typeof state.running !== "boolean" ||
      state.port !== 17341 || !Number.isSafeInteger(state.openSockets) ||
      !Array.isArray(state.activeProfiles) ||
      (state.pendingRequests !== undefined && !Number.isSafeInteger(state.pendingRequests)))
    throw new Error("CORE_DELEGATE_WORKER_BAD_STATUS");
  return state as unknown as DelegateWorkerBridgeStatus;
};

function assertHandoverSafe(status: DelegateWorkerBridgeStatus): void {
  if (status.pendingRequests !== undefined && status.pendingRequests > 0)
    throw new Error("CORE_DELEGATE_HANDOVER_INFLIGHT: Delegate requests still pending");
  // Legacy Core did not expose pendingRequests: only allow an empty socket
  // roster in that case, so we cannot inadvertently interrupt live RPC.
  if (status.pendingRequests === undefined && status.openSockets > 0)
    throw new Error("CORE_DELEGATE_HANDOVER_UNVERIFIED_INFLIGHT");
}

export async function handoverCoreDelegateBridge(
  previousWorkerPort: number, nextWorkerPort: number, serverToken: string,
  call: DelegateBridgeCall = callCoreWorkerDelegateBridge,
): Promise<void> {
  if (previousWorkerPort === nextWorkerPort) return;
  const old = await call(previousWorkerPort, "status", serverToken);
  assertHandoverSafe(old);
  // The old worker may have disabled Delegate intentionally; supervisor-wide
  // SUPERAGENT_DELEGATE_BRIDGE=0 is checked by the caller.
  const stopped = old.running
    ? await call(previousWorkerPort, "stop", serverToken)
    : old;
  if (stopped.running)
    throw new Error("CORE_DELEGATE_OLD_LISTENER_NOT_RELEASED");
  try {
    const started = await call(nextWorkerPort, "start", serverToken);
    if (!started.running) throw new Error("CORE_DELEGATE_NEW_LISTENER_NOT_READY");
  } catch (error) {
    if (old.running) {
      try { await call(previousWorkerPort, "start", serverToken); }
      catch {
        throw new Error("CORE_DELEGATE_HANDOVER_AND_ROLLBACK_FAILED");
      }
    }
    throw error;
  }
}

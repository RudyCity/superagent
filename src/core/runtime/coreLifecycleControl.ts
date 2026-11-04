/** Supervisor-authenticated Core lifecycle; no shell, process kill or tunnel restart. */
import { requestCoreSupervisor, type CoreRuntimeStatus } from "./coreSupervisor.js";

export type CoreLifecycleAction = "status" | "restart" | "rollback" | "drain";
export function corePort(input: unknown): number {
  const value = input === undefined ? 7888 : input;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1024 || value > 65535)
    throw new Error("CORE_CONTROL_INVALID_PORT");
  return value;
}
export function coreAction(input: unknown): CoreLifecycleAction {
  if (input === "status" || input === "restart" || input === "rollback" || input === "drain")
    return input;
  throw new Error("CORE_CONTROL_INVALID_ACTION");
}
function verify(s: CoreRuntimeStatus, port: number, owner?: number) {
  if (s.publicPort !== port || !Number.isSafeInteger(s.supervisorPid) || s.supervisorPid <= 0 ||
      (owner !== undefined && s.supervisorPid !== owner) ||
      !Number.isSafeInteger(s.active?.pid) || s.active.pid <= 0 ||
      !Number.isSafeInteger(s.active?.port) || s.active.port === port ||
      (s.ownerContract !== undefined &&
        (s.ownerContract.role !== "core-supervisor" || s.ownerContract.mcpLifecycle !== "not-owned")))
    throw new Error("CORE_CONTROL_OWNER_CHANGED_OR_UNVERIFIED");
}
export async function controlCoreLifecycle(
  action: CoreLifecycleAction, port = 7888, confirm = false,
  request: typeof requestCoreSupervisor = requestCoreSupervisor,
) {
  coreAction(action); corePort(port);
  if (action !== "status" && confirm !== true)
    throw new Error("CORE_CONTROL_CONFIRM_REQUIRED");
  const before = await request("status", port, 2500);
  verify(before, port);
  if (action === "status") return {
    action, port, changed: false, verified: true, supervisorPid: before.supervisorPid,
    previousWorkerPid: before.active.pid, activeWorkerPid: before.active.pid,
    status: before, note: "Read-only; no worker or tunnel changed.",
  };
  const result = await request(action, port, 30000);
  verify(result, port, before.supervisorPid);
  const after = await request("status", port, 2500);
  verify(after, port, before.supervisorPid);
  if (after.active.pid !== result.active.pid)
    throw new Error("CORE_CONTROL_GENERATION_UNSTABLE");
  if (action === "restart" && (after.active.pid === before.active.pid ||
      !after.retained.some(w => w.pid === before.active.pid)))
    throw new Error("CORE_CONTROL_RESTART_NOT_VERIFIED");
  if (action === "rollback" && after.active.pid === before.active.pid)
    throw new Error("CORE_CONTROL_ROLLBACK_NOT_VERIFIED");
  return {
    action, port, changed: action === "restart" || action === "rollback" ||
      after.retained.length !== before.retained.length,
    verified: true, supervisorPid: after.supervisorPid,
    previousWorkerPid: before.active.pid, activeWorkerPid: after.active.pid,
    status: after,
    note: "Supervisor lifecycle operation verified. MCP/Muse/Telegram tunnels untouched; existing worker sessions retained where required.",
  };
}

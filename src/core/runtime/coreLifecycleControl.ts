/** Supervisor-authenticated Core lifecycle; no shell, process kill or tunnel restart. */
import crypto from "node:crypto";
import { requestCoreSupervisor, type CoreRuntimeStatus } from "./coreSupervisor.js";
import { validateCoreOperationId } from "./coreLifecycleLedger.js";

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
      s.ownerContract?.role !== "core-supervisor" || s.ownerContract?.mcpLifecycle !== "not-owned" ||
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
  options: { operationId?: string; expectedBuildDigest?: string } = {},
) {
  coreAction(action); corePort(port);
  if (action !== "status" && confirm !== true)
    throw new Error("CORE_CONTROL_CONFIRM_REQUIRED");
  if (options.operationId !== undefined) validateCoreOperationId(options.operationId);
  if (options.expectedBuildDigest !== undefined &&
      !/^[a-f0-9]{64}$/.test(options.expectedBuildDigest))
    throw new Error("CORE_BUILD_INVALID_EXPECTED_DIGEST");
  const before = await request("status", port, 2500);
  verify(before, port);
  if (action === "status") return {
    action, port, changed: false, verified: true, supervisorPid: before.supervisorPid,
    previousWorkerPid: before.active.pid, activeWorkerPid: before.active.pid,
    status: before, note: "Read-only; no worker or tunnel changed.",
  };
  if (!before.currentBuild || !before.currentBuild.fresh ||
      !/^[a-f0-9]{64}$/.test(before.currentBuild.digest))
    throw new Error("CORE_BUILD_UNVERIFIED: supervised Core must run source mode or freshly compiled dist");
  const expected = options.expectedBuildDigest ?? before.currentBuild.digest;
  if (expected !== before.currentBuild.digest)
    throw new Error("CORE_BUILD_CHANGED_SINCE_PLAN");
  const id = options.operationId ?? crypto.randomUUID();
  validateCoreOperationId(id);
  const result = await request(action, port, 30000, {
    operationId: id, expectedBuildDigest: expected,
  });
  verify(result, port, before.supervisorPid);
  const after = await request("status", port, 2500);
  verify(after, port, before.supervisorPid);
  if (after.active.pid !== result.active.pid)
    throw new Error("CORE_CONTROL_GENERATION_UNSTABLE");
  if (result.operation?.replayed) {
    return {
      action, port, changed: false, replayed: true, operationId: id,
      expectedBuildDigest: expected, verified: true, supervisorPid: after.supervisorPid,
      previousWorkerPid: after.active.pid, activeWorkerPid: after.active.pid,
      status: after,
      note: "Previously completed operation confirmed; no second restart or rollback was performed.",
    };
  }
  if (action === "restart" && (after.active.pid === before.active.pid ||
      !after.retained.some(w => w.pid === before.active.pid)))
    throw new Error("CORE_CONTROL_RESTART_NOT_VERIFIED");
  if (action === "restart" && after.active.buildDigest !== expected)
    throw new Error("CORE_BUILD_ATTESTATION_MISMATCH");
  if (action === "rollback" && after.active.pid === before.active.pid)
    throw new Error("CORE_CONTROL_ROLLBACK_NOT_VERIFIED");
  return {
    action, port, changed: action === "restart" || action === "rollback" ||
      after.retained.length !== before.retained.length,
    replayed: false, operationId: id, expectedBuildDigest: expected,
    codeChanged: action === "restart" ? before.active.buildDigest !== after.active.buildDigest : false,
    verified: true, supervisorPid: after.supervisorPid,
    previousWorkerPid: before.active.pid, activeWorkerPid: after.active.pid,
    status: after,
    note: "Supervisor operation and source/dist fingerprint verified. Tunnels untouched; existing sessions retain their owner.",
  };
}

/** Non-mutating preflight for MCP and development agents. */
export async function prepareCoreLifecycle(
  action: "restart" | "rollback" | "drain", port = 7888,
  request: typeof requestCoreSupervisor = requestCoreSupervisor,
) {
  corePort(port);
  if (action !== "restart" && action !== "rollback" && action !== "drain")
    throw new Error("CORE_CONTROL_INVALID_PREPARE_ACTION");
  const before = await request("status", port, 2500);
  verify(before, port);
  if (!before.currentBuild?.fresh || !/^[a-f0-9]{64}$/.test(before.currentBuild.digest))
    throw new Error("CORE_BUILD_UNVERIFIED: rebuild compiled Core or use source mode");
  return {
    action, port, operationId: crypto.randomUUID(),
    expectedBuildDigest: before.currentBuild.digest,
    buildMode: before.currentBuild.mode,
    codeChangedSinceActiveWorker: before.active.buildDigest !== before.currentBuild.digest,
    supervisorPid: before.supervisorPid, activeWorkerPid: before.active.pid,
    retainedWorkerPids: before.retained.map(w => w.pid),
    note: "Read-only plan, not human authorization. Mutation still requires write scope and confirm:true.",
  };
}

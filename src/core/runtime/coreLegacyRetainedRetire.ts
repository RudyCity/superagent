import crypto from "node:crypto";
import net from "node:net";
import { requestCoreSupervisor, type CoreRuntimeStatus } from "./coreSupervisor.js";
import { readCoreCheckpoint, type CoreCheckpointWorker } from "./coreSupervisorCheckpoint.js";
import { legacyRetainedCoreMayDrain, type CoreDrainReport } from "./coreDrainInspection.js";
import { callCoreWorkerDelegateBridge } from "./coreDelegateHandover.js";
import { readProcessStartIdentity } from "../tools/cliBridgeProcessIdentity.js";

export interface LegacyRetainedRetireResult {
  port: number;
  retiredPid: number;
  physicalExitVerified: boolean;
  supervisorMetadataRetired: boolean;
  activeWorkerPid: number;
  note: string;
}

function pause(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function assertSupervisorStatus(status: CoreRuntimeStatus, port: number): void {
  if (status.publicPort !== port ||
      status.ownerContract?.role !== "core-supervisor" ||
      status.ownerContract?.mcpLifecycle !== "not-owned" ||
      status.ownerContract?.safeLifecycleVersion !== 2 ||
      !Number.isSafeInteger(status.supervisorPid) || status.supervisorPid <= 0 ||
      !Number.isSafeInteger(status.active?.pid) || status.active.pid <= 0) {
    throw new Error("CORE_LEGACY_RETAINED_OWNER_UNVERIFIED");
  }
}

function selectLegacyWorker(
  status: CoreRuntimeStatus,
  port: number,
  pid: number,
): { worker: CoreCheckpointWorker; checkpoint: ReturnType<typeof readCoreCheckpoint> } {
  const checkpoint = readCoreCheckpoint(port);
  if (checkpoint.activePid !== status.active.pid) {
    throw new Error("CORE_LEGACY_RETAINED_CHECKPOINT_ACTIVE_MISMATCH");
  }
  const retained = status.retained.find(item => item.pid === pid);
  const worker = checkpoint.workers.find(item => item.pid === pid);
  if (!retained || !worker || retained.port !== worker.port ||
      retained.since !== worker.since || pid === status.active.pid ||
      worker.drainEligible !== false) {
    throw new Error("CORE_LEGACY_RETAINED_TARGET_UNVERIFIED");
  }
  if (checkpoint.sessions.some(session => session.owner.pid === pid)) {
    throw new Error("CORE_LEGACY_RETAINED_PINNED_SESSIONS");
  }
  return { worker, checkpoint };
}

async function fetchDrainReport(
  worker: CoreCheckpointWorker,
  inspectToken: string,
): Promise<CoreDrainReport> {
  const response = await fetch(
    "http://127.0.0.1:" + worker.port + "/_core/internal/drain",
    {
      method: "GET",
      headers: { "x-superagent-internal-token": inspectToken },
      redirect: "error",
      signal: AbortSignal.timeout(2500),
    },
  );
  if (!response.ok) throw new Error("CORE_LEGACY_RETAINED_DRAIN_PROBE_FAILED");
  const report = await response.json() as CoreDrainReport;
  if (report.pid !== worker.pid ||
      report.workerGenerationId !== worker.generationId ||
      !legacyRetainedCoreMayDrain(report)) {
    throw new Error("CORE_LEGACY_RETAINED_NOT_QUIESCENT");
  }
  return report;
}

async function assertDelegateReleased(worker: CoreCheckpointWorker, serverToken: string): Promise<void> {
  const state = await callCoreWorkerDelegateBridge(worker.port, "status", serverToken);
  if (state.running || state.openSockets !== 0 || (state.pendingRequests ?? 0) !== 0) {
    throw new Error("CORE_LEGACY_RETAINED_DELEGATE_STILL_OWNED");
  }
}

async function requestGracefulWorkerShutdown(worker: CoreCheckpointWorker, serverToken: string): Promise<void> {
  const response = await fetch("http://127.0.0.1:" + worker.port + "/api/shutdown", {
    method: "POST",
    headers: { Authorization: "Bearer " + serverToken },
    redirect: "error",
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new Error("CORE_LEGACY_RETAINED_SHUTDOWN_REFUSED");
  await response.arrayBuffer();
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === "EPERM";
  }
}

async function waitForOriginalProcessExit(
  pid: number,
  identity: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await readProcessStartIdentity(pid);
    if (current && current !== identity) {
      throw new Error("CORE_LEGACY_RETAINED_PID_REUSED");
    }
    if (!pidExists(pid)) return;
    await pause(150);
  }
  throw new Error("CORE_LEGACY_RETAINED_EXIT_TIMEOUT");
}

export async function retireLegacyRetainedGeneration(
  input: { port?: number; pid: number; confirm: boolean },
): Promise<LegacyRetainedRetireResult> {
  const port = input.port ?? 7888;
  if (input.confirm !== true) {
    throw new Error("CORE_LEGACY_RETAINED_CONFIRM_REQUIRED");
  }
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535 ||
      !Number.isSafeInteger(input.pid) || input.pid <= 0) {
    throw new Error("CORE_LEGACY_RETAINED_INVALID_TARGET");
  }

  const before = await requestCoreSupervisor("status", port, 2500);
  assertSupervisorStatus(before, port);
  const { worker, checkpoint } = selectLegacyWorker(before, port, input.pid);
  const identity = await readProcessStartIdentity(worker.pid);
  if (!identity) throw new Error("CORE_LEGACY_RETAINED_PROCESS_IDENTITY_UNAVAILABLE");

  await fetchDrainReport(worker, checkpoint.inspectToken);
  await assertDelegateReleased(worker, checkpoint.serverToken);
  await pause(350);

  const rechecked = await requestCoreSupervisor("status", port, 2500);
  assertSupervisorStatus(rechecked, port);
  if (rechecked.supervisorPid !== before.supervisorPid ||
      rechecked.active.pid !== before.active.pid) {
    throw new Error("CORE_LEGACY_RETAINED_OWNER_CHANGED_DURING_REVIEW");
  }
  const second = selectLegacyWorker(rechecked, port, worker.pid);
  if (second.worker.generationId !== worker.generationId ||
      second.worker.port !== worker.port ||
      await readProcessStartIdentity(worker.pid) !== identity) {
    throw new Error("CORE_LEGACY_RETAINED_TARGET_CHANGED_DURING_REVIEW");
  }
  await fetchDrainReport(second.worker, second.checkpoint.inspectToken);
  await assertDelegateReleased(second.worker, second.checkpoint.serverToken);

  await requestGracefulWorkerShutdown(second.worker, second.checkpoint.serverToken);
  await waitForOriginalProcessExit(worker.pid, identity);

  let after = await requestCoreSupervisor("status", port, 2500);
  let metadataRetired = !after.retained.some(item => item.pid === worker.pid);
  if (!metadataRetired && after.currentBuild?.fresh === true &&
      /^[a-f0-9]{64}$/.test(after.currentBuild.digest)) {
    try {
      after = await requestCoreSupervisor("drain", port, 30_000, {
        operationId: crypto.randomUUID(),
        expectedBuildDigest: after.currentBuild.digest,
      });
      metadataRetired = !after.retained.some(item => item.pid === worker.pid);
    } catch {
      // Physical cleanup is already verified. Older supervisors may retain a
      // dead metadata tombstone until the supervisor itself is upgraded.
    }
  }

  return {
    port,
    retiredPid: worker.pid,
    physicalExitVerified: true,
    supervisorMetadataRetired: metadataRetired,
    activeWorkerPid: after.active.pid,
    note: metadataRetired
      ? "Legacy retained generation exited gracefully and supervisor metadata was retired."
      : "Legacy retained generation exited gracefully; an old supervisor still retains a dead metadata tombstone.",
  };
}

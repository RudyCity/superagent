/**
 * Read-only lifecycle verification against the REAL Core lifecycle functions,
 * with an injected supervisor stub. No live Core request/process/network call.
 */
import { describe, expect, it, vi } from "vitest";
import {
  controlCoreLifecycle, prepareCoreLifecycle,
} from "../src/core/runtime/coreLifecycleControl.js";
import type {
  CoreRuntimeStatus, requestCoreSupervisor,
} from "../src/core/runtime/coreSupervisor.js";

const PORT = 27888;
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const SUPERVISOR = 77101;
const WORKER = 77102;
const LATER_WORKER = 77103;
type Request = typeof requestCoreSupervisor;

function state(options: {
  supervisorPid?: number; workerPid?: number; fresh?: boolean;
  digest?: string; activeDigest?: string; retained?: CoreRuntimeStatus["retained"];
  validContract?: boolean; replayed?: boolean;
} = {}): CoreRuntimeStatus {
  return {
    ownerContract: options.validContract === false ? undefined : {
      version: 1, role: "core-supervisor", mcpLifecycle: "not-owned",
      replayPolicy: "explicit-resume-only",
    },
    supervisorPid: options.supervisorPid ?? SUPERVISOR,
    publicPort: PORT,
    active: {
      pid: options.workerPid ?? WORKER, port: 27889,
      since: 1_000, buildDigest: options.activeDigest ?? DIGEST_A,
      buildMode: "compiled",
    },
    retained: options.retained ?? [],
    currentBuild: {
      mode: "compiled", digest: options.digest ?? DIGEST_A,
      sourceDigest: DIGEST_B, fileCount: 829,
      fresh: options.fresh ?? true, builtAt: 2_000,
    },
    ...(options.replayed === undefined ? {} : {
      operation: {
        operationHashPrefix: "test",
        replayed: options.replayed,
        action: "restart" as const,
      },
    }),
  };
}

describe("Core lifecycle release gate, fake authenticated supervisor ONLY", () => {
  it("status is always read-only and verifies owner contract", async () => {
    const mock = vi.fn(async () => state({ fresh: false }));
    const status = await controlCoreLifecycle(
      "status", PORT, false, mock as unknown as Request,
    );
    expect(status.changed).toBe(false);
    expect(status.verified).toBe(true);
    expect(status.supervisorPid).toBe(SUPERVISOR);
    expect(status.activeWorkerPid).toBe(WORKER);
    expect(mock).toHaveBeenCalledExactlyOnceWith("status", PORT, 2500);
  });

  it("rejects missing owner attestation even for read-only status", async () => {
    const missing = vi.fn(async () => state({ validContract: false }));
    await expect(controlCoreLifecycle("status", PORT, false, missing as unknown as Request))
      .rejects.toThrow("CORE_CONTROL_OWNER_CHANGED_OR_UNVERIFIED");
    expect(missing).toHaveBeenCalledTimes(1);
    const otherSupervisor = vi.fn(async () => state({ supervisorPid: -1 }));
    await expect(prepareCoreLifecycle("restart", PORT, otherSupervisor as unknown as Request))
      .rejects.toThrow("CORE_CONTROL_OWNER_CHANGED_OR_UNVERIFIED");
    expect(otherSupervisor).toHaveBeenCalledTimes(1);
  });

  it("prevents restart planning on stale compiled source/dist without a mutation RPC", async () => {
    const stale = vi.fn(async () => state({ fresh: false }));
    await expect(prepareCoreLifecycle("restart", PORT, stale as unknown as Request))
      .rejects.toThrow("CORE_BUILD_UNVERIFIED");
    await expect(controlCoreLifecycle("restart", PORT, true, stale as unknown as Request))
      .rejects.toThrow("CORE_BUILD_UNVERIFIED");
    expect(stale.mock.calls).toHaveLength(2);
  });

  it("requires explicit confirmation and fences owner, worker and build changes before invoking restart", async () => {
    const mock = vi.fn(async () => state());
    await expect(controlCoreLifecycle("restart", PORT, false, mock as unknown as Request))
      .rejects.toThrow("CORE_CONTROL_CONFIRM_REQUIRED");
    expect(mock).not.toHaveBeenCalled();
    await expect(controlCoreLifecycle("restart", PORT, true,
      mock as unknown as Request, {
        expectedSupervisorPid: SUPERVISOR + 1, expectedWorkerPid: WORKER,
      })).rejects.toThrow("CORE_CONTROL_OWNER_CHANGED_SINCE_PLAN");
    await expect(controlCoreLifecycle("restart", PORT, true,
      mock as unknown as Request, {
        expectedSupervisorPid: SUPERVISOR, expectedWorkerPid: WORKER + 1,
      })).rejects.toThrow("CORE_CONTROL_OWNER_CHANGED_SINCE_PLAN");
    await expect(controlCoreLifecycle("restart", PORT, true,
      mock as unknown as Request, {
        expectedSupervisorPid: SUPERVISOR, expectedWorkerPid: WORKER,
        expectedBuildDigest: DIGEST_B,
      })).rejects.toThrow("CORE_BUILD_CHANGED_SINCE_PLAN");
    expect(mock.mock.calls.map(([action]) => action)).toEqual([
      "status", "status", "status",
    ]);
  });

  it("fresh preflight binds owner/generation and verified fake restart retains the old worker", async () => {
    const original = state({ activeDigest: DIGEST_B });
    const oldRetained = {
      pid: WORKER, port: 27889, since: 1_000,
      buildDigest: DIGEST_B, buildMode: "compiled" as const,
    };
    const next = state({
      workerPid: LATER_WORKER, activeDigest: DIGEST_A,
      retained: [oldRetained],
    });
    const planRpc = vi.fn(async () => original);
    const plan = await prepareCoreLifecycle("restart", PORT, planRpc as unknown as Request);
    expect(plan.expectedSupervisorPid).toBe(SUPERVISOR);
    expect(plan.expectedWorkerPid).toBe(WORKER);
    expect(plan.expectedBuildDigest).toBe(DIGEST_A);
    expect(plan.codeChangedSinceActiveWorker).toBe(true);
    expect(planRpc).toHaveBeenCalledExactlyOnceWith("status", PORT, 2500);

    // Fake request simulates the supervisor returning new immutable status.
    // No actual server or worker is started or stopped.
    const rpc = vi.fn(async (action: string) =>
      action === "status" && rpc.mock.calls.filter(([a]) => a === "status").length === 1
        ? original : next);
    const result = await controlCoreLifecycle(
      "restart", PORT, true, rpc as unknown as Request, {
        operationId: plan.operationId,
        expectedBuildDigest: plan.expectedBuildDigest,
        expectedSupervisorPid: plan.expectedSupervisorPid,
        expectedWorkerPid: plan.expectedWorkerPid,
      });
    expect(result.changed).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.previousWorkerPid).toBe(WORKER);
    expect(result.activeWorkerPid).toBe(LATER_WORKER);
    expect(rpc.mock.calls.map(([action]) => action)).toEqual([
      "status", "restart", "status",
    ]);
    expect(rpc.mock.calls[1]?.[3]).toEqual({
      operationId: plan.operationId, expectedBuildDigest: DIGEST_A,
    });
  });

  it("rejects a fake restart without retained previous worker or with changed supervisor", async () => {
    const original = state();
    const moved = state({ workerPid: LATER_WORKER, retained: [] });
    const rpc = vi.fn(async (action: string) =>
      action === "status" && rpc.mock.calls.filter(([a]) => a === "status").length === 1
        ? original : moved);
    await expect(controlCoreLifecycle("restart", PORT, true, rpc as unknown as Request))
      .rejects.toThrow("CORE_CONTROL_RESTART_NOT_VERIFIED");
    const changed = state({
      supervisorPid: SUPERVISOR + 1, workerPid: LATER_WORKER,
      retained: [{ ...original.active }],
    });
    const rpcChanged = vi.fn(async (action: string) =>
      action === "status" && rpcChanged.mock.calls.filter(([a]) => a === "status").length === 1
        ? original : changed);
    await expect(controlCoreLifecycle("restart", PORT, true, rpcChanged as unknown as Request))
      .rejects.toThrow("CORE_CONTROL_OWNER_CHANGED_OR_UNVERIFIED");
  });

  it("recognizes acknowledged operation replay without a second generation change", async () => {
    const original = state();
    const confirmed = state({ replayed: true });
    const rpc = vi.fn(async (action: string) =>
      action === "status" && rpc.mock.calls.filter(([a]) => a === "status").length === 1
        ? original : confirmed);
    const outcome = await controlCoreLifecycle("restart", PORT, true, rpc as unknown as Request);
    expect(outcome.changed).toBe(false);
    expect(outcome.replayed).toBe(true);
    expect(rpc.mock.calls.map(([action]) => action)).toEqual([
      "status", "restart", "status",
    ]);
  });
});

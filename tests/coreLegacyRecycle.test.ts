import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  planLegacyCoreRecycle,
  scheduleLegacyCoreRecycle,
  runLegacyCoreRecycleWorker,
  readLegacyCoreProcessDescriptor,
  legacyRecycleMayArchiveStaleSupervisorState,
  type LegacyCoreRecyclePlan,
} from "../src/core/runtime/coreLegacyRecycle.js";
import { ManagedSidecarLedger, sidecarOperationFingerprint } from "../src/core/runtime/managedSidecarLedger.js";
import { getRootConfigDir } from "../src/core/config/paths.js";

describe("Core Legacy Recycle", () => {
  it("rejects invalid plan arguments in scheduleLegacyCoreRecycle", async () => {
    const validPlan: LegacyCoreRecyclePlan = {
      service: "core",
      action: "recycle",
      port: 7888,
      operationId: crypto.randomUUID(),
      expectedOwnerPid: 1234,
      expectedProcessIdentity: "win:123456789012345678",
      expectedLegacyCommandDigest: "a".repeat(64),
      expectedBuildDigest: "b".repeat(64),
      clientMode: "tline",
      note: "test plan",
    };

    // Unconfirmed execution fails closed
    await expect(scheduleLegacyCoreRecycle(validPlan, false)).rejects.toThrow(
      "CORE_RECYCLE_EXPLICIT_CONFIRMATION_REQUIRED"
    );

    // Corrupted service
    await expect(
      scheduleLegacyCoreRecycle({ ...validPlan, service: "vision" as any }, true)
    ).rejects.toThrow("CORE_RECYCLE_INVALID_PLAN");

    // Invalid port
    await expect(
      scheduleLegacyCoreRecycle({ ...validPlan, port: 99 }, true)
    ).rejects.toThrow("CORE_RECYCLE_INVALID_PLAN");

    // Invalid owner pid
    await expect(
      scheduleLegacyCoreRecycle({ ...validPlan, expectedOwnerPid: -1 }, true)
    ).rejects.toThrow("CORE_RECYCLE_INVALID_PLAN");

    // Invalid process identity
    await expect(
      scheduleLegacyCoreRecycle(
        { ...validPlan, expectedProcessIdentity: "invalid-id" },
        true
      )
    ).rejects.toThrow("CORE_RECYCLE_INVALID_PLAN");

    // Invalid command digest length
    await expect(
      scheduleLegacyCoreRecycle(
        { ...validPlan, expectedLegacyCommandDigest: "short" },
        true
      )
    ).rejects.toThrow("CORE_RECYCLE_INVALID_PLAN");

    // Invalid build digest length
    await expect(
      scheduleLegacyCoreRecycle(
        { ...validPlan, expectedBuildDigest: "not-a-sha256" },
        true
      )
    ).rejects.toThrow("CORE_RECYCLE_INVALID_PLAN");

    // Invalid client mode
    await expect(
      scheduleLegacyCoreRecycle(
        { ...validPlan, clientMode: "web" as any },
        true
      )
    ).rejects.toThrow("CORE_RECYCLE_INVALID_PLAN");

    // Invalid operationId
    await expect(
      scheduleLegacyCoreRecycle(
        { ...validPlan, operationId: "invalid/chars" },
        true
      )
    ).rejects.toThrow();
  });

  it("worker fails closed when not spawned in helper context", async () => {
    const plan: LegacyCoreRecyclePlan = {
      service: "core",
      action: "recycle",
      port: 7888,
      operationId: crypto.randomUUID(),
      expectedOwnerPid: 1234,
      expectedProcessIdentity: "win:123456789012345678",
      expectedLegacyCommandDigest: "a".repeat(64),
      expectedBuildDigest: "b".repeat(64),
      clientMode: "tline",
      note: "test plan",
    };

    delete process.env.SUPERAGENT_CORE_RECYCLE_HELPER;
    await expect(runLegacyCoreRecycleWorker(plan)).rejects.toThrow(
      "CORE_RECYCLE_HELPER_CONTEXT_REQUIRED"
    );
  });

  it("only permits stale supervisor archive when durable evidence is fully reconciled", () => {
    const safe = {
      ownerOnline: false,
      foreignListenerDetected: true,
      discoveryPresent: true,
      guardianLeasePresent: false,
      discoveryStale: true,
      guardianLeaseStale: false,
      checkpoint: "valid" as const,
      workers: "all_dead" as const,
      ambiguousTurns: 0,
      persistedReceipts: 33,
      receiptsWithAcceptedTurn: 0,
      sessionReceiptsReconciled: true,
      externalEffectsReconciled: true,
    };
    expect(legacyRecycleMayArchiveStaleSupervisorState(safe)).toBe(true);
    expect(legacyRecycleMayArchiveStaleSupervisorState({
      ...safe, workers: "unknown",
    })).toBe(false);
    expect(legacyRecycleMayArchiveStaleSupervisorState({
      ...safe, ambiguousTurns: 1,
    })).toBe(false);
    expect(legacyRecycleMayArchiveStaleSupervisorState({
      ...safe, receiptsWithAcceptedTurn: 1, sessionReceiptsReconciled: false,
    })).toBe(false);
    expect(legacyRecycleMayArchiveStaleSupervisorState({
      ...safe, discoveryStale: false,
    })).toBe(false);
    expect(legacyRecycleMayArchiveStaleSupervisorState({
      ...safe, guardianLeasePresent: true, guardianLeaseStale: false,
    })).toBe(false);
  });

  it("descriptor reader rejects invalid PIDs", () => {
    expect(() => readLegacyCoreProcessDescriptor(0)).toThrow("CORE_RECYCLE_INVALID_OWNER_PID");
    expect(() => readLegacyCoreProcessDescriptor(-10)).toThrow("CORE_RECYCLE_INVALID_OWNER_PID");
    expect(() => readLegacyCoreProcessDescriptor(Number.NaN)).toThrow("CORE_RECYCLE_INVALID_OWNER_PID");
  });

  it("planLegacyCoreRecycle fails closed on invalid port or missing server", async () => {
    await expect(planLegacyCoreRecycle(99)).rejects.toThrow("CORE_RECYCLE_INVALID_PORT");
    await expect(planLegacyCoreRecycle(70000)).rejects.toThrow("CORE_RECYCLE_INVALID_PORT");
    // Non-existent listener on unused port
    await expect(planLegacyCoreRecycle(19489)).rejects.toThrow();
  });

  it("idempotently returns prior completed result when operation is replayed", async () => {
    const testPort = 19488;
    const testOpId = crypto.randomUUID();
    const plan: LegacyCoreRecyclePlan = {
      service: "core",
      action: "recycle",
      port: testPort,
      operationId: testOpId,
      expectedOwnerPid: 1234,
      expectedProcessIdentity: "win:123456789012345678",
      expectedLegacyCommandDigest: "a".repeat(64),
      expectedBuildDigest: "b".repeat(64),
      clientMode: "tline",
      note: "test replay plan",
    };

    const ledger = new ManagedSidecarLedger("core", testPort);
    const fingerprint = sidecarOperationFingerprint({
      service: "core",
      action: "recycle",
      port: plan.port,
      expectedOwnerPid: plan.expectedOwnerPid,
      expectedProcessIdentity: plan.expectedProcessIdentity,
      expectedLegacyCommandDigest: plan.expectedLegacyCommandDigest,
      expectedBuildDigest: plan.expectedBuildDigest,
      clientMode: plan.clientMode,
    });

    // Mock existing completed transaction in the ledger
    ledger.begin(testOpId, fingerprint);
    ledger.complete(testOpId, 5678);

    const check = ledger.lookup(testOpId, fingerprint);
    expect(check?.replayed).toBe(true);
    expect(check?.afterPid).toBe(5678);
  });
});

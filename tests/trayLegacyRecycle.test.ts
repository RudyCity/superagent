import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import {
  planLegacyTrayRecycle,
  executeLegacyTrayRecycle,
  readLegacyTrayDescriptor,
  type LegacyTrayRecyclePlan,
} from "../src/core/runtime/trayLegacyRecycle.js";
import { ManagedSidecarLedger, sidecarOperationFingerprint } from "../src/core/runtime/managedSidecarLedger.js";

describe("Tray Legacy Recycle", () => {
  it("rejects invalid plan arguments in executeLegacyTrayRecycle", async () => {
    const validPlan: LegacyTrayRecyclePlan = {
      service: "tray",
      action: "recycle",
      operationId: crypto.randomUUID(),
      expectedOwnerPid: 9876,
      expectedProcessIdentity: "win:123456789012345678",
      expectedExecutablePath: "C:\\Program Files\\SuperAgent\\superagent-tray.exe",
      expectedLegacyDigest: "a".repeat(64),
      targetBuildDigest: "b".repeat(64),
      noCoreShutdown: true,
      note: "tray recycle plan",
    };

    // Unconfirmed execution fails closed
    await expect(executeLegacyTrayRecycle(validPlan, false)).rejects.toThrow(
      "TRAY_RECYCLE_EXPLICIT_CONFIRMATION_REQUIRED"
    );

    // Corrupted service
    await expect(
      executeLegacyTrayRecycle({ ...validPlan, service: "core" as any }, true)
    ).rejects.toThrow("TRAY_RECYCLE_INVALID_PLAN");

    // Negative PID
    await expect(
      executeLegacyTrayRecycle({ ...validPlan, expectedOwnerPid: -1 }, true)
    ).rejects.toThrow("TRAY_RECYCLE_INVALID_PLAN");

    // Invalid process identity
    await expect(
      executeLegacyTrayRecycle(
        { ...validPlan, expectedProcessIdentity: "not-a-valid-birth-id" },
        true
      )
    ).rejects.toThrow("TRAY_RECYCLE_INVALID_PLAN");

    // Invalid legacy digest length
    await expect(
      executeLegacyTrayRecycle(
        { ...validPlan, expectedLegacyDigest: "short" },
        true
      )
    ).rejects.toThrow("TRAY_RECYCLE_INVALID_PLAN");

    // Invalid target build digest length
    await expect(
      executeLegacyTrayRecycle(
        { ...validPlan, targetBuildDigest: "not-64-hex" },
        true
      )
    ).rejects.toThrow("TRAY_RECYCLE_INVALID_PLAN");

    // noCoreShutdown must be true
    await expect(
      executeLegacyTrayRecycle({ ...validPlan, noCoreShutdown: false as any }, true)
    ).rejects.toThrow("TRAY_RECYCLE_INVALID_PLAN");
  });

  it("descriptor reader rejects invalid PIDs", () => {
    expect(() => readLegacyTrayDescriptor(0)).toThrow("TRAY_RECYCLE_INVALID_PID");
    expect(() => readLegacyTrayDescriptor(-5)).toThrow("TRAY_RECYCLE_INVALID_PID");
    expect(() => readLegacyTrayDescriptor(Number.NaN)).toThrow("TRAY_RECYCLE_INVALID_PID");
  });

  it("planLegacyTrayRecycle fails closed when no legacy Tray process is present", async () => {
    await expect(planLegacyTrayRecycle(99999999)).rejects.toThrow();
  });

  it("idempotently returns prior result when operation is replayed in ledger", async () => {
    const testOpId = crypto.randomUUID();
    const ledgerPort = 45323;
    const plan: LegacyTrayRecyclePlan = {
      service: "tray",
      action: "recycle",
      operationId: testOpId,
      expectedOwnerPid: 9876,
      expectedProcessIdentity: "win:123456789012345678",
      expectedExecutablePath: "C:\\trusted\\superagent-tray.exe",
      expectedLegacyDigest: "a".repeat(64),
      targetBuildDigest: "b".repeat(64),
      noCoreShutdown: true,
      note: "replay test",
    };

    const ledger = new ManagedSidecarLedger("tray", ledgerPort);
    const signature = sidecarOperationFingerprint({
      service: "tray",
      action: "recycle",
      expectedOwnerPid: plan.expectedOwnerPid,
      expectedProcessIdentity: plan.expectedProcessIdentity,
      expectedLegacyDigest: plan.expectedLegacyDigest,
      targetBuildDigest: plan.targetBuildDigest,
      noCoreShutdown: true,
    });

    ledger.begin(testOpId, signature);
    ledger.complete(testOpId, 11223);

    const check = ledger.lookup(testOpId, signature);
    expect(check?.replayed).toBe(true);
    expect(check?.afterPid).toBe(11223);
  });
});

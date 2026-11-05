import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import {
  planLegacyVisionRecycle,
  executeLegacyVisionRecycle,
  type LegacyVisionRecyclePlan,
} from "../src/core/runtime/visionLegacyRecycle.js";
import { ManagedSidecarLedger, sidecarOperationFingerprint } from "../src/core/runtime/managedSidecarLedger.js";

describe("Vision Legacy Recycle", () => {
  it("rejects invalid plan arguments in executeLegacyVisionRecycle", async () => {
    const validPlan: LegacyVisionRecyclePlan = {
      service: "vision",
      action: "recycle",
      port: 8095,
      operationId: crypto.randomUUID(),
      expectedOwnerPid: 5432,
      expectedProcessIdentity: "win:123456789012345678",
      expectedScriptDigest: "a".repeat(64),
      supportsGracefulShutdown: true,
      noPublicIngress: true,
      note: "vision recycle plan",
    };

    // Unconfirmed execution fails closed
    await expect(executeLegacyVisionRecycle(validPlan, false)).rejects.toThrow(
      "VISION_RECYCLE_EXPLICIT_CONFIRMATION_REQUIRED"
    );

    // Corrupted service
    await expect(
      executeLegacyVisionRecycle({ ...validPlan, service: "core" as any }, true)
    ).rejects.toThrow("VISION_RECYCLE_INVALID_PLAN");

    // Invalid port
    await expect(
      executeLegacyVisionRecycle({ ...validPlan, port: 80 }, true)
    ).rejects.toThrow("VISION_RECYCLE_INVALID_PLAN");

    // Negative PID
    await expect(
      executeLegacyVisionRecycle({ ...validPlan, expectedOwnerPid: -1 }, true)
    ).rejects.toThrow("VISION_RECYCLE_INVALID_PLAN");

    // Invalid process identity
    await expect(
      executeLegacyVisionRecycle(
        { ...validPlan, expectedProcessIdentity: "not-a-valid-birth-id" },
        true
      )
    ).rejects.toThrow("VISION_RECYCLE_INVALID_PLAN");

    // Invalid script digest length
    await expect(
      executeLegacyVisionRecycle(
        { ...validPlan, expectedScriptDigest: "short" },
        true
      )
    ).rejects.toThrow("VISION_RECYCLE_INVALID_PLAN");

    // Fails closed if graceful shutdown is false
    await expect(
      executeLegacyVisionRecycle(
        { ...validPlan, supportsGracefulShutdown: false },
        true
      )
    ).rejects.toThrow("VISION_RECYCLE_GRACEFUL_STOP_UNAVAILABLE");
  });

  it("planLegacyVisionRecycle protects reserved ports", async () => {
    await expect(planLegacyVisionRecycle(7888)).rejects.toThrow("VISION_RECYCLE_INVALID_OR_PROTECTED_PORT");
    await expect(planLegacyVisionRecycle(8857)).rejects.toThrow("VISION_RECYCLE_INVALID_OR_PROTECTED_PORT");
    await expect(planLegacyVisionRecycle(9225)).rejects.toThrow("VISION_RECYCLE_INVALID_OR_PROTECTED_PORT");
    await expect(planLegacyVisionRecycle(9227)).rejects.toThrow("VISION_RECYCLE_INVALID_OR_PROTECTED_PORT");
    await expect(planLegacyVisionRecycle(99)).rejects.toThrow("VISION_RECYCLE_INVALID_OR_PROTECTED_PORT");
  });

  it("planLegacyVisionRecycle fails closed on unoccupied port", async () => {
    await expect(planLegacyVisionRecycle(19599)).rejects.toThrow("VISION_RECYCLE_NO_LISTENER");
  });

  it("idempotently returns prior result when operation is replayed in ledger", async () => {
    const testPort = 19588;
    const testOpId = crypto.randomUUID();
    const plan: LegacyVisionRecyclePlan = {
      service: "vision",
      action: "recycle",
      port: testPort,
      operationId: testOpId,
      expectedOwnerPid: 5432,
      expectedProcessIdentity: "win:123456789012345678",
      expectedScriptDigest: "a".repeat(64),
      supportsGracefulShutdown: true,
      noPublicIngress: true,
      note: "replay test",
    };

    const ledger = new ManagedSidecarLedger("vision", testPort);
    const signature = sidecarOperationFingerprint({
      service: "vision",
      action: "recycle",
      port: plan.port,
      expectedOwnerPid: plan.expectedOwnerPid,
      expectedProcessIdentity: plan.expectedProcessIdentity,
      expectedScriptDigest: plan.expectedScriptDigest,
      noPublicIngress: true,
    });

    ledger.begin(testOpId, signature);
    ledger.complete(testOpId, 9988);

    const check = ledger.lookup(testOpId, signature);
    expect(check?.replayed).toBe(true);
    expect(check?.afterPid).toBe(9988);
  });
});

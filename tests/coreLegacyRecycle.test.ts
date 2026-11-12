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
  acceptsRecycleCoreOwnerEvidence,
  inspectLegacyCoreRecycleReadiness,
  recognizesOwnedPackagedCore,
  type LegacyCoreRecyclePlan,
} from "../src/core/runtime/coreLegacyRecycle.js";
import { ManagedSidecarLedger, sidecarOperationFingerprint } from "../src/core/runtime/managedSidecarLedger.js";
import { getRootConfigDir } from "../src/core/config/paths.js";

describe("Core Legacy Recycle", () => {
  it("attests Windows PID-0 listeners without accepting missing or conflicting owners", () => {
    const safe = {
      platform: "win32",
      kernelOwner: 0,
      candidatePid: 27392,
      serverInfoPid: 27392,
      birth: "matched" as const,
      authenticated: true,
    };
    expect(acceptsRecycleCoreOwnerEvidence(safe)).toBe(true);
    expect(acceptsRecycleCoreOwnerEvidence({
      ...safe, kernelOwner: 27392, birth: "unverified",
    })).toBe(true);
    expect(acceptsRecycleCoreOwnerEvidence({...safe, kernelOwner: null})).toBe(false);
    expect(acceptsRecycleCoreOwnerEvidence({...safe, kernelOwner: 0, platform: "linux"})).toBe(false);
    expect(acceptsRecycleCoreOwnerEvidence({...safe, kernelOwner: 45678})).toBe(false);
    expect(acceptsRecycleCoreOwnerEvidence({...safe, serverInfoPid: 45678})).toBe(false);
    expect(acceptsRecycleCoreOwnerEvidence({...safe, candidatePid: 0})).toBe(false);
    expect(acceptsRecycleCoreOwnerEvidence({...safe, birth: "mismatch"})).toBe(false);
    expect(acceptsRecycleCoreOwnerEvidence({...safe, birth: "unverified"})).toBe(false);
    expect(acceptsRecycleCoreOwnerEvidence({...safe, authenticated: false})).toBe(false);
  });

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

  it("diagnoses missing legacy owners without issuing a recycle operation", async () => {
    const report = await inspectLegacyCoreRecycleReadiness(19489);
    expect(report.service).toBe("core");
    expect(report.action).toBe("recycle");
    expect(report.ready).toBe(false);
    expect(report.owner.verified).toBe(false);
    expect(report.owner.pid).toBeNull();
    expect(report.blockers).toContain("CORE_RECYCLE_NO_LISTENER");
    expect(report).not.toHaveProperty("operationId");
    expect(JSON.stringify(report)).not.toContain("authToken");
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

describe("Windows packaged legacy Core owner attestation", () => {
  it("accepts only the exact bundled Bun and entry pair", () => {
    if (process.platform !== "win32") return;
    const root = path.win32.resolve("D:/development/superagent");
    const dir = path.win32.join(root, "apps", "superagent-tray", "src-tauri", "target", "release");
    const exe = path.win32.join(dir, "bun.exe");
    const script = path.win32.join(dir, "standalone", "dist", "cli.js");
    const makeCmd = (p: string) => String.fromCharCode(34) + exe + String.fromCharCode(34) + " " + String.fromCharCode(34) + p + String.fromCharCode(34) + " --server 7888";
    const valid = { executablePath: exe, commandLine: makeCmd(script) };
    expect(recognizesOwnedPackagedCore(valid, root)).toBe(true);
    expect(recognizesOwnedPackagedCore({ ...valid, executablePath: "C:\temp\bun.exe" }, root)).toBe(false);
    expect(recognizesOwnedPackagedCore({ ...valid, commandLine: makeCmd("C:\temp\standalone\dist\cli.js") }, root)).toBe(false);
    expect(recognizesOwnedPackagedCore({ ...valid, commandLine: "garbage " + makeCmd(script) }, root)).toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import {
  GlobalRecycleLedger,
  executeGlobalLifecycleRecycle,
  type GlobalRecyclePlan,
} from "../src/core/runtime/globalLifecycleRecycle.js";
import { manageServices } from "../src/core/runtime/serviceManager.js";

function fakePlan(disposition: "keep" | "recycle" | "start" = "keep"): GlobalRecyclePlan {
  const now = Date.now();
  return {
    version: 1,
    operationId: crypto.randomUUID(),
    createdAt: now,
    expiresAt: now + 300000,
    dependencyOrder: ["core"],
    children: [{
      service: "core",
      disposition,
      reasonCode: "TEST_ONLY",
      note: "synthetic negative test; no live migration",
      dependencyState: [],
    }],
    summary: {
      total: 1,
      mutations: disposition === "keep" ? 0 : 1,
      noops: disposition === "keep" ? 1 : 0,
      blocked: 0,
    },
    publicTunnelMutationAllowed: false,
    arbitraryPidKillAllowed: false,
    note: "negative tests",
  };
}

describe("Global Lifecycle immutable-plan safety", () => {
  it("rejects a forged request with same operation ID but modified plan", async () => {
    const ledger = new GlobalRecycleLedger();
    const plan = fakePlan();
    ledger.recordPlan(plan);
    await expect(executeGlobalLifecycleRecycle({...plan, note: "forged"}, true))
      .rejects.toThrow("GLOBAL_RECYCLE_PLAN_FINGERPRINT_MISMATCH");
  });

  it("cannot replay an uncertain operation using a new request with same ID", async () => {
    const ledger = new GlobalRecycleLedger();
    const plan = fakePlan();
    ledger.recordPlan(plan);
    ledger.fail(plan.operationId, "uncertain", "test crash");
    await expect(executeGlobalLifecycleRecycle(plan, true))
      .rejects.toThrow("GLOBAL_RECYCLE_IN_PROGRESS_OR_UNCERTAIN_RECONCILE_FIRST");
  });

  it("refuses to mark potentially mutated children reconciled without owner evidence", () => {
    const ledger = new GlobalRecycleLedger();
    const plan = fakePlan("recycle");
    ledger.recordPlan(plan);
    ledger.fail(plan.operationId, "uncertain", "test ambiguity");
    expect(() => ledger.reconcile(plan.operationId, true))
      .toThrow("GLOBAL_RECYCLE_RECONCILE_REQUIRES_CHILD_OWNER_EVIDENCE");
  });

  it("never executes unsupported START from global recycle", async () => {
    const ledger = new GlobalRecycleLedger();
    const plan = fakePlan("start");
    ledger.recordPlan(plan);
    await expect(executeGlobalLifecycleRecycle(plan, true))
      .rejects.toThrow("GLOBAL_RECYCLE_UNSUPPORTED_CHILD_MUTATION");
  });

  it("refuses to overwrite an existing operation ID", () => {
    const ledger = new GlobalRecycleLedger();
    const plan = fakePlan();
    ledger.recordPlan(plan);
    expect(() => ledger.recordPlan(plan))
      .toThrow("GLOBAL_RECYCLE_OPERATION_ALREADY_EXISTS");
  });

  it("service manager uses the original stored plan, not a newly generated plan", async () => {
    const ledger = new GlobalRecycleLedger();
    const plan = fakePlan("start");
    ledger.recordPlan(plan);
    await expect(manageServices({
      action:"recycle", service:"all", confirm:true, operationId:plan.operationId,
    })).rejects.toThrow("GLOBAL_RECYCLE_UNSUPPORTED_CHILD_MUTATION");
  });
});

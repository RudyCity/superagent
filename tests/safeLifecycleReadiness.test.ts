import { describe, expect, it } from "vitest";
import {
  assessIndependentLifecycleReadiness, assessSafeLifecycleReadiness,
  type LifecycleEvidence, type LifecyclePlan,
} from "../src/core/runtime/safeLifecycleReadiness.js";

const hash = "a".repeat(64);
const op = "123e4567-e89b-42d3-a456-426614174000";
const corePlan: LifecyclePlan = {
  service: "core", action: "restart", operationId: op,
  expectedBuildDigest: hash, supervisorPid: 100, activeWorkerPid: 101, port: 7888,
};
const core: LifecycleEvidence = {
  service: "core", ownerVerified: true, ownerPid: 100, port: 7888,
  activeWorkerPid: 101, buildFresh: true, buildDigest: hash,
  observedBuildDigest: hash, pendingUncertainOperations: 0,
  unverifiedForeignProcesses: 0, sessionCount: 3, retainedWorkerCount: 2, supervisorLifecycleVersion: 2,
  permittedActions: ["restart", "rollback", "drain"],
};
const trayPlan: LifecyclePlan = {
  service: "tray", action: "restart", operationId: op,
  expectedBuildDigest: hash, expectedOwnerPid: 200,
  expectedInstanceId: "b".repeat(32), port: 45321, noCoreShutdown: true,
};
const tray: LifecycleEvidence = {
  service: "tray", ownerVerified: true, ownerPid: 200,
  instanceId: "b".repeat(32), port: 45321,
  buildFresh: true, buildDigest: hash, observedBuildDigest: hash,
  pendingUncertainOperations: 0, unverifiedForeignProcesses: 0,
  permittedActions: ["restart", "stop"],
};
describe("pure safe lifecycle readiness", () => {
  it("accepts independently verified plans without authorizing mutations", () => {
    const v = assessIndependentLifecycleReadiness({
      core: {plan: corePlan, evidence: core},
      tray: {plan: trayPlan, evidence: tray},
    });
    expect(v.core.status).toBe("ready");
    expect(v.tray.status).toBe("ready");
    expect(v.core.mutationAuthorized).toBe(false);
    expect(Object.isFrozen(v.core.reasons)).toBe(true);
    expect(Object.isFrozen(v)).toBe(true);
  });
  it.each([
    [{ownerVerified:false}, "OWNER_UNVERIFIED"],
    [{ownerPid:999}, "OWNER_CHANGED"],
    [{buildFresh:false}, "BUILD_STALE"],
    [{supervisorLifecycleVersion:0}, "SUPERVISOR_PROTOCOL_UNVERIFIED"],
    [{observedBuildDigest:"c".repeat(64)}, "BUILD_MISMATCH"],
    [{pendingUncertainOperations:1}, "UNCERTAIN_OPERATION"],
    [{unverifiedForeignProcesses:1}, "FOREIGN_PROCESS_UNVERIFIED"],
    [{retainedWorkerCount:4}, "RETAINED_LIMIT"],
    [{retainedWorkerCount:undefined}, "SESSION_EVIDENCE_MISSING"],
    [{sessionCount:undefined}, "SESSION_EVIDENCE_MISSING"],
  ] as const)("blocks unsafe Core evidence %o", (patch, reason) => {
    expect(assessSafeLifecycleReadiness(corePlan, {...core,...patch}, "core").reasons)
      .toContain(reason);
  });
  it("does not apply restart retained limit to drain", () => {
    expect(assessSafeLifecycleReadiness({...corePlan,action:"drain"},
      {...core,retainedWorkerCount:4}, "core").ready).toBe(true);
  });
  it.each([
    [{ownerVerified:false}, "OWNER_UNVERIFIED"],
    [{instanceId:"c".repeat(32)}, "OWNER_CHANGED"],
    [{pendingUncertainOperations:1}, "UNCERTAIN_OPERATION"],
    [{unverifiedForeignProcesses:1}, "FOREIGN_PROCESS_UNVERIFIED"],
    [{buildFresh:false}, "BUILD_STALE"],
  ] as const)("blocks unsafe Tray evidence %o", (patch, reason) => {
    expect(assessSafeLifecycleReadiness(trayPlan, {...tray,...patch}, "tray").reasons)
      .toContain(reason);
  });
  it("blocks missing plans and cross-service scope", () => {
    expect(assessSafeLifecycleReadiness(null, core, "core").ready).toBe(false);
    expect(assessSafeLifecycleReadiness(trayPlan, core, "core").reasons).toContain("SCOPE_INVALID");
  });
  it("blocks invalid operation ID and mismatched plan digest", () => {
    expect(assessSafeLifecycleReadiness({...corePlan,operationId:"bad"},core,"core").reasons)
      .toContain("OPERATION_INVALID");
    expect(assessSafeLifecycleReadiness({...corePlan,expectedBuildDigest:"d".repeat(64)},core,"core").reasons)
      .toContain("BUILD_MISMATCH");
  });
  it("requires explicit Tray Core protection", () => {
    expect(assessSafeLifecycleReadiness({...trayPlan,noCoreShutdown:false},tray,"tray").reasons)
      .toContain("CORE_PROTECTION_MISSING");
  });
  it("permits owner-absent Tray start only with explicit zero/absent identity", () => {
    const p: LifecyclePlan = {...trayPlan,action:"start",expectedOwnerPid:0,
      expectedInstanceId:"absent",port:undefined};
    const e: LifecycleEvidence = {...tray,ownerPid:null,instanceId:undefined,port:undefined,
      permittedActions:["start"]};
    expect(assessSafeLifecycleReadiness(p,e,"tray").ready).toBe(true);
    expect(assessSafeLifecycleReadiness(p,{...e,ownerPid:45},"tray").ready).toBe(false);
  });
  it("does not leak opaque credentials or mutate caller objects", () => {
    const original = {...tray, token:"SECRET_TOKEN_SHOULD_NOT_APPEAR"};
    const before = JSON.stringify(original);
    const v = assessSafeLifecycleReadiness(trayPlan,original,"tray");
    expect(JSON.stringify(v)).not.toContain("SECRET_TOKEN");
    expect(JSON.stringify(original)).toBe(before);
  });
});

import {afterEach, describe, expect, it, vi} from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {controlCoreLifecycle, prepareCoreLifecycle} from "../src/core/runtime/coreLifecycleControl.js";
import {mayCreateCoreGeneration, rollbackCandidates, applyCoreRollback, MAX_RETAINED_CORE_WORKERS} from "../src/core/runtime/coreGenerationPolicy.js";
import {ManagedSidecarLedger, sidecarOperationFingerprint} from "../src/core/runtime/managedSidecarLedger.js";
import {executeManagedTray, executeManagedTrayRelease, readManagedTrayOwner} from "../src/core/runtime/managedTrayControl.js";
import {validateManageServicesArgs} from "../src/core/runtime/serviceManager.js";
import {restoreTrayReleaseState, readTrayReleaseState} from "../src/core/runtime/trayReleaseStore.js";
import type {CoreRuntimeStatus} from "../src/core/runtime/coreSupervisor.js";

const port = 19777;
const digest = "a".repeat(64);
const priorDigest = "b".repeat(64);
const before: CoreRuntimeStatus = {
  supervisorPid: 111, publicPort: port,
  active: {pid: 222, port: 29777, since: 1, buildDigest: priorDigest, buildMode: "source"},
  retained: [],
  currentBuild: {mode: "source", digest, sourceDigest: digest, fileCount: 2, fresh: true},
  affinitySessions: 2,
  ownerContract: {version: 1, role: "core-supervisor", mcpLifecycle: "not-owned", replayPolicy: "explicit-resume-only"},
};
const after: CoreRuntimeStatus = {
  ...before, active: {pid: 333, port: 29778, since: 2, buildDigest: digest, buildMode: "source"},
  retained: [before.active],
};
const previousConfig = process.env.SUPERAGENT_CONFIG_DIR;
const fixtures: string[] = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "safe-lifecycle-guards-"));
  fixtures.push(root);
  process.env.SUPERAGENT_CONFIG_DIR = root;
  return root;
}
afterEach(() => {
  for (const root of fixtures.splice(0)) fs.rmSync(root, {recursive: true, force: true});
  if (previousConfig === undefined) delete process.env.SUPERAGENT_CONFIG_DIR;
  else process.env.SUPERAGENT_CONFIG_DIR = previousConfig;
});
const request = (...statuses: CoreRuntimeStatus[]) => vi.fn().mockImplementation(async () => {
  if (!statuses.length) throw new Error("FIXTURE_EXHAUSTED");
  return statuses.shift()!;
});

describe("safe lifecycle owner gates: fake Core supervisor only", () => {
  it("blocks mutation before calling a request without explicit confirmation", async () => {
    const send = vi.fn();
    await expect(controlCoreLifecycle("restart", port, false, send)).rejects.toThrow("CORE_CONTROL_CONFIRM_REQUIRED");
    expect(send).not.toHaveBeenCalled();
  });
  it.each([
    ["wrong public listener", {...before, publicPort: 19778}],
    ["missing supervisor owner contract", {...before, ownerContract: undefined}],
    ["MCP lifecycle incorrectly owned", {...before, ownerContract: {...before.ownerContract!, mcpLifecycle: "owned" as "not-owned"}}],
    ["public and worker ports collide", {...before, active: {...before.active, port}}],
  ])("rejects %s before selecting any mutation", async (_name, invalid) => {
    const send = request(invalid);
    await expect(prepareCoreLifecycle("restart", port, send)).rejects.toThrow("CORE_CONTROL_OWNER_CHANGED_OR_UNVERIFIED");
    expect(send.mock.calls.map(c => c[0])).toEqual(["status"]);
  });
  it("blocks stale source/build and a changed planned digest before mutation", async () => {
    const stale = request({...before, currentBuild: {...before.currentBuild!, fresh: false}});
    await expect(prepareCoreLifecycle("restart", port, stale)).rejects.toThrow("CORE_BUILD_UNVERIFIED");
    const changed = request(before);
    await expect(controlCoreLifecycle("restart", port, true, changed, {
      operationId: "core-guard-planned-0001", expectedBuildDigest: "f".repeat(64),
    })).rejects.toThrow("CORE_BUILD_CHANGED_SINCE_PLAN");
    expect(changed.mock.calls.map(c => c[0])).toEqual(["status"]);
  });
  it("rejects a swapped supervisor after fake restart, without claiming success", async () => {
    const send = request(before, {...after, supervisorPid: 999});
    await expect(controlCoreLifecycle("restart", port, true, send)).rejects.toThrow("CORE_CONTROL_OWNER_CHANGED_OR_UNVERIFIED");
    expect(send.mock.calls.map(c => c[0])).toEqual(["status", "restart"]);
  });
  it("rejects unstable post-operation generation and missing retained session owner", async () => {
    const unstable = request(before, after, {...after, active: {...after.active, pid: 444}});
    await expect(controlCoreLifecycle("restart", port, true, unstable)).rejects.toThrow("CORE_CONTROL_GENERATION_UNSTABLE");
    const missing = request(before, {...after, retained: []}, {...after, retained: []});
    await expect(controlCoreLifecycle("restart", port, true, missing)).rejects.toThrow("CORE_CONTROL_RESTART_NOT_VERIFIED");
  });
  it("rejects unattested build after restart and no-op rollback", async () => {
    const mismatched = {...after, active: {...after.active, buildDigest: priorDigest}};
    await expect(controlCoreLifecycle("restart", port, true, request(before, mismatched, mismatched)))
      .rejects.toThrow("CORE_BUILD_ATTESTATION_MISMATCH");
    await expect(controlCoreLifecycle("rollback", port, true, request(before, before, before)))
      .rejects.toThrow("CORE_CONTROL_ROLLBACK_NOT_VERIFIED");
  });
  it("acknowledges completed replay as unchanged; no second request from this wrapper", async () => {
    const replay = {...after, operation: {action: "restart" as const, replayed: true, operationHashPrefix: "0".repeat(16)}};
    const send = request(after, replay, after);
    const result = await controlCoreLifecycle("restart", port, true, send, {
      operationId: "core-guard-replay-0001", expectedBuildDigest: digest,
    });
    expect(result).toMatchObject({changed: false, replayed: true});
    expect(send.mock.calls.map(c => c[0])).toEqual(["status", "restart", "status"]);
  });
});

describe("retained worker rollback selection is conservative and pure", () => {
  it("refuses generation creation at capacity or on invalid counts", () => {
    expect(mayCreateCoreGeneration(MAX_RETAINED_CORE_WORKERS)).toBe(false);
    expect(mayCreateCoreGeneration(-1)).toBe(false);
    expect(mayCreateCoreGeneration(Number.NaN)).toBe(false);
    expect(mayCreateCoreGeneration(MAX_RETAINED_CORE_WORKERS - 1)).toBe(true);
  });
  it("does not choose active PID and prefers most recently retained candidate", () => {
    const retained = [{pid: 10, port: 31010, since: 1}, {pid: 20, port: 31020, since: 2}, {pid: 30, port: 31030, since: 3}];
    expect(rollbackCandidates(retained, 30).map(x => x.pid)).toEqual([20, 10]);
    expect(retained.map(x => x.pid)).toEqual([10, 20, 30]);
    expect(applyCoreRollback(retained[2], retained, 999, true)).toBeUndefined();
    const result = applyCoreRollback(retained[2], retained, 20, true)!;
    expect(result.active.pid).toBe(20);
    expect(result.retained.map(x => x.pid)).toEqual([10, 30]);
  });
});

describe("isolated Tray owner record and operation journals", () => {
  it("fails closed on invalid Tray record without health probe or process control", () => {
    const root = fixture();
    fs.writeFileSync(path.join(root, "tray-lifecycle-owner.json"), JSON.stringify({
      version: 1, pid: 4444, instanceId: "invalid", token: "invalid", controlPort: 30000,
      executablePath: path.join(root, "tray.exe"),
    }));
    expect(() => readManagedTrayOwner()).toThrow("TRAY_OWNER_RECORD_INVALID");
  });
  it("rejects cross-service shutdown omission before ledger or process discovery", async () => {
    fixture();
    const args = {
      service: "tray" as const, action: "restart" as const, confirm: true,
      operationId: "tray-guard-test-00001", expectedOwnerPid: 0,
      expectedInstanceId: "absent", expectedBuildDigest: digest,
      noCoreShutdown: false as true,
      note: "isolated invalid gate",
    };
    await expect(executeManagedTray(args)).rejects.toThrow("TRAY_EXPLICIT_CONFIRMATION_REQUIRED");
    await expect(executeManagedTrayRelease({
      ...args, action: "upgrade", expectedReleaseRevision: "0".repeat(24),
      expectedCurrentDigest: null,
    })).rejects.toThrow("TRAY_RELEASE_EXPLICIT_APPROVAL_REQUIRED");
  });
  it("blocks pending and conflicting operation IDs and never persists plaintext IDs", () => {
    fixture();
    const ledger = new ManagedSidecarLedger("tray", 45322);
    const id = "tray-guard-pending-00001";
    const start = sidecarOperationFingerprint({action: "restart", owner: 111});
    const other = sidecarOperationFingerprint({action: "stop", owner: 111});
    ledger.begin(id, start);
    expect(() => ledger.lookup(id, start)).toThrow("SIDECAR_OPERATION_UNCERTAIN_PENDING");
    expect(() => ledger.lookup(id, other)).toThrow("SIDECAR_OPERATION_ID_CONFLICT");
    expect(() => ledger.begin("tray-guard-other-00002", start)).toThrow("SIDECAR_OPERATION_UNCERTAIN_PENDING");
    expect(() => ledger.reconcile(id, false, true)).toThrow("SIDECAR_RECONCILE_REQUIRES_OWNER_ABSENCE_AND_APPROVAL");
    expect(() => ledger.reconcile(id, true, false)).toThrow("SIDECAR_RECONCILE_REQUIRES_OWNER_ABSENCE_AND_APPROVAL");
    expect(() => ledger.reconcile(id, true, true)).toThrow("SIDECAR_RECONCILE_COOLDOWN_120_SECONDS");
    expect(fs.readFileSync(ledger.file, "utf8")).not.toContain(id);
  });
  it("reviewed stale pending record cannot be replayed or represented as completed", () => {
    fixture();
    const ledger = new ManagedSidecarLedger("tray", 45322);
    const id = "tray-guard-reviewed-0001", fingerprint = sidecarOperationFingerprint({action: "restart"});
    ledger.begin(id, fingerprint);
    const content = JSON.parse(fs.readFileSync(ledger.file, "utf8"));
    content.receipts[0].startedAt = Date.now() - 121000;
    fs.writeFileSync(ledger.file, JSON.stringify(content));
    const result = ledger.reconcile(id, true, true);
    expect(result).toMatchObject({state: "reviewed", executedAgain: false});
    expect(() => ledger.lookup(id, fingerprint)).toThrow("SIDECAR_OPERATION_REVIEWED_NOT_REPLAYABLE");
    expect(ledger.inspect()[0]?.state).toBe("reviewed");
  });
  it("rejects malformed ledger and refuses to interpret it as empty", () => {
    fixture();
    const ledger = new ManagedSidecarLedger("tray", 45322);
    fs.writeFileSync(ledger.file, '{"version":1,"service":"tray","port":45322,"receipts":[{}]}');
    expect(() => ledger.inspect()).toThrow("SIDECAR_LEDGER_CORRUPT");
  });
  it("restore rejects stale release revision using only an isolated release manifest", () => {
    const root = fixture();
    const state = readTrayReleaseState(root);
    expect(() => restoreTrayReleaseState(state, "f".repeat(24), root))
      .toThrow("TRAY_RELEASE_CHANGED_DURING_RECOVERY");
  });
});

describe("service-manager public boundary is strict without manageServices calls", () => {
  it("rejects unrecognized targets, actions and invented bypass parameters", () => {
    expect(() => validateManageServicesArgs({action: "restart", service: "external"})).toThrow("SERVICE_UNKNOWN_TARGET");
    expect(() => validateManageServicesArgs({action: "kill", service: "tray"})).toThrow("SERVICE_UNKNOWN_ACTION");
    expect(() => validateManageServicesArgs({action: "restart", service: "core", forceKill: true})).toThrow("SERVICE_UNEXPECTED_ARGUMENT");
  });
  it("blocks forged digest, owner identity and cross-service noCoreShutdown type", () => {
    expect(() => validateManageServicesArgs({action: "restart", service: "core", expectedBuildDigest: "bad"})).toThrow("SERVICE_INVALID_BUILD_DIGEST");
    expect(() => validateManageServicesArgs({action: "restart", service: "tray", expectedOwnerPid: -5})).toThrow("SERVICE_INVALID_OWNER_PID");
    expect(() => validateManageServicesArgs({action: "restart", service: "tray", noCoreShutdown: "yes"})).toThrow("SERVICE_INVALID_CORE_PROTECTION");
  });
});

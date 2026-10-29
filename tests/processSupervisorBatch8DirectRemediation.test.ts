import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ProcessRegistry,
  getRuntimeGeneration,
} from "../src/core/process/processRegistry.js";
import { reconcileStartupProcesses } from "../src/core/process/processReconciliation.js";
import { ProcessSupervisor } from "../src/core/process/processSupervisor.js";
import {
  isValidJobCheckpoint,
  writeJobCheckpoint,
  type JobCheckpoint,
} from "../src/core/tools/cliBridgeReconciliation.js";

describe("Batch 8 direct remediation — independent audit reproductions", () => {
  const roots: string[] = [];

  async function tempRoot(): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "superagent-b8-"));
    roots.push(root);
    return root;
  }

  afterEach(async () => {
    for (const root of roots.splice(0)) {
      await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("P0: local hasMutatingWrite:false cannot suppress review after terminal failure", async () => {
    const root = await tempRoot();
    const registry = new ProcessRegistry({ storagePath: path.join(root, "registry.json") });
    const now = Date.now();
    registry.addRecord({
      recordId: "failed_local_readonly_claim",
      pid: 991991,
      parentPid: 1,
      creationIdentity: "mock",
      executable: "node.exe",
      sanitizedArgs: [],
      runtimeGeneration: getRuntimeGeneration(),
      ownership: { workspaceRoot: root, jobId: "job_false_readonly" },
      component: "cli_bridge_delegate",
      launchIntent: "headless",
      state: "failed",
      lifecycle: "job",
      cleanupPolicy: "caller_owned",
      exitCode: 1,
      signal: null,
      terminalObservation: { observedAt: now, exitCode: 1, signal: null },
      registeredAt: now - 10_000,
      updatedAt: now,
    });

    const checkpoint: JobCheckpoint = {
      checkpointId: "cp_false_ro",
      jobId: "job_false_readonly",
      timestamp: now,
      lastEvent: "job_finished_failed",
      resourceClaims: [],
      verificationState: "failed",
      hasMutatingWrite: false,
    };

    const report = await reconcileStartupProcesses(
      registry,
      { callerWorkspaceRoot: root },
      { readJobCheckpoint: async () => checkpoint }
    );

    expect(report.mutatingJobsRequiringReview).toBe(1);
    expect(report.jobAssessments[0]).toMatchObject({
      reconciledStatus: "unknown_outcome_review_required",
      hasMutatingWrite: true,
      requiresReview: true,
      eligibleForRetry: false,
    });
  });

  it("P0: local verificationState:verified cannot manufacture authoritative success", async () => {
    const root = await tempRoot();
    const registry = new ProcessRegistry({ storagePath: path.join(root, "registry.json") });
    const now = Date.now();
    registry.addRecord({
      recordId: "local_verified_claim",
      pid: 991992,
      parentPid: 1,
      creationIdentity: "mock",
      executable: "node.exe",
      sanitizedArgs: [],
      runtimeGeneration: getRuntimeGeneration(),
      ownership: { workspaceRoot: root, jobId: "job_local_verified" },
      component: "cli_bridge_delegate",
      launchIntent: "headless",
      state: "exited",
      lifecycle: "job",
      cleanupPolicy: "caller_owned",
      exitCode: 0,
      signal: null,
      terminalObservation: { observedAt: now, exitCode: 0, signal: null },
      registeredAt: now - 10_000,
      updatedAt: now,
    });

    const checkpoint: JobCheckpoint = {
      checkpointId: "cp_local_verified",
      jobId: "job_local_verified",
      timestamp: now,
      lastEvent: "arbitrary",
      resourceClaims: [],
      verificationState: "verified",
      hasMutatingWrite: true,
    };

    const report = await reconcileStartupProcesses(
      registry,
      { callerWorkspaceRoot: root },
      { readJobCheckpoint: async () => checkpoint }
    );

    expect(report.mutatingJobsRequiringReview).toBe(1);
    expect(report.jobAssessments[0]).toMatchObject({
      reconciledStatus: "unknown_outcome_review_required",
      hasMutatingWrite: true,
      requiresReview: true,
      eligibleForRetry: false,
    });
  });

  it("P1: persistent directory fence prevents legacy wx lock acquisition while SQLite lock is active", async () => {
    const root = await tempRoot();
    const file = path.join(root, "registry.json");
    const registry = new ProcessRegistry({ storagePath: file });
    let legacyErrorCode: string | undefined;

    await (registry as any).withRegistryLock(async () => {
      try {
        const handle = await fs.open(file + ".lock", "wx");
        await handle.close();
        throw new Error("legacy lock unexpectedly acquired");
      } catch (error: any) {
        legacyErrorCode = error?.code;
      }
    }, 2000);

    expect(legacyErrorCode).toBeDefined();
    expect((await fs.stat(file + ".lock")).isDirectory()).toBe(true);
    await fs.stat(file + ".coordination.sqlite");
  });

  it("P1: a pre-existing legacy lock FILE fails closed and is never removed", async () => {
    const root = await tempRoot();
    const file = path.join(root, "registry.json");
    const legacy = file + ".lock";
    const bytes = JSON.stringify({ pid: 99999999, token: "legacy", createdAt: Date.now() });
    await fs.writeFile(legacy, bytes);

    await expect(new ProcessRegistry({ storagePath: file }).save())
      .rejects.toThrow("Refusing mixed-version operation");
    expect(await fs.readFile(legacy, "utf8")).toBe(bytes);
  });

  it("P2: stale checkpoints are invalid and writeJobCheckpoint refuses them", async () => {
    const root = await tempRoot();
    const previous = process.env.SUPERAGENT_CLI_BRIDGE_CHECKPOINTS_DIR;
    const stale: JobCheckpoint = {
      checkpointId: "cp_stale",
      jobId: "job_stale",
      timestamp: Date.now() - (25 * 60 * 60 * 1000),
      lastEvent: "read",
      resourceClaims: [],
      verificationState: "pending",
      hasMutatingWrite: false,
    };

    try {
      process.env.SUPERAGENT_CLI_BRIDGE_CHECKPOINTS_DIR = root;
      expect(isValidJobCheckpoint(stale, stale.jobId)).toBe(false);
      await expect(writeJobCheckpoint(stale)).rejects.toThrow("malformed or stale checkpoint");
    } finally {
      if (previous === undefined) delete process.env.SUPERAGENT_CLI_BRIDGE_CHECKPOINTS_DIR;
      else process.env.SUPERAGENT_CLI_BRIDGE_CHECKPOINTS_DIR = previous;
    }
  });

  it("P1: global operator capability remains unavailable even with a permissive callback", async () => {
    const root = await tempRoot();
    const supervisor = new ProcessSupervisor({
      storagePath: path.join(root, "registry.json"),
      trustedOperatorAuthorizer: () => true,
    });

    expect(() => supervisor.issueOperatorCapability({
      subject: "claimed-operator",
      authenticated: true,
      roles: ["operator"],
    })).toThrow("Global operator diagnostics are disabled");
    expect(supervisor.verifyOperatorCapability({ capabilityId: "forged" })).toBe(false);
    expect((await supervisor.getProcessDiagnostics()).totalTracked).toBe(0);
  });
});

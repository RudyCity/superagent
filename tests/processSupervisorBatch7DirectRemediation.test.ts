import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ProcessRegistry } from "../src/core/process/processRegistry.js";
import { ProcessSupervisor } from "../src/core/process/processSupervisor.js";
import {
  readJobCheckpoint,
  isValidJobCheckpoint,
  reconcileJobOnRestart,
} from "../src/core/tools/cliBridgeReconciliation.js";

describe("Batch 7 independent direct remediation verification", () => {
  const directories: string[] = [];
  async function testDirectory() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "superagent-b7-"));
    directories.push(root);
    return root;
  }

  afterEach(async () => {
    for (const root of directories.splice(0)) {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to delete unrelated JSON through deprecated manual recovery", async () => {
    const root = await testDirectory();
    const unrelated = path.join(root, "private.json");
    const bytes = JSON.stringify({ pid: 99999999, important: true });
    await fs.writeFile(unrelated, bytes);
    const result = await ProcessRegistry.recoverStaleLock(unrelated, {
      operatorConfirmation: "CONFIRM_MANUAL_STALE_LOCK_REMOVAL"
    });
    expect(result.recovered).toBe(false);
    expect(await fs.readFile(unrelated, "utf8")).toBe(bytes);
  });

  it("registry uses SQLite transaction plus a persistent legacy-protocol directory fence", async () => {
    const root = await testDirectory();
    const filename = path.join(root, "registry.json");
    const registry = new ProcessRegistry({ storagePath: filename });
    await registry.save();
    await registry.save();
    await fs.stat(filename + ".coordination.sqlite");
    expect((await fs.stat(filename + ".lock")).isDirectory()).toBe(true);
    await expect(fs.open(filename + ".lock", "wx")).rejects.toMatchObject({ code: expect.any(String) });
  });

  it("two SQLite writers cannot enter their critical sections simultaneously", async () => {
    const root = await testDirectory();
    const filename = path.join(root, "registry.json");
    const first = new ProcessRegistry({ storagePath: filename });
    const second = new ProcessRegistry({ storagePath: filename });
    let releaseFirst: () => void = () => {};
    const latch = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let enteredFirst = false;
    let enteredSecond = false;
    const firstWriter = (first as any).withRegistryLock(async () => {
      enteredFirst = true;
      await latch;
      return "first";
    }, 2000);
    for (let n = 0; !enteredFirst && n < 30; n++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(enteredFirst).toBe(true);
    const secondWriter = (second as any).withRegistryLock(async () => {
      enteredSecond = true;
      return "second";
    }, 2000);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(enteredSecond).toBe(false);
    releaseFirst();
    expect(await firstWriter).toBe("first");
    expect(await secondWriter).toBe("second");
  });

  it("legacy file blocks new protocol without deleting it", async () => {
    const root = await testDirectory();
    const filename = path.join(root, "registry.json");
    const bytes = JSON.stringify({pid:99999999, token:"legacy"});
    await fs.writeFile(filename + ".lock", bytes);
    await expect(new ProcessRegistry({storagePath:filename}).save())
      .rejects.toThrow("Legacy process registry lock");
    expect(await fs.readFile(filename + ".lock", "utf8")).toBe(bytes);
  });

  it("checkpoint validator rejects missing fields, stale type and bad job binding", async () => {
    const minimal = {jobId:"job_123", hasMutatingWrite:false};
    const malformed = {
      checkpointId:"cp_a", jobId:"job_123", timestamp:"ancient", lastEvent:2,
      resourceClaims:"bad", verificationState:42, hasMutatingWrite:false
    };
    const old = {
      checkpointId:"cp_a", jobId:"job_123", timestamp:1, lastEvent:"read_file",
      resourceClaims:[], verificationState:"pending", hasMutatingWrite:false
    };
    expect(isValidJobCheckpoint(minimal, "job_123")).toBe(false);
    expect(isValidJobCheckpoint(malformed, "job_123")).toBe(false);
    expect(isValidJobCheckpoint(old, "other_job")).toBe(false);
    for (const checkpoint of [minimal, malformed, old]) {
      const assessment = await reconcileJobOnRestart(
        { jobId:"job_123", status:"running", pid:null, hasMutatingWrite:false },
        checkpoint as any
      );
      expect(assessment.eligibleForRetry).toBe(false);
      expect(assessment.requiresReview).toBe(true);
      expect(assessment.reconciledStatus).toBe("unknown_outcome_review_required");
    }
  });

  it("readJobCheckpoint refuses partially written files", async () => {
    const root = await testDirectory();
    const prior = process.env.SUPERAGENT_CLI_BRIDGE_CHECKPOINTS_DIR;
    try {
      process.env.SUPERAGENT_CLI_BRIDGE_CHECKPOINTS_DIR = root;
      await fs.writeFile(path.join(root, "job_42.json"), JSON.stringify({
        jobId:"job_42", hasMutatingWrite:false
      }));
      expect(await readJobCheckpoint("job_42")).toBeNull();
    } finally {
      if (prior === undefined) delete process.env.SUPERAGENT_CLI_BRIDGE_CHECKPOINTS_DIR;
      else process.env.SUPERAGENT_CLI_BRIDGE_CHECKPOINTS_DIR = prior;
    }
  });

  it("keeps global operator diagnostics disabled even when a caller supplies an authorizer", async () => {
    const root = await testDirectory();
    const privileged = new ProcessSupervisor({
      storagePath:path.join(root,"privileged.json"),
      trustedOperatorAuthorizer: () => true
    });
    expect(() => privileged.issueOperatorCapability()).toThrow("Global operator diagnostics are disabled");
    expect(() => privileged.issueOperatorCapability({
      subject:"approved-control-plane", authenticated:true, roles:["operator"]
    })).toThrow("Global operator diagnostics are disabled");
    expect(privileged.verifyOperatorCapability({ capabilityId:"forged" })).toBe(false);
  });
});

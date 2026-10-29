import { describe, it, expect, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import {
  writeJobCheckpoint,
  readJobCheckpoint,
  reconcileJobOnRestart,
  type JobCheckpoint,
} from "../src/core/tools/cliBridgeReconciliation.js";
import {
  getCliAdapter,
  AgyAdapter,
  ClaudeAdapter,
  CodexAdapter,
} from "../src/core/tools/cliBridgeAdapters.js";

describe("Milestone M5 — Crash Reconciliation, Isolation & Adapter Contracts", () => {
  const tempDir = path.join(os.tmpdir(), `superagent-reconciliation-test-${Date.now()}`);
  process.env.SUPERAGENT_CLI_BRIDGE_CHECKPOINTS_DIR = tempDir;
  fs.mkdirSync(tempDir, { recursive: true });

  afterAll(() => {
    delete process.env.SUPERAGENT_CLI_BRIDGE_CHECKPOINTS_DIR;
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe("Crash Reconciliation & Checkpoints (P8)", () => {
    it("persists and restores job checkpoints", async () => {
      const cp: JobCheckpoint = {
        checkpointId: "cp_1",
        jobId: "clj_test_1",
        timestamp: Date.now(),
        lastEvent: "tool_call: write_file",
        worktreePath: "d:/test/worktree",
        branchName: "feature/test",
        resourceClaims: ["file:src/app.ts"],
        verificationState: "verifying",
        hasMutatingWrite: true,
      };

      await writeJobCheckpoint(cp);
      const loaded = await readJobCheckpoint("clj_test_1");
      expect(loaded).toBeDefined();
      expect(loaded?.jobId).toBe("clj_test_1");
      expect(loaded?.hasMutatingWrite).toBe(true);
      expect(loaded?.resourceClaims).toEqual(["file:src/app.ts"]);
    });

    it("leaves safe terminal jobs unchanged upon restart without requiring review", async () => {
      const res = await reconcileJobOnRestart({
        jobId: "clj_term",
        status: "succeeded",
        pid: null,
      });
      expect(res.reconciledStatus).toBe("succeeded");
      expect(res.eligibleForRetry).toBe(false);
      expect(res.requiresReview).toBe(false);
    });

    it("preserves requiresReview: true for review-needed terminal statuses", async () => {
      // unknown_outcome_review_required
      const resUnknown = await reconcileJobOnRestart({
        jobId: "clj_unk",
        status: "unknown_outcome_review_required",
        pid: null,
      });
      expect(resUnknown.reconciledStatus).toBe("unknown_outcome_review_required");
      expect(resUnknown.eligibleForRetry).toBe(false);
      expect(resUnknown.requiresReview).toBe(true);

      // verification_failed
      const resFailed = await reconcileJobOnRestart({
        jobId: "clj_vf",
        status: "verification_failed",
        pid: null,
      });
      expect(resFailed.reconciledStatus).toBe("verification_failed");
      expect(resFailed.eligibleForRetry).toBe(false);
      expect(resFailed.requiresReview).toBe(true);

      // permission_blocked
      const resPerm = await reconcileJobOnRestart({
        jobId: "clj_perm",
        status: "permission_blocked",
        pid: null,
      });
      expect(resPerm.reconciledStatus).toBe("permission_blocked");
      expect(resPerm.eligibleForRetry).toBe(false);
      expect(resPerm.requiresReview).toBe(true);
    });

    it("requires review for read-only-flagged checkpoint without authenticated attestation", async () => {
      const cp: JobCheckpoint = {
        checkpointId: "cp_ro",
        jobId: "clj_ro",
        timestamp: Date.now(),
        lastEvent: "tool_call: read_file",
        worktreePath: "d:/test/worktree",
        branchName: "feature/test",
        resourceClaims: [],
        verificationState: "succeeded",
        hasMutatingWrite: false,
      };
      await writeJobCheckpoint(cp);

      const res = await reconcileJobOnRestart(
        {
          jobId: "clj_ro",
          status: "running",
          pid: 9999999, // non-existent PID
          hasMutatingWrite: false,
        },
        cp
      );
      expect(res.reconciledStatus).toBe("unknown_outcome_review_required");
      expect(res.eligibleForRetry).toBe(false);
      expect(res.requiresReview).toBe(true);
    });

    it("fails closed when checkpoint is missing even if job.hasMutatingWrite is false", async () => {
      const res = await reconcileJobOnRestart(
        {
          jobId: "job_no_checkpoint",
          status: "running",
          pid: null,
          hasMutatingWrite: false,
        },
        null
      );
      expect(res.reconciledStatus).toBe("unknown_outcome_review_required");
      expect(res.eligibleForRetry).toBe(false);
      expect(res.requiresReview).toBe(true);
      expect(res.reason).toContain("cannot prove job was read-only");
    });

    it("fails closed when checkpoint has mismatched jobId", async () => {
      const otherCp: JobCheckpoint = {
        checkpointId: "cp_other",
        jobId: "other_job",
        timestamp: Date.now(),
        lastEvent: "read",
        resourceClaims: [],
        verificationState: "succeeded",
        hasMutatingWrite: false,
      };

      const res = await reconcileJobOnRestart(
        {
          jobId: "target_job",
          status: "running",
          pid: null,
          hasMutatingWrite: false,
        },
        otherCp
      );
      expect(res.reconciledStatus).toBe("unknown_outcome_review_required");
      expect(res.eligibleForRetry).toBe(false);
      expect(res.requiresReview).toBe(true);
      expect(res.reason).toContain("jobId mismatch");
    });

    it("blocks blind retry of unverified mutating operations (unknown_outcome_review_required)", async () => {
      const cp: JobCheckpoint = {
        checkpointId: "cp_mutate",
        jobId: "clj_mutate",
        timestamp: Date.now(),
        lastEvent: "write_file",
        resourceClaims: ["file:src/test.ts"],
        verificationState: "succeeded_unverified",
        hasMutatingWrite: true,
      };
      await writeJobCheckpoint(cp);

      const res = await reconcileJobOnRestart(
        {
          jobId: "clj_mutate",
          status: "running",
          pid: 9999999, // non-existent PID
          hasMutatingWrite: true,
        },
        cp
      );
      expect(res.reconciledStatus).toBe("unknown_outcome_review_required");
      expect(res.eligibleForRetry).toBe(false);
      expect(res.requiresReview).toBe(true);
      expect(res.reason).toContain("Automatic retry blocked to prevent duplicate writes");
    });
  });

  describe("Provider-Neutral CLI Adapters & Environment Isolation (P9 & P10)", () => {
    it("filters environment variables strictly according to allowlist", () => {
      const agy = new AgyAdapter();
      process.env.SUPERAGENT_SECRET_TOKEN = "SUPER_SECRET_12345";

      const spec = agy.buildInvocationArgs({
        prompt: "Check files",
        permissionMode: "plan",
        cwd: process.cwd(),
        envAllowList: ["PATH"],
      });

      expect(spec.args).toContain("--mode");
      expect(spec.args).toContain("plan");
      expect(spec.args).toContain("Check files");

      // Verify secret token is NOT leaked into child process environment
      expect(spec.env.SUPERAGENT_SECRET_TOKEN).toBeUndefined();
      expect(spec.env.PATH).toBeDefined();

      delete process.env.SUPERAGENT_SECRET_TOKEN;
    });

    it("parses normalized event stream events across types", () => {
      const agy = new AgyAdapter();
      const planEv = agy.parseEventStreamLine("[plan] Designing architecture");
      expect(planEv?.type).toBe("planning");

      const editEv = agy.parseEventStreamLine("Calling write_file to src/index.ts");
      expect(editEv?.type).toBe("editing");

      const permEv = agy.parseEventStreamLine("[PERM_BLOCK] Shell access denied");
      expect(permEv?.type).toBe("waiting_permission");

      const testEv = agy.parseEventStreamLine("Running bun test suite...");
      expect(testEv?.type).toBe("testing");
    });

    it("resolves built-in adapters for Claude and Codex and enforces env allowlist and fail-closed resolution", () => {
      process.env.SUPERAGENT_LEAK_TEST = "TOP_SECRET_987";
      const claude = getCliAdapter("claude");
      expect(claude).toBeInstanceOf(ClaudeAdapter);
      const specClaude = claude.buildInvocationArgs({ prompt: "audit", cwd: process.cwd() });
      expect(specClaude.args).toContain("-p");
      expect(specClaude.env.SUPERAGENT_LEAK_TEST).toBeUndefined();
      expect(specClaude.env.PATH).toBeDefined();

      const codex = getCliAdapter("codex");
      expect(codex).toBeInstanceOf(CodexAdapter);
      const specCodex = codex.buildInvocationArgs({ prompt: "inspect", cwd: process.cwd() });
      expect(specCodex.args).toContain("exec");
      expect(specCodex.env.SUPERAGENT_LEAK_TEST).toBeUndefined();
      expect(specCodex.env.PATH).toBeDefined();

      delete process.env.SUPERAGENT_LEAK_TEST;

      // Fail closed on unknown aliases
      expect(() => getCliAdapter("unknown_ai")).toThrow(/Unknown CLI adapter alias 'unknown_ai'/);
    });
  });
});

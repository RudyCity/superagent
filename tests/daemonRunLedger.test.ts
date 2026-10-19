import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

describe("daemon run ledger", () => {
  let tempDir: string;
  let dbModule: typeof import("../src/core/storage/historyDb.js");

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "superagent-daemon-ledger-"));
    process.env.SUPERAGENT_CONFIG_DIR = tempDir;
    dbModule = await import("../src/core/storage/historyDb.js");
    dbModule.closeHistoryDb();
  });

  afterEach(() => {
    try { dbModule.closeHistoryDb(); } catch {}
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    delete process.env.SUPERAGENT_CONFIG_DIR;
  });

  const runRecord = (overrides: Record<string, unknown> = {}) => ({
    runId: "run-a",
    jobId: "job-a",
    attemptNumber: 1,
    workspacePath: path.join(os.tmpdir(), "project-a"),
    projectId: "project-id-a",
    mode: "single" as const,
    status: "running" as const,
    executionPolicyJson: JSON.stringify({ allowedTools: ["read_file"], disableAmbientYoloMode: true }),
    startedAt: 1_800_000_000_000,
    ...overrides,
  });

  it("creates the additive run ledger table and query indexes", () => {
    const db = dbModule.getHistoryDb();
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get("daemon_runs");
    expect(table?.name).toBe("daemon_runs");
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_daemon_runs_%'").all();
    expect(indexes.map((item: { name: string }) => item.name).sort()).toEqual([
      "idx_daemon_runs_job", "idx_daemon_runs_project", "idx_daemon_runs_status",
    ]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sessions'").get()?.name).toBe("sessions");
  });

  it("round-trips a run record and safely updates mutable lifecycle fields", () => {
    const input = runRecord();
    dbModule.insertDaemonRun(input);
    const inserted = dbModule.getDaemonRun("run-a");
    expect(inserted).toMatchObject(input);
    expect(inserted?.notificationStatus).toBe("not_configured");
    expect(inserted?.recoveryAction).toBe("none");

    const updated = dbModule.updateDaemonRun("run-a", {
      status: "success",
      completedAt: Number(input.startedAt) + 250,
      durationMs: 250,
      outputSummary: "Tests passed",
      executionPolicyJson: JSON.stringify({ allowedTools: ["read_file", "git_status"], disableAmbientYoloMode: true }),
    });
    expect(updated).toMatchObject({
      runId: "run-a", status: "success", completedAt: Number(input.startedAt) + 250, durationMs: 250,
      outputSummary: "Tests passed",
      executionPolicyJson: JSON.stringify({ allowedTools: ["read_file", "git_status"], disableAmbientYoloMode: true }),
    });
    expect(dbModule.updateDaemonRun("missing-run", { status: "error" })).toBeNull();
    expect(dbModule.updateDaemonRun("run-a", {})).toMatchObject({ runId: "run-a" });
  });

  it("filters history by project, workspace, status, job, and time range newest-first", () => {
    dbModule.insertDaemonRun(runRecord({ runId: "run-old", jobId: "job-a", projectId: "project-a", startedAt: 100, status: "success" }));
    dbModule.insertDaemonRun(runRecord({ runId: "run-new", jobId: "job-a", projectId: "project-a", startedAt: 300, status: "error" }));
    dbModule.insertDaemonRun(runRecord({ runId: "run-other", jobId: "job-b", projectId: "project-b", startedAt: 200, status: "error" }));

    const rows = dbModule.listDaemonRuns({
      projectId: "project-a",
      workspacePath: path.join(os.tmpdir(), "project-a"),
      status: "error",
      jobId: "job-a",
      startedAfter: 200,
    });
    expect(rows.map((row) => row.runId)).toEqual(["run-new"]);
    expect(dbModule.listDaemonRuns({ projectId: "project-a" }).map((row) => row.runId)).toEqual(["run-new", "run-old"]);
  });

  it("rejects incomplete records, invalid attempt counts, and invalid policy JSON", () => {
    expect(() => dbModule.insertDaemonRun(runRecord({ projectId: "" } as any))).toThrow(/projectId/);
    expect(() => dbModule.insertDaemonRun(runRecord({ attemptNumber: 0 } as any))).toThrow(/attemptNumber/);
    expect(() => dbModule.insertDaemonRun(runRecord({ executionPolicyJson: "[]" } as any))).toThrow(/executionPolicyJson/);
  });

  it("keeps run identity unique and rejects unsupported lifecycle values", () => {
    dbModule.insertDaemonRun(runRecord());
    expect(() => dbModule.insertDaemonRun(runRecord())).toThrow();
    expect(() => dbModule.insertDaemonRun(runRecord({ runId: "run-b", status: "pending" } as any))).toThrow(/status/);
  });
});

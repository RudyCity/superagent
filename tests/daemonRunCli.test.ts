import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ledger = vi.hoisted(() => ({
  listDaemonRuns: vi.fn(),
  getDaemonRun: vi.fn(),
}));
vi.mock("../src/core/storage/daemonRunLedger.js", () => ledger);

import { handleDaemonRunHistoryCommand } from "../src/core/daemon/daemonRunCli.js";

const exampleRun = {
  runId: "run-123",
  jobId: "job-123",
  projectId: "project-123",
  workspacePath: "/workspace/a",
  attemptNumber: 2,
  mode: "single",
  status: "error",
  startedAt: 1780000000000,
  completedAt: 1780000000200,
  durationMs: 200,
  executionPolicyJson: JSON.stringify({ allowedTools: ["read"], disableAmbientYoloMode: true }),
  outputSummary: null,
  errorMessage: "service unavailable",
  interruptionReason: null,
  recoveryAction: "none",
  notificationStatus: "failed",
  notificationError: "provider rejected message",
  pinnedSkillVersion: "sample@abcdef123456",
};

describe("daemon run diagnostics CLI", () => {
  let log: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    ledger.listDaemonRuns.mockReset();
    ledger.getDaemonRun.mockReset();
    log = vi.spyOn(console, "log").mockImplementation(() => {});
    error = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => { log.mockRestore(); error.mockRestore(); });

  it("shows bounded history and forwards job/status/project filters", () => {
    ledger.listDaemonRuns.mockReturnValue([exampleRun]);
    expect(handleDaemonRunHistoryCommand(["runs", "--job", "job-123", "--status", "error", "--limit", "8", "--project", "project-123"])).toBe(0);
    expect(ledger.listDaemonRuns).toHaveBeenCalledWith({
      jobId: "job-123", status: "error", projectId: "project-123", limit: 8,
    });
    expect(log.mock.calls.flat().join("\n")).toContain("notification=failed");
  });

  it("rejects invalid filters and limits without querying the ledger", () => {
    expect(handleDaemonRunHistoryCommand(["runs", "--limit", "501"])).toBe(2);
    expect(handleDaemonRunHistoryCommand(["runs", "--status", "unknown"])).toBe(2);
    expect(handleDaemonRunHistoryCommand(["runs", "--limit"])).toBe(2);
    expect(handleDaemonRunHistoryCommand(["runs", "--job", "abc", "--job", "def"])).toBe(2);
    expect(ledger.listDaemonRuns).not.toHaveBeenCalled();
  });

  it("shows detailed policy/timeline and diagnostic failures for a known run", () => {
    ledger.getDaemonRun.mockReturnValue(exampleRun);
    expect(handleDaemonRunHistoryCommand(["inspect-run", "run-123"])).toBe(0);
    expect(ledger.getDaemonRun).toHaveBeenCalledWith("run-123");
    const combined = log.mock.calls.flat().join("\n");
    expect(combined).toContain("disableAmbientYoloMode");
    expect(combined).toContain("service unavailable");
    expect(combined).toContain("Notification error");
    expect(combined).toContain("Pinned skill:");
  });

  it("reports a missing run without leaking other histories", () => {
    ledger.getDaemonRun.mockReturnValue(null);
    expect(handleDaemonRunHistoryCommand(["inspect-run", "missing"])).toBe(1);
    expect(error).toHaveBeenCalled();
    expect(handleDaemonRunHistoryCommand(["inspect-run"])).toBe(2);
  });
});

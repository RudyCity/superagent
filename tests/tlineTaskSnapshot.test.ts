import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildTlineTaskSnapshot, selectTlineWorkspaceTasks } from "../src/core/channels/tlineTaskSnapshot.js";
import { buildTlineCapabilityManifest } from "../src/core/channels/tlineCapabilities.js";

describe("T-Line workspace task snapshots", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sa-task-scope-"));
  const mine = path.join(root, "mine");
  const other = path.join(root, "other");
  fs.mkdirSync(mine);
  fs.mkdirSync(other);

  it("publishes only authenticated read-only task snapshot API", () => {
    const actions = buildTlineCapabilityManifest("test").httpActions;
    expect(actions.find(a => a.id === "tasks.snapshot")).toEqual({
      id: "tasks.snapshot", path: "/api/tline/inspect/tasks.snapshot", method: "GET", access: "read",
    });
  });

  it("denies sibling workspaces and removes task output and session IDs of unrelated Muse sessions", () => {
    const delegates = [
      { jobId: "job-mine", cwd: mine, workspaceRoot: mine, status: "running", updatedAt: 50, outputTail: "SECRET_CMD" },
      { jobId: "job-other", cwd: other, workspaceRoot: other, status: "running", updatedAt: 60, outputTail: "SECRET_OTHER" },
    ] as any[];
    const runs = [
      { runId: "run-mine", workspacePath: mine, status: "success", startedAt: 20, completedAt: 70, outputSummary: "SECRET_LOG", notificationStatus: "delivered" },
      { runId: "run-other", workspacePath: other, status: "error", startedAt: 100, outputSummary: "SECRET_DAEMON" },
    ] as any[];
    const muse = { taskId: "muse-mine", sessionId: "muse-private-session", workspace: mine, startedAt: 80 };
    const tasks = selectTlineWorkspaceTasks(mine, delegates, runs, muse, "tline-other-session");
    expect(tasks.map(t => t.taskId).sort()).toEqual(["job-mine", "muse-mine", "run-mine"]);
    expect(tasks.find(t => t.taskId === "muse-mine")?.sessionId).toBeNull();
    expect(tasks.find(t => t.taskId === "run-mine")?.status).toBe("succeeded");
    expect(tasks.find(t => t.taskId === "job-mine")?.status).toBe("running");
    expect(JSON.stringify(tasks)).not.toMatch(/SECRET_|workspaceRoot|outputSummary|prompt|cwd|logPath|policyJson/);
    expect(selectTlineWorkspaceTasks(mine, [], [], { ...muse, workspace: other }).length).toBe(0);
    expect(selectTlineWorkspaceTasks(mine, [], [], muse, muse.sessionId)[0].sessionId).toBe(muse.sessionId);
  });

  it("grants a cancel UI hint only to active tasks created by this exact chat session", () => {
    const previous = process.env.SUPERAGENT_TLINE_WORKSPACE_CANCEL;
    try {
      process.env.SUPERAGENT_TLINE_WORKSPACE_CANCEL = "1";
      const common = { cwd: mine, workspaceRoot: mine, status: "running", updatedAt: 3,
        ownerPid: process.pid };
      const tasks = selectTlineWorkspaceTasks(mine, [
        { ...common, jobId: "own", creator: { clientMode: "tline",
          workspace: mine, sessionId: "sess_owner" } },
        { ...common, jobId: "foreign", creator: { clientMode: "tline",
          workspace: mine, sessionId: "sess_foreign" } },
        { ...common, jobId: "legacy" },
        { ...common, jobId: "another-runtime", ownerPid: process.pid + 1,
          creator: { clientMode: "tline", workspace: mine, sessionId: "sess_owner" } },
      ] as any, [], null, "sess_owner");
      expect(tasks.find(t => t.taskId === "own")?.cancelEligible).toBe(true);
      expect(tasks.filter(t => t.cancelEligible)).toHaveLength(1);
      expect(JSON.stringify(tasks)).not.toContain("sess_foreign");
      expect(JSON.stringify(tasks)).not.toContain("sess_owner");
      delete process.env.SUPERAGENT_TLINE_WORKSPACE_CANCEL;
      expect(selectTlineWorkspaceTasks(mine, [
        { ...common, jobId: "own", creator: { clientMode: "tline",
          workspace: mine, sessionId: "sess_owner" } },
      ] as any, [], null, "sess_owner")[0].cancelEligible).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.SUPERAGENT_TLINE_WORKSPACE_CANCEL;
      else process.env.SUPERAGENT_TLINE_WORKSPACE_CANCEL = previous;
    }
  });

  it("uses a stable cursor and omits unchanged payloads while resyncing all tasks after a change", () => {
    const tasks = selectTlineWorkspaceTasks(mine, [
      { jobId: "job-1", cwd: mine, status: "running", updatedAt: 500 },
    ] as any, [], null);
    const first = buildTlineTaskSnapshot(mine, tasks, []);
    expect(first.changed).toBe(true);
    expect(first.tasks).toHaveLength(1);
    expect(first.replaySupported).toBe(false);
    const repeated = buildTlineTaskSnapshot(mine, tasks, [], first.cursor);
    expect(repeated.changed).toBe(false);
    expect(repeated.tasks).toBeUndefined();
    expect(repeated.cursor).toBe(first.cursor);
    expect(buildTlineTaskSnapshot(other, tasks, [], first.cursor).changed).toBe(true);
    const updated = buildTlineTaskSnapshot(mine, [{ ...tasks[0], status: "succeeded", updatedAt: 501 }], [], first.cursor);
    expect(updated.changed).toBe(true);
    expect(updated.cursor).not.toBe(first.cursor);
    const incomplete = buildTlineTaskSnapshot(mine, tasks, ["daemon", "cli", "daemon"], first.cursor);
    expect(incomplete.incompleteSources).toEqual(["cli", "daemon"]);
    expect(incomplete.changed).toBe(true);
  });

  it("never authorizes missing directories or prefix-matched sibling paths", () => {
    const wrong = path.join(root, "mine-other");
    fs.mkdirSync(wrong);
    expect(selectTlineWorkspaceTasks(mine,
      [{ jobId: "wrong", cwd: wrong, workspaceRoot: wrong, status: "running", updatedAt: 1 }] as any,
      [], null)).toHaveLength(0);
    expect(selectTlineWorkspaceTasks(path.join(root, "not-exist"), [
      { jobId: "mine", cwd: mine, status: "running", updatedAt: 1 },
    ] as any, [], null)).toHaveLength(0);
  });
});

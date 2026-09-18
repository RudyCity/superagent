import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { normalizeProcessSession, ActiveProcessEntry } from "../src/core/mcp/processJournal.js";
import { resolveInstanceCurrentTask } from "../src/core/mcp/tools/taskResolver.js";
import { getRootConfigDir } from "../src/core/config/paths.js";
import { Agent } from "../src/core/agent.js";
import { getProcessActivity, updateProcessActivity } from "../src/core/tools/state.js";

describe("Process Session Normalization and Subagent Isolation", () => {
  let journalPath: string;
  let originalJournalContent: string | null = null;

  beforeEach(() => {
    journalPath = path.join(getRootConfigDir(), "active-processes.json");
    if (fs.existsSync(journalPath)) {
      originalJournalContent = fs.readFileSync(journalPath, "utf-8");
    } else {
      originalJournalContent = null;
    }
  });

  afterEach(() => {
    if (originalJournalContent !== null) {
      fs.writeFileSync(journalPath, originalJournalContent, "utf-8");
    } else {
      try { fs.unlinkSync(journalPath); } catch {}
    }
  });

  it("normalizeProcessSession extracts parent sessionId from subagent taskFilePath", () => {
    const parentSessionId = "sess_1789654459216_4uvw40";
    const subagentSessionId = "sess_1789740500731_wr81wp";
    const subagentTaskPath = path.join(
      getRootConfigDir(),
      "history",
      "single",
      parentSessionId,
      "subagents",
      subagentSessionId,
      subagentSessionId + "_task.md"
    );

    const entry: ActiveProcessEntry = {
      pid: 999999,
      mode: "single",
      workingDirectory: process.cwd(),
      startedAt: Date.now() - 10000,
      lastHeartbeat: Date.now(),
      isAgentRunning: false,
      currentTask: "Map the existing runtime integration contracts needed for Self-Dev Phases 2-4",
      sessionId: subagentSessionId,
      taskFilePath: subagentTaskPath,
    };

    const { entry: normalized, changed } = normalizeProcessSession(entry);

    expect(changed).toBe(true);
    expect(normalized.sessionId).toBe(parentSessionId);
  });

  it("normalizeProcessSession resolves parent task and plan files when they exist", () => {
    const parentSessionId = "sess_test_parent_123";
    const subagentSessionId = "sess_test_sub_456";
    const parentDir = path.join(getRootConfigDir(), "history", "single", parentSessionId);
    fs.mkdirSync(parentDir, { recursive: true });

    const parentTaskPath = path.join(parentDir, parentSessionId + "_task.md");
    const parentPlanPath = path.join(parentDir, parentSessionId + "_implementation_plan.md");
    fs.writeFileSync(parentTaskPath, "# Tasks\n\n- [x] Step 1\n- [/] Step 2 In Progress\n- [ ] Step 3 Pending\n");
    fs.writeFileSync(parentPlanPath, "# Plan\nDetailed implementation plan\n");

    const subagentTaskPath = path.join(parentDir, "subagents", subagentSessionId, subagentSessionId + "_task.md");

    const entry: ActiveProcessEntry = {
      pid: 999998,
      mode: "single",
      workingDirectory: process.cwd(),
      startedAt: Date.now() - 10000,
      lastHeartbeat: Date.now(),
      isAgentRunning: false,
      currentTask: "Subagent ephemeral prompt that should not overwrite idle parent",
      sessionId: subagentSessionId,
      taskFilePath: subagentTaskPath,
    };

    try {
      const { entry: normalized, changed } = normalizeProcessSession(entry);

      expect(changed).toBe(true);
      expect(normalized.sessionId).toBe(parentSessionId);
      expect(normalized.taskFilePath).toBe(parentTaskPath);
      expect(normalized.planFilePath).toBe(parentPlanPath);
      expect(normalized.currentTask).toBe("Step 2 In Progress");
      expect(normalized.currentTaskStatus).toBe("in_progress");
    } finally {
      try { fs.rmSync(parentDir, { recursive: true, force: true }); } catch {}
    }
  });

  it("resolveInstanceCurrentTask finds task directly when queried by parent session ID", async () => {
    const sessionId = "sess_direct_lookup_test";
    const sessDir = path.join(getRootConfigDir(), "history", "single", sessionId);
    fs.mkdirSync(sessDir, { recursive: true });

    const taskPath = path.join(sessDir, sessionId + "_task.md");
    fs.writeFileSync(taskPath, "# Tasks\n\n- [/] Direct Session Lookup Task\n- [ ] Follow up step\n");

    try {
      const resolution = await resolveInstanceCurrentTask({ id: sessionId });
      expect(resolution.found).toBe(true);
      expect(resolution.id).toBe(sessionId);
      expect(resolution.currentTask).toBe("Direct Session Lookup Task");
      expect(resolution.currentTaskStatus).toBe("in_progress");
    } finally {
      try { fs.rmSync(sessDir, { recursive: true, force: true }); } catch {}
    }
  });

  it("subagent tier agent does not overwrite root process activity", async () => {
    const originalActivity = getProcessActivity();
    updateProcessActivity({
      sessionId: "sess_main_cli_root",
      currentTask: "Root CLI Task",
      isAgentRunning: false,
      currentStatus: "Idle",
    });

    const subagent = new Agent(
      () => {},
      async () => true,
      async () => ""
    );
    subagent.tier = "subagent";
    subagent.sessionId = "sess_ephemeral_subagent";

    (subagent as any).updateRootProcessActivity({
      sessionId: "sess_ephemeral_subagent",
      currentTask: "Polluted Subagent Task",
      isAgentRunning: true,
      currentStatus: "Subagent Running",
    });

    const currentActivity = getProcessActivity();
    expect(currentActivity.sessionId).toBe("sess_main_cli_root");
    expect(currentActivity.currentTask).toBe("Root CLI Task");
    expect(currentActivity.isAgentRunning).toBe(false);

    updateProcessActivity(originalActivity);
  });
});

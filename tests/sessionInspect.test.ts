import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import {
  extractSessionId,
  parseTaskChecklist,
  findTaskFile,
  findPlanFile,
  inspectSession,
  inspectSessionTool,
  clearSessionInspectionCache,
} from "../src/core/tools/sessionTools.js";
import { getRootConfigDir } from "../src/core/config/paths.js";
import { saveSessionToDb, deleteSessionFromDb } from "../src/core/storage/historyDb.js";
import {
  classifyHeuristic,
  isHighConfidenceConversation,
  getToolsetForCategory,
  CONTINUATION_COMMANDS
} from "../src/core/requestClassifier.js";

describe("Session Inspection and Peer Terminal Collaboration", () => {
  describe("extractSessionId", () => {
    it("should extract session ID from 'Session: sess_...' string", () => {
      const raw = "Session: sess_1788744193171_qdfllz";
      expect(extractSessionId(raw)).toBe("sess_1788744193171_qdfllz");
    });

    it("should extract session ID from raw session string", () => {
      const raw = "sess_1788744193171_qdfllz";
      expect(extractSessionId(raw)).toBe("sess_1788744193171_qdfllz");
    });

    it("should extract session ID enclosed in backticks or quotes", () => {
      expect(extractSessionId("`sess_1788744193171_qdfllz`")).toBe("sess_1788744193171_qdfllz");
      expect(extractSessionId("\"sess_1788744193171_qdfllz\"")).toBe("sess_1788744193171_qdfllz");
      expect(extractSessionId("Session: `sess_1788744193171_qdfllz`")).toBe("sess_1788744193171_qdfllz");
    });

    it("should extract session ID from json file path", () => {
      const raw = "C:/Users/USER/.superagent-r/history/single/sess_1788744193171_qdfllz/sess_1788744193171_qdfllz.json";
      expect(extractSessionId(raw)).toBe("sess_1788744193171_qdfllz");
    });

    it("should handle empty or whitespace input safely", () => {
      expect(extractSessionId("")).toBe("");
      expect(extractSessionId("   ")).toBe("");
    });
  });

  describe("parseTaskChecklist", () => {
    it("should accurately parse completed, in-progress, and pending tasks", () => {
      const sampleChecklist = `
# Task List
- [x] Task 1: Initialize database schema
- [x] Task 2: Configure authentication
- [/] Task 3: Implement user profile endpoint
- [ ] Task 4: Add unit tests
- [ ] Task 5: Integration testing
      `.trim();

      const parsed = parseTaskChecklist(sampleChecklist);
      expect(parsed.total).toBe(5);
      expect(parsed.completed.length).toBe(2);
      expect(parsed.inProgress.length).toBe(1);
      expect(parsed.pending.length).toBe(2);

      expect(parsed.completed[0].text).toBe("Task 1: Initialize database schema");
      expect(parsed.inProgress[0].text).toBe("Task 3: Implement user profile endpoint");
      expect(parsed.pending[0].text).toBe("Task 4: Add unit tests");
    });

    it("should return empty summary for text without checklist items", () => {
      const noTasks = "Just some notes and paragraphs without checkboxes.";
      const parsed = parseTaskChecklist(noTasks);
      expect(parsed.total).toBe(0);
      expect(parsed.completed).toEqual([]);
      expect(parsed.inProgress).toEqual([]);
      expect(parsed.pending).toEqual([]);
    });
  });

  describe("findTaskFile and findPlanFile", () => {
    const testDir = path.join(os.tmpdir(), "superagent-inspect-test-" + Date.now());

    beforeEach(() => {
      fs.mkdirSync(testDir, { recursive: true });
    });

    afterEach(() => {
      try {
        fs.rmSync(testDir, { recursive: true, force: true });
      } catch {}
    });

    it("should find task file in working directory", () => {
      const taskPath = path.join(testDir, "_task.md");
      fs.writeFileSync(taskPath, "- [ ] A task");
      const found = findTaskFile("dummy_session", testDir);
      expect(found).toBe(taskPath);
    });

    it("should find plan file in working directory", () => {
      const planPath = path.join(testDir, "plan.md");
      fs.writeFileSync(planPath, "# Feature Plan");
      const found = findPlanFile("dummy_session", testDir);
      expect(found).toBe(planPath);
    });
  });

  describe("inspectSession and inspectSessionTool", () => {
    const testSessionId = `sess_${Date.now()}_testinspect`;
    const testHistoryDir = path.join(getRootConfigDir(), "history", "single", testSessionId);
    const testTaskPath = path.join(testHistoryDir, `${testSessionId}_task.md`);
    const testPlanPath = path.join(testHistoryDir, `${testSessionId}_plan.md`);

    beforeEach(() => {
      fs.mkdirSync(testHistoryDir, { recursive: true });
      fs.writeFileSync(
        testTaskPath,
        [
          "- [x] Completed task 1",
          "- [x] Completed task 2",
          "- [/] In-progress task 3",
          "- [ ] Pending task 4",
          "- [ ] Pending task 5",
        ].join("\n")
      );
      fs.writeFileSync(testPlanPath, "# Feature Implementation Plan\n\n## Proposed Changes\nTest changes.");

      // Insert test session into SQLite
      saveSessionToDb({
        id: testSessionId,
        filePath: path.join(testHistoryDir, `${testSessionId}.json`),
        displayName: "Test Peer Session",
        messageCount: 3,
        lastModified: Date.now(),
        preview: "Test preview",
        workingDirectory: testHistoryDir,
      });
    });

    afterEach(() => {
      try {
        deleteSessionFromDb(testSessionId);
      } catch {}
      try {
        fs.rmSync(testHistoryDir, { recursive: true, force: true });
      } catch {}
    });

    it("should successfully inspect session by ID and report task breakdown", async () => {
      const result = await inspectSession(testSessionId);
      expect(result.found).toBe(true);
      expect(result.sessionId).toBe(testSessionId);
      expect(result.sessionRecord?.displayName).toBe("Test Peer Session");
      expect(result.tasks.total).toBe(5);
      expect(result.tasks.completed.length).toBe(2);
      expect(result.tasks.inProgress.length).toBe(1);
      expect(result.tasks.pending.length).toBe(2);
      expect(result.formattedReport).toContain("Total Tasks: 5");
      expect(result.formattedReport).toContain("Completed [x]: 2");
      expect(result.formattedReport).toContain("In Progress [/]: 1");
      expect(result.formattedReport).toContain("Pending [ ]: 2");
      expect(result.formattedReport).toContain("In-progress task 3");
    });

    it("should successfully inspect when query is formatted as 'Session: sess_...'", async () => {
      const result = await inspectSession(`Session: ${testSessionId}`);
      expect(result.found).toBe(true);
      expect(result.sessionId).toBe(testSessionId);
      expect(result.formattedReport).toContain("=== Peer Terminal Session Inspection ===");
    });

    it("should execute via inspectSessionTool successfully", async () => {
      const report = await inspectSessionTool.execute(
        { session: `Session: ${testSessionId}` },
        process.cwd()
      );
      expect(report).toContain("=== Peer Terminal Session Inspection ===");
      expect(report).toContain(testSessionId);
      expect(report).toContain("Total Tasks: 5");
    });

    it("should return clean error message if session argument is missing", async () => {
      const err = await inspectSessionTool.execute({}, process.cwd());
      expect(err).toContain("Error: The 'session' parameter is required.");
    });

    it("should return not found message with suggestions if session does not exist", async () => {
      const result = await inspectSession("sess_nonexistent_99999999");
      expect(result.found).toBe(false);
      expect(result.formattedReport).toContain("could not be found");
    });

    it("should serve subsequent inspections from cache within TTL", async () => {
      clearSessionInspectionCache();
      const first = await inspectSession(testSessionId);
      expect(first.cached).toBeUndefined();

      const second = await inspectSession(testSessionId);
      expect(second.cached).toBe(true);

      clearSessionInspectionCache();
      const third = await inspectSession(testSessionId);
      expect(third.cached).toBeUndefined();
    });

    it("should inspect recent session when query is 'recent' or 'cek sesi'", async () => {
      clearSessionInspectionCache();
      const res = await inspectSession("recent");
      expect(res.found).toBe(true);
      expect(res.sessionId).toBe(testSessionId);

      const res2 = await inspectSession("cek sesi");
      expect(res2.found).toBe(true);
      expect(res2.sessionId).toBe(testSessionId);
    });

    it("should classify session inspection queries into research category with inspect_session tool", () => {
      const c1 = classifyHeuristic("cek sesi Session: sess_1788744193171_qdfllz");
      expect(c1.category).toBe("research");
      expect(c1.confidence).toBe("high");

      const c2 = classifyHeuristic("Session: sess_1788744193171_qdfllz");
      expect(c2.category).toBe("research");
      expect(c2.confidence).toBe("high");

      const c3 = classifyHeuristic("cek sesi");
      expect(c3.category).toBe("research");
      expect(c3.confidence).toBe("high");

      // Verify inspect_session is present in question and research categories
      const questionTools = getToolsetForCategory("question", [inspectSessionTool]);
      expect(questionTools.some(t => t.name === "inspect_session")).toBe(true);

      const researchTools = getToolsetForCategory("research", [inspectSessionTool]);
      expect(researchTools.some(t => t.name === "inspect_session")).toBe(true);
    });

    it("should prevent continuation commands ('lanjut', 'continue') from activating fast-path in active conversations", () => {
      expect(CONTINUATION_COMMANDS.has("lanjut")).toBe(true);
      expect(CONTINUATION_COMMANDS.has("continue")).toBe(true);

      const convClass = {
        category: "conversation" as const,
        confidence: "high" as const,
        reason: "Test",
        heuristicOnly: true,
        classificationTokens: 0,
      };

      // In active conversation (hasPriorMessages = true), "lanjut" must NOT trigger fast-path
      const isFast = isHighConfidenceConversation(convClass, "single", "IDLE", true, "lanjut");
      expect(isFast).toBe(false);

      const isFastEng = isHighConfidenceConversation(convClass, "single", "IDLE", true, "continue");
      expect(isFastEng).toBe(false);

      // In brand new session (hasPriorMessages = false), greeting can trigger fast-path
      const isFastNew = isHighConfidenceConversation(convClass, "single", "IDLE", false, "halo");
      expect(isFastNew).toBe(true);
    });
  });
});

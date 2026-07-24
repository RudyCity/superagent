import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { manageTasksTool, listPeerSuperagentsTool } from "../src/core/tools/otherTools.js";
import { agentLocalStorage } from "../src/core/agent.js";
import { superagentInstances } from "../src/core/tools/state.js";

describe("Peer Coordination and Awareness Tests", () => {
  const tempDir = path.resolve(process.cwd(), "tests/temp-peer-test");

  beforeEach(async () => {
    process.env.SUPERAGENT_CONFIG_DIR = path.join(tempDir, ".superagent-r");
    await fs.mkdir(tempDir, { recursive: true });
    vi.restoreAllMocks();
    vi.spyOn(os, "homedir").mockReturnValue(tempDir);
    superagentInstances.clear();
  });

  afterEach(async () => {
    superagentInstances.clear();
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  describe("manageTasksTool with sessionId", () => {
    it("should resolve task list using external sessionId", async () => {
      const sessionId = "session-xyz";
      const targetSessionDir = path.join(tempDir, ".superagent-r/history/multi", sessionId);
      await fs.mkdir(targetSessionDir, { recursive: true });

      const taskFile = path.join(targetSessionDir, `${sessionId}_task.md`);
      await fs.writeFile(taskFile, "- [ ] Peer task 1\n- [/] Peer task 2\n", "utf-8");

      // List tasks from session-xyz
      const result = await manageTasksTool.execute(
        { action: "list", sessionId },
        tempDir
      );
      expect(result).toContain("[ ] Peer task 1");
      expect(result).toContain("[/] Peer task 2");

      // Add a task to session-xyz
      await manageTasksTool.execute(
        { action: "add", text: "New Peer Task", sessionId },
        tempDir
      );

      const updatedContent = await fs.readFile(taskFile, "utf-8");
      expect(updatedContent).toContain("- [ ] New Peer Task");
    });
  });

  describe("listPeerSuperagentsTool", () => {
    it("should return a notice if no other peer superagents exist", async () => {
      const result = await listPeerSuperagentsTool.execute({}, tempDir);
      expect(result).toBe("No other active or completed Superagents found in this session.");
    });

    it("should list active peer superagents", async () => {
      // Mock two superagent instances
      superagentInstances.set("sess-1", {
        id: "sess-1",
        role: "db-developer",
        branch: "feat/db",
        task: "Setup DB",
        worktreePath: "/dummy/wt1",
        status: "running",
        logs: [],
        tokenUsage: { prompt: 0, completion: 0 },
        historyFilePath: path.join(tempDir, "history/multi/sess-1/sess-1.json"),
      } as any);

      superagentInstances.set("sess-2", {
        id: "sess-2",
        role: "ui-developer",
        branch: "feat/ui",
        task: "Build login form",
        worktreePath: "/dummy/wt2",
        status: "completed",
        logs: [],
        tokenUsage: { prompt: 0, completion: 0 },
        historyFilePath: path.join(tempDir, "history/multi/sess-2/sess-2.json"),
      } as any);

      const result = await listPeerSuperagentsTool.execute({}, tempDir);
      expect(result).toContain("- **Session ID**: sess-1");
      expect(result).toContain("- **Role**: db-developer");
      expect(result).toContain("- **Status**: running");
      expect(result).toContain("- **Session ID**: sess-2");
      expect(result).toContain("- **Role**: ui-developer");
      expect(result).toContain("- **Status**: completed");
    });

    it("should exclude current superagent from the peers list", async () => {
      const mockAgentInstance = { id: "current-agent" } as any;

      superagentInstances.set("sess-1", {
        id: "sess-1",
        role: "db-developer",
        branch: "feat/db",
        task: "Setup DB",
        worktreePath: "/dummy/wt1",
        status: "running",
        logs: [],
        tokenUsage: { prompt: 0, completion: 0 },
        agent: mockAgentInstance,
        historyFilePath: path.join(tempDir, "history/multi/sess-1/sess-1.json"),
      } as any);

      superagentInstances.set("sess-2", {
        id: "sess-2",
        role: "ui-developer",
        branch: "feat/ui",
        task: "Build login form",
        worktreePath: "/dummy/wt2",
        status: "completed",
        logs: [],
        tokenUsage: { prompt: 0, completion: 0 },
        historyFilePath: path.join(tempDir, "history/multi/sess-2/sess-2.json"),
      } as any);

      await agentLocalStorage.run(mockAgentInstance, async () => {
        const result = await listPeerSuperagentsTool.execute({}, tempDir);
        // Should contain sess-2 but NOT sess-1 (since sess-1 is associated with the current agent)
        expect(result).toContain("- **Session ID**: sess-2");
        expect(result).not.toContain("- **Session ID**: sess-1");
      });
    });
  });
});

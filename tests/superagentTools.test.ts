import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import { execa } from "execa";

// Mock Agent and agentLocalStorage completely before any imports
vi.mock("../src/core/agent.js", () => {
  const { AsyncLocalStorage } = require("async_hooks");
  const localStore = new AsyncLocalStorage();

  class MockAgent {
    public delegationDepth = 0;
    public tier = "master";
    public worktreePath: string | null = null;
    public sendMessage = vi.fn().mockImplementation(() => {
      return new Promise((resolve) => setTimeout(resolve, 50));
    });
    public getHistory = vi.fn().mockReturnValue({
      getMessages: () => [
        { role: "assistant", content: "### SUPERAGENT TASK REPORT\n- **Status**: Completed" }
      ]
    });
  }
  return {
    Agent: MockAgent,
    agentLocalStorage: localStore,
  };
});

import { agentLocalStorage } from "../src/core/agent.js";
import { superagentInstances } from "../src/core/tools/state.js";
import {
  invokeSuperagentTool,
  awaitSuperagentsTool,
  mergeSuperagentsTool,
  manageSuperagentsTool,
} from "../src/core/tools/superagentTools.js";

// Mock execa
vi.mock("execa", () => ({
  execa: vi.fn().mockResolvedValue({ stdout: "" }),
}));

// Mock workspace isolation
vi.mock("../src/core/workspaceIsolation.js", () => ({
  ensureGitIgnore: vi.fn(),
  pruneWorktrees: vi.fn().mockResolvedValue(undefined),
}));

// Mock MasterAgent
vi.mock("../src/core/masterAgent.js", () => {
  return {
    MasterAgent: class MockMasterAgent {
      mergeBranch = vi.fn().mockResolvedValue(true);
    }
  };
});

describe("superagentTools", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    superagentInstances.clear();
  });

  afterEach(() => {
    superagentInstances.clear();
  });

  describe("invokeSuperagentTool", () => {
    it("should reject invocation if delegation depth is greater than 0", async () => {
      const parentAgent = { delegationDepth: 1 } as any;
      
      const result = await agentLocalStorage.run(parentAgent, () => {
        return invokeSuperagentTool.execute(
          { role: "developer", task: "code", branch: "feat/some" },
          process.cwd()
        );
      });

      expect(result).toContain("Error: invoke_superagent can only be called by the Master Agent");
    });

    it("should successfully invoke superagent in background and register the instance", async () => {
      const parentAgent = { delegationDepth: 0 } as any;
      
      vi.spyOn(fs, "existsSync").mockReturnValue(false);
      vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);

      const result = await agentLocalStorage.run(parentAgent, () => {
        return invokeSuperagentTool.execute(
          { role: "auth-developer", task: "implement auth", branch: "feat/auth", wait: false },
          process.cwd()
        );
      });

      expect(result).toContain("Superagent \"auth-developer\" spawned in background");
      expect(superagentInstances.size).toBe(1);
      
      const instance = Array.from(superagentInstances.values())[0];
      expect(instance.role).toBe("auth-developer");
      expect(instance.branch).toBe("feat/auth");
      expect(instance.status).toBe("running");

      // Wait for the background task to complete to avoid leakage into other tests
      await new Promise((resolve) => setTimeout(resolve, 70));
    });

    it("should successfully run and wait for superagent if wait is true", async () => {
      const parentAgent = { delegationDepth: 0 } as any;
      
      vi.spyOn(fs, "existsSync").mockReturnValue(false);
      vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);

      const result = await agentLocalStorage.run(parentAgent, () => {
        return invokeSuperagentTool.execute(
          { role: "ui-developer", task: "implement ui", branch: "feat/ui", wait: true },
          process.cwd()
        );
      });

      expect(result).toContain("completed");
      expect(superagentInstances.size).toBe(1);
      const instance = Array.from(superagentInstances.values())[0];
      expect(instance.status).toBe("completed");
    });
  });

  describe("awaitSuperagentsTool", () => {
    it("should return immediately if there are no running superagents", async () => {
      const result = await awaitSuperagentsTool.execute({}, process.cwd());
      expect(result).toContain("No running Superagents found");
    });

    it("should wait for running superagents to finish", async () => {
      superagentInstances.set("agent-1", {
        id: "agent-1",
        role: "dev",
        task: "task",
        branch: "branch",
        worktreePath: "/some/path",
        agent: {} as any,
        status: "running",
        logs: [],
        tokenUsage: { prompt: 0, completion: 0 }
      });

      // Simulate completion in background
      setTimeout(() => {
        const inst = superagentInstances.get("agent-1");
        if (inst) {
          inst.status = "completed";
          inst.result = "Done!";
        }
      }, 50);

      // Pass 5 seconds timeout to avoid race condition with the 2-second polling loop
      const result = await awaitSuperagentsTool.execute({ timeoutSeconds: 5 }, process.cwd());
      expect(result).toContain("All Superagents finished");
      expect(result).toContain("dev (branch) — completed");
    });
  });

  describe("mergeSuperagentsTool", () => {
    it("should reject merge if caller is not master agent", async () => {
      const parentAgent = { delegationDepth: 1 } as any;
      
      const result = await agentLocalStorage.run(parentAgent, () => {
        return mergeSuperagentsTool.execute({}, process.cwd());
      });

      expect(result).toContain("Error: merge_superagents can only be called by the Master Agent");
    });

    it("should return message if no completed superagents found", async () => {
      const parentAgent = { delegationDepth: 0 } as any;
      const result = await agentLocalStorage.run(parentAgent, () => {
        return mergeSuperagentsTool.execute({}, process.cwd());
      });
      expect(result).toContain("No completed Superagents to merge");
    });

    it("should merge branch and cleanup worktree if completed", async () => {
      const parentAgent = { delegationDepth: 0 } as any;
      
      superagentInstances.set("agent-2", {
        id: "agent-2",
        role: "feature-dev",
        task: "task",
        branch: "feat/branch-x",
        worktreePath: "/dummy/worktree-x",
        agent: {} as any,
        status: "completed",
        result: "Done!",
        logs: [],
        tokenUsage: { prompt: 0, completion: 0 }
      });

      vi.spyOn(fs, "existsSync").mockReturnValue(true);

      const result = await agentLocalStorage.run(parentAgent, () => {
        return mergeSuperagentsTool.execute({ cleanupWorktrees: true }, process.cwd());
      });

      expect(result).toContain("Merging 1 Superagent branch(es)");
      expect(result).toContain("Merged: feat/branch-x");
      expect(execa).toHaveBeenCalledWith("git", ["worktree", "remove", "/dummy/worktree-x", "--force"], expect.any(Object));
      expect(superagentInstances.has("agent-2")).toBe(false);
    });
  });

  describe("manageSuperagentsTool", () => {
    it("should reject management if delegation depth is greater than 0", async () => {
      const parentAgent = { delegationDepth: 1 } as any;
      const result = await agentLocalStorage.run(parentAgent, () => {
        return manageSuperagentsTool.execute({ action: "list" }, process.cwd());
      });
      expect(result).toContain("Error: manage_superagents can only be called by the Master Agent");
    });

    it("should list active superagent instances", async () => {
      const parentAgent = { delegationDepth: 0 } as any;
      
      const resultBefore = await agentLocalStorage.run(parentAgent, () => {
        return manageSuperagentsTool.execute({ action: "list" }, process.cwd());
      });
      expect(resultBefore).toContain("None");

      superagentInstances.set("agent-list-test", {
        id: "agent-list-test",
        role: "list-tester",
        task: "do listing",
        branch: "feat/list",
        worktreePath: "/dummy/list",
        agent: {} as any,
        status: "running",
        logs: [],
        tokenUsage: { prompt: 0, completion: 0 }
      });

      const resultAfter = await agentLocalStorage.run(parentAgent, () => {
        return manageSuperagentsTool.execute({ action: "list" }, process.cwd());
      });
      expect(resultAfter).toContain("list-tester");
      expect(resultAfter).toContain("feat/list");
      expect(resultAfter).toContain("running");
    });

    it("should retrieve logs for a specific superagent instance", async () => {
      const parentAgent = { delegationDepth: 0 } as any;

      superagentInstances.set("agent-logs-test", {
        id: "agent-logs-test",
        role: "logs-tester",
        task: "do logging",
        branch: "feat/logs",
        worktreePath: "/dummy/logs",
        agent: {} as any,
        status: "running",
        logs: ["Line 1\n", "Line 2\n"],
        tokenUsage: { prompt: 0, completion: 0 }
      });

      const result = await agentLocalStorage.run(parentAgent, () => {
        return manageSuperagentsTool.execute(
          { action: "logs", superagentIds: ["agent-logs-test"] },
          process.cwd()
        );
      });
      expect(result).toContain("Line 1\nLine 2");
    });

    it("should retrieve report for a specific superagent instance", async () => {
      const parentAgent = { delegationDepth: 0 } as any;

      superagentInstances.set("agent-report-test", {
        id: "agent-report-test",
        role: "report-tester",
        task: "do reporting",
        branch: "feat/report",
        worktreePath: "/dummy/report",
        agent: {} as any,
        status: "completed",
        result: "Report Content!",
        logs: [],
        tokenUsage: { prompt: 0, completion: 0 }
      });

      const result = await agentLocalStorage.run(parentAgent, () => {
        return manageSuperagentsTool.execute(
          { action: "report", superagentIds: ["agent-report-test"] },
          process.cwd()
        );
      });
      expect(result).toContain("Report Content!");
    });

    it("should terminate a running superagent instance via kill", async () => {
      const parentAgent = { delegationDepth: 0 } as any;
      const mockAbort = vi.fn();

      superagentInstances.set("agent-kill-test", {
        id: "agent-kill-test",
        role: "kill-tester",
        task: "do killing",
        branch: "feat/kill",
        worktreePath: "/dummy/kill",
        agent: { abort: mockAbort } as any,
        status: "running",
        logs: [],
        tokenUsage: { prompt: 0, completion: 0 }
      });

      const result = await agentLocalStorage.run(parentAgent, () => {
        return manageSuperagentsTool.execute(
          { action: "kill", superagentIds: ["agent-kill-test"] },
          process.cwd()
        );
      });

      expect(result).toContain("Terminated Superagents: agent-kill-test");
      expect(mockAbort).toHaveBeenCalled();
      const inst = superagentInstances.get("agent-kill-test");
      expect(inst?.status).toBe("error");
      expect(inst?.logs).toContain("[TERMINATED] Superagent terminated by Master Agent.\n");
    });

    it("should terminate all running superagent instances via kill_all", async () => {
      const parentAgent = { delegationDepth: 0 } as any;
      const mockAbort1 = vi.fn();
      const mockAbort2 = vi.fn();

      superagentInstances.set("agent-kill-all-1", {
        id: "agent-kill-all-1",
        role: "kill-tester-1",
        task: "do killing 1",
        branch: "feat/kill1",
        worktreePath: "/dummy/kill1",
        agent: { abort: mockAbort1 } as any,
        status: "running",
        logs: [],
        tokenUsage: { prompt: 0, completion: 0 }
      });

      superagentInstances.set("agent-kill-all-2", {
        id: "agent-kill-all-2",
        role: "kill-tester-2",
        task: "do killing 2",
        branch: "feat/kill2",
        worktreePath: "/dummy/kill2",
        agent: { abort: mockAbort2 } as any,
        status: "completed",
        result: "done",
        logs: [],
        tokenUsage: { prompt: 0, completion: 0 }
      });

      const result = await agentLocalStorage.run(parentAgent, () => {
        return manageSuperagentsTool.execute({ action: "kill_all" }, process.cwd());
      });

      expect(result).toContain("All running Superagent instances terminated.");
      expect(mockAbort1).toHaveBeenCalled();
      expect(mockAbort2).not.toHaveBeenCalled();
      expect(superagentInstances.get("agent-kill-all-1")?.status).toBe("error");
      expect(superagentInstances.get("agent-kill-all-2")?.status).toBe("completed");
    });
  });
});

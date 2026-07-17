import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { superagentInstances, subagentInstances } from "../src/core/tools/state.js";
import { sendMessageToSuperagentTool, awaitSuperagentsTool } from "../src/core/tools/superagentTools.js";
import { sendMessageTool } from "../src/core/tools/subagentTools.js";
import { agentLocalStorage } from "../src/core/agent.js";

let mockLatestAgent: any = null;

// Mock Agent and agentLocalStorage completely before any imports
vi.mock("../src/core/agent.js", () => {
  const { AsyncLocalStorage } = require("async_hooks");
  const localStore = new AsyncLocalStorage();

  class MockAgent {
    public delegationDepth = 0;
    public tier = "master";
    public worktreePath: string | null = null;
    public isMultiAgent = false;
    public subagentType: string | null = null;
    public isRunning = false;
    public sendMessage = vi.fn().mockImplementation(() => {
      return new Promise((resolve) => setTimeout(resolve, 10));
    });
    public getHistory = vi.fn().mockReturnValue({
      getMessages: () => [
        { role: "assistant", content: "### TASK REPORT\n- **Status**: Completed" }
      ]
    });
    public getCurrentHistoryFilePath = vi.fn().mockReturnValue("/dummy/history.json");
    public loadHistoryFromPath = vi.fn().mockResolvedValue(undefined);
    constructor() {
      mockLatestAgent = this;
    }
  }
  return {
    Agent: MockAgent,
    agentLocalStorage: localStore,
  };
});

describe("Paused Resume Workflow", () => {
  beforeEach(() => {
    superagentInstances.clear();
    subagentInstances.clear();
    mockLatestAgent = null;
    vi.restoreAllMocks();
  });

  afterEach(() => {
    superagentInstances.clear();
    subagentInstances.clear();
    mockLatestAgent = null;
  });

  describe("sendMessageToSuperagentTool with paused state", () => {
    it("should reconstruct agent and resume a paused superagent", async () => {
      const parentAgent = { delegationDepth: 0 } as any;

      // Register a paused superagent instance
      const instanceId = "dept1";
      superagentInstances.set(instanceId, {
        id: instanceId,
        role: "developer",
        task: "implement feature",
        branch: "feat/feature",
        worktreePath: "/dummy/worktree",
        agent: {
          abort: () => {},
          getCurrentHistoryFilePath: () => "/dummy/history.json",
        }, // dummy agent from resume
        status: "paused",
        logs: [],
        historyFilePath: "/dummy/history.json",
      });

      const result = await agentLocalStorage.run(parentAgent, () => {
        return sendMessageToSuperagentTool.execute(
          { superagentId: instanceId, message: "please continue", wait: true },
          process.cwd()
        );
      });

      expect(result).toContain("Superagent \"developer\" (branch: feat/feature) completed");
      const inst = superagentInstances.get(instanceId);
      expect(inst).toBeDefined();
      expect(inst!.status).toBe("completed");
      expect(mockLatestAgent).toBeDefined();
      expect(mockLatestAgent.loadHistoryFromPath).toHaveBeenCalledWith("/dummy/history.json");
      expect(mockLatestAgent.sendMessage).toHaveBeenCalledWith("please continue");
    });
  });

  describe("sendMessageTool with paused state", () => {
    it("should reconstruct agent and resume a paused subagent", async () => {
      const parentAgent = { delegationDepth: 1, isMultiAgent: true } as any;

      // Register a paused subagent instance
      const instanceId = "sub1";
      subagentInstances.set(instanceId, {
        id: instanceId,
        typeName: "research",
        role: "researcher",
        agent: {
          abort: () => {},
          getCurrentHistoryFilePath: () => "/dummy/sub-history.json",
        },
        status: "paused",
        logs: [],
        historyFilePath: "/dummy/sub-history.json",
      });

      const result = await agentLocalStorage.run(parentAgent, () => {
        return sendMessageTool.execute(
          { recipientId: instanceId, message: "continue searching", wait: true },
          process.cwd()
        );
      });

      expect(result).toContain("Subagent \"sub1\" finished");
      const inst = subagentInstances.get(instanceId);
      expect(inst).toBeDefined();
      expect(inst!.status).toBe("completed");
      expect(mockLatestAgent).toBeDefined();
      expect(mockLatestAgent.loadHistoryFromPath).toHaveBeenCalledWith("/dummy/sub-history.json");
      expect(mockLatestAgent.sendMessage).toHaveBeenCalledWith("continue searching");
    });
  });

  describe("awaitSuperagentsTool with paused state", () => {
    it("should return a block notice and instructions if there are paused superagents and no running ones", async () => {
      superagentInstances.set("dept1", {
        id: "dept1",
        role: "developer",
        task: "implement feature",
        branch: "feat/feature",
        worktreePath: "/dummy/worktree",
        agent: {},
        status: "paused",
        logs: [],
      });

      const result = await awaitSuperagentsTool.execute({}, process.cwd());
      expect(result).toContain("Wait blocked: There are no running Superagents, but there are paused Superagents");
      expect(result).toContain("You MUST resume them using \"send_message_to_superagent\"");
    });
  });
});

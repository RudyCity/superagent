import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import path from "path";

// ── Break circular dependency chain ──────────────────────────────────────────
vi.mock("../src/core/tools.js", async (importOriginal) => {
  const original = await importOriginal<any>();
  return {
    ...original,
    getToolDefinitions: () => [],
    backgroundTasks: new Map(),
    isTaskInWorkspace: () => false,
  };
});

vi.mock("../src/core/masterAgent.js", async (importOriginal) => {
  const original = await importOriginal<any>();
  return {
    ...original,
    MasterAgent: class {},
  };
});

// Dynamic imports after mocks are established
const { superagentInstances, subagentInstances } = await import("../src/core/tools/state.js");
const { sendMessageToSuperagentTool, awaitSuperagentsTool } = await import("../src/core/tools/superagentTools.js");
const { sendMessageTool } = await import("../src/core/tools/subagentTools.js");
const { Agent, agentLocalStorage } = await import("../src/core/agent.js");

describe("Paused Resume Workflow", () => {
  let loadHistorySpy: any;
  let sendMessageSpy: any;

  beforeEach(() => {
    superagentInstances.clear();
    subagentInstances.clear();
    vi.restoreAllMocks();

    loadHistorySpy = vi.spyOn(Agent.prototype, "loadHistoryFromPath").mockResolvedValue(undefined as any);
    sendMessageSpy = vi.spyOn(Agent.prototype, "sendMessage").mockImplementation(async function(this: any) {
      return "### TASK REPORT\n- **Status**: Completed";
    });
  });

  afterEach(() => {
    superagentInstances.clear();
    subagentInstances.clear();
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
      expect(loadHistorySpy).toHaveBeenCalledWith("/dummy/history.json");
      expect(sendMessageSpy).toHaveBeenCalledWith("please continue");
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
      expect(loadHistorySpy).toHaveBeenCalledWith("/dummy/sub-history.json");
      expect(sendMessageSpy).toHaveBeenCalledWith("continue searching");
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

  afterAll(() => {});
});

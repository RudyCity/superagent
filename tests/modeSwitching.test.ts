import { describe, it, expect, vi, beforeEach } from "vitest";
import { switchModeTool } from "../src/core/tools/modeTools.js";
import { Agent, agentLocalStorage } from "../src/core/agent.js";
import { getToolsetForCategory } from "../src/core/requestClassifier.js";
import { modeCommand } from "../src/core/commands/modeCommand.js";
import { RequestProcessor } from "../src/core/agent/RequestProcessor.js";

describe("Operational Mode Switching Feature", () => {
  let mockAgent: Agent;

  beforeEach(() => {
    process.env.SUPERAGENT_TEST_SIMPLE_TASK = "true";
    mockAgent = new Agent({
      workingDirectory: process.cwd(),
      sessionId: "test-mode-session",
    } as any);
  });

  describe("Agent.setMode", () => {
    it("should switch to implement mode and set category to complex_task", () => {
      const res = mockAgent.setMode("implement", "Need file editing tools");
      expect(res.success).toBe(true);
      expect(res.newMode).toBe("implement");
      expect(mockAgent.activeModeOverride).toBe("implement");
      expect(mockAgent.currentClassification?.category).toBe("complex_task");
      expect(mockAgent.isSimpleTask).toBe(true);
      expect(mockAgent.simpleTaskApproved).toBe(true);
    });

    it("should switch to debug mode and set category to debug", () => {
      const res = mockAgent.setMode("debug", "Fixing error");
      expect(res.success).toBe(true);
      expect(res.newMode).toBe("debug");
      expect(mockAgent.activeModeOverride).toBe("debug");
      expect(mockAgent.currentClassification?.category).toBe("debug");
      expect(mockAgent.isSimpleTask).toBe(true);
      expect(mockAgent.simpleTaskApproved).toBe(true);
    });

    it("should switch to plan mode and set category to complex_task with simpleTask=false", () => {
      const res = mockAgent.setMode("plan", "Creating architectural design");
      expect(res.success).toBe(true);
      expect(res.newMode).toBe("plan");
      expect(mockAgent.activeModeOverride).toBe("plan");
      expect(mockAgent.currentClassification?.category).toBe("complex_task");
      expect(mockAgent.isSimpleTask).toBe(false);
      expect(mockAgent.simpleTaskApproved).toBe(false);
    });

    it("should switch to ask mode and set category to question", () => {
      const res = mockAgent.setMode("ask", "User has a question");
      expect(res.success).toBe(true);
      expect(res.newMode).toBe("ask");
      expect(mockAgent.activeModeOverride).toBe("ask");
      expect(mockAgent.currentClassification?.category).toBe("question");
    });

    it("should clear empty PLANNING_PENDING state when switching to implement", () => {
      mockAgent.planState = "PLANNING_PENDING";
      vi.spyOn(mockAgent, "hasRealPlanContent").mockReturnValue(false);

      mockAgent.setMode("implement", "Bypassing empty pending state");
      expect(mockAgent.planState).toBe("IDLE");
    });
  });

  describe("switchModeTool", () => {
    it("should validate allowed modes and reject invalid modes", async () => {
      const res = await switchModeTool.execute({ mode: "invalid_mode" as any });
      expect(res).toContain("Error: Invalid mode 'invalid_mode'");
    });

    it("should switch mode when agent is in AsyncLocalStorage", async () => {
      mockAgent.activeModeOverride = "ask";
      let result = "";

      await agentLocalStorage.run(mockAgent, async () => {
        result = await switchModeTool.execute({
          mode: "implement",
          reason: "Classifier mistakenly classified as question",
        });
      });

      expect(result).toContain("Successfully switched mode from 'ask' to 'implement'");
      expect(result).toContain("Full toolset unlocked");
      expect(mockAgent.activeModeOverride).toBe("implement");
      expect(mockAgent.currentClassification?.category).toBe("complex_task");
    });
  });

  describe("getToolsetForCategory allows switch_mode", () => {
    const mockTools: any[] = [
      switchModeTool,
      { name: "read", description: "read" },
      { name: "write_to_file", description: "write" },
      { name: "run_command", description: "cmd" },
    ];

    it("should include switch_mode in question category toolset", () => {
      const filtered = getToolsetForCategory("question", mockTools);
      const names = filtered.map((t) => t.name);
      expect(names).toContain("switch_mode");
      expect(names).toContain("read");
      expect(names).not.toContain("write_to_file");
    });

    it("should include switch_mode in conversation category toolset", () => {
      const filtered = getToolsetForCategory("conversation", mockTools);
      const names = filtered.map((t) => t.name);
      expect(names).toContain("switch_mode");
      expect(names).not.toContain("write_to_file");
    });

    it("should include switch_mode in research category toolset", () => {
      const filtered = getToolsetForCategory("research", mockTools);
      const names = filtered.map((t) => t.name);
      expect(names).toContain("switch_mode");
      expect(names).not.toContain("write_to_file");
    });
  });

  describe("RequestProcessor mode switch & confirmation parsing", () => {
    it("should parse 'ganti mode' and switch to implement mode", async () => {
      mockAgent.currentClassification = {
        category: "question",
        confidence: "high",
        reason: "Initial question",
        heuristicOnly: true,
        classificationTokens: 0,
      };

      await RequestProcessor.processRequest(mockAgent, "ganti mode");
      expect(mockAgent.activeModeOverride).toBe("implement");
      expect(mockAgent.currentClassification?.category).toBe("command");
    });

    it("should parse 'switch mode to debug' and switch to debug mode", async () => {
      await RequestProcessor.processRequest(mockAgent, "switch mode to debug");
      expect(mockAgent.activeModeOverride).toBe("debug");
    });

    it("should recognize 'aku izinkan untuk edit' as confirmation in PLANNING_PENDING", async () => {
      mockAgent.planState = "PLANNING_PENDING";
      vi.spyOn(mockAgent, "hasRealPlanContent").mockReturnValue(true);

      await RequestProcessor.processRequest(mockAgent, "aku izinkan untuk edit");
      expect(mockAgent.planState).toBe("APPROVED");
      expect(mockAgent.simpleTaskApproved).toBe(true);
      expect(mockAgent.activeModeOverride).toBe("implement");
    });
  });

  describe("Slash Command /mode", () => {
    it("should display operational mode status when called with no arguments", () => {
      const lines: any[] = [];
      const ctx: any = {
        agent: mockAgent,
        addLine: (l: any) => lines.push(l),
      };

      modeCommand.execute("", ctx);
      expect(lines.length).toBe(1);
      expect(lines[0].content).toContain("Operational Mode Status");
      expect(lines[0].content).toContain("Available Modes");
      expect(lines[0].content).toContain("implement");
      expect(lines[0].content).toContain("ask");
    });

    it("should switch mode when called with a valid mode name", () => {
      const lines: any[] = [];
      const ctx: any = {
        agent: mockAgent,
        addLine: (l: any) => lines.push(l),
      };

      modeCommand.execute("implement", ctx);
      expect(lines.length).toBe(1);
      expect(lines[0].content).toContain("Active mode successfully switched to 'implement'");
      expect(mockAgent.activeModeOverride).toBe("implement");
    });

    it("should reject invalid modes", () => {
      const lines: any[] = [];
      const ctx: any = {
        agent: mockAgent,
        addLine: (l: any) => lines.push(l),
      };

      modeCommand.execute("superpower", ctx);
      expect(lines.length).toBe(1);
      expect(lines[0].type).toBe("error");
      expect(lines[0].content).toContain("Invalid mode 'superpower'");
    });
  });

  describe("ContextBuilder integration with operational modes", () => {
    it("should inject ask mode guidance with switch_mode recommendation when in ask mode", async () => {
      const { ContextBuilder } = await import("../src/core/agent/ContextBuilder.js");
      mockAgent.currentClassification = {
        category: "question",
        confidence: "high",
        reason: "General question",
        heuristicOnly: true,
        classificationTokens: 0,
      };

      const ctx = await ContextBuilder.buildContext(mockAgent);
      expect(ctx.finalSystemPrompt).toContain("# ACTIVE MODE: 'ask'");
      expect(ctx.finalSystemPrompt).toContain("switch_mode");
      expect(ctx.finalSystemPrompt).toContain("Never claim you cannot change mode yourself");
    });

    it("should respect activeModeOverride in ContextBuilder", async () => {
      const { ContextBuilder } = await import("../src/core/agent/ContextBuilder.js");
      mockAgent.currentClassification = {
        category: "question",
        confidence: "high",
        reason: "General question",
        heuristicOnly: true,
        classificationTokens: 0,
      };
      mockAgent.activeModeOverride = "implement";

      const ctx = await ContextBuilder.buildContext(mockAgent);
      expect(ctx.finalSystemPrompt).toContain("# ACTIVE MODE: 'implement'");
      expect(ctx.filteredToolDefs.some((t: any) => t.name === "write_to_file")).toBe(true);
    });
  });
});

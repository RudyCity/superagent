import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { Agent, checkPlanStructure } from "../src/core/agent.js";
import { generateText } from "ai";
import { useWizardSubmit } from "../src/hooks/useWizardSubmit.js";
import { runBackgroundProcessTool } from "../src/core/tools/shellTools.js";
import { invokeSubagentTool } from "../src/core/tools/subagentTools.js";
import { backgroundTasks } from "../src/core/tools/state.js";
import * as configModule from "../src/core/config.js";

// Mock execa at the top level
vi.mock("execa", () => {
  const mockFn = vi.fn();
  (globalThis as any).mockExeca = mockFn;
  return {
    default: mockFn,
    execa: mockFn,
  };
});

// Mock ai SDK
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    generateText: vi.fn(),
  };
});

// Mock react
vi.mock("react", () => {
  return {
    useCallback: (fn: any) => fn,
  };
});

describe("Superagent Proposed Enhancements Tests", () => {
  const testConfigDir = path.join(os.tmpdir(), `superagent-enhancements-tests-${process.pid}`);
  const originalEnv = process.env;

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv, SUPERAGENT_CONFIG_DIR: testConfigDir, SUPERAGENT_TEST_SIMPLE_TASK: "true" };
    fs.rmSync(testConfigDir, { recursive: true, force: true });
    backgroundTasks.clear();
    vi.spyOn(configModule, "getConfig").mockReturnValue({
      provider: "openai",
      model: "gpt-4",
      apiKey: "fake-key",
      disableStreaming: true,
      workingDirectory: process.cwd(),
    } as any);
  });

  afterEach(() => {
    fs.rmSync(testConfigDir, { recursive: true, force: true });
    process.env = originalEnv;
  });

  describe("1. Simple Task Mode & Pre-Approval", () => {
    it("should classify a user prompt as a simple task and approve it", async () => {
      vi.mocked(generateText).mockResolvedValue({
        text: "yes",
        finishReason: "stop",
        usage: { promptTokens: 10, completionTokens: 10 },
      } as any);

      const onEvent = vi.fn();
      const onPermission = vi.fn().mockResolvedValue(true);
      const onQuestion = vi.fn();
      const agent = new Agent(onEvent, onPermission, onQuestion);
      agent.planState = "IDLE";

      // Mock runAgentLoop to return immediately to avoid full run
      vi.spyOn(agent as any, "runAgentLoop").mockResolvedValue(undefined);

      await agent.sendMessage("coba perbaiki typo ini");

      expect(agent.isSimpleTask).toBe(true);
      expect(agent.planState).toBe("APPROVED");
      expect(agent.simpleTaskApproved).toBe(true); // 'coba' is a pre-approval word
    });

    it("should check pre-approval for 'lanjut' and set simpleTaskApproved to true", async () => {
      vi.mocked(generateText).mockResolvedValue({
        text: "yes",
        finishReason: "stop",
        usage: { promptTokens: 10, completionTokens: 10 },
      } as any);

      const onEvent = vi.fn();
      const onPermission = vi.fn().mockResolvedValue(true);
      const onQuestion = vi.fn();
      const agent = new Agent(onEvent, onPermission, onQuestion);
      agent.planState = "IDLE";
      vi.spyOn(agent as any, "runAgentLoop").mockResolvedValue(undefined);

      await agent.sendMessage("lanjutkan tugas");

      expect(agent.isSimpleTask).toBe(true);
      expect(agent.simpleTaskApproved).toBe(true);
    });

    it("should show a confirmation gate for simple task if not pre-approved", async () => {
      const onEvent = vi.fn();
      const onPermission = vi.fn().mockResolvedValue(true);
      const onQuestion = vi.fn().mockResolvedValue("Yes"); // User clicks "Yes"
      const agent = new Agent(onEvent, onPermission, onQuestion);
      agent.isSimpleTask = true;
      agent.simpleTaskApproved = false;
      agent.planState = "APPROVED";

      // Mock generateText to return a write_to_file tool call on first call
      let callCount = 0;
      vi.mocked(generateText).mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            text: "",
            toolCalls: [
              {
                toolCallId: "call_write",
                toolName: "write_to_file",
                args: { TargetFile: "src/cli.tsx", CodeContent: "new content", Overwrite: true, Description: "desc" },
              },
            ],
            finishReason: "stop",
            usage: { promptTokens: 10, completionTokens: 10 },
          } as any;
        }
        return {
          text: "Done",
          toolCalls: [],
          finishReason: "stop",
          usage: { promptTokens: 10, completionTokens: 10 },
        } as any;
      });

      const planPath = agent.getPlanFilePath();
      fs.mkdirSync(path.dirname(planPath), { recursive: true });

      // Run agent
      await agent.sendMessage("fix this file");

      // Verify that onQuestion was called with the filename
      expect(onQuestion).toHaveBeenCalled();
      expect(onQuestion.mock.calls[0][0]).toContain("cli.tsx");
      expect(agent.simpleTaskApproved).toBe(true);
    });
  });

  describe("2. Flexible Plan Templates", () => {
    it("should validate plans matching full template", () => {
      const fullPlan = `# Title\n## Proposed Changes\n## Verification Plan\n### Automated Tests\n### Manual Verification`;
      expect(checkPlanStructure(fullPlan)).toBe(true);
    });

    it("should validate plans matching quick template", () => {
      const quickPlan = `# Title\n## Proposed Changes`;
      expect(checkPlanStructure(quickPlan)).toBe(true);
    });

    it("should validate plans matching refactor template", () => {
      const refactorPlan = `# Title\n## Proposed Changes\n## Architecture`;
      expect(checkPlanStructure(refactorPlan)).toBe(true);
    });

    it("should reject plans that match no templates", () => {
      const invalidPlan = `# Title\n## Wrong Header`;
      expect(checkPlanStructure(invalidPlan)).toBe(false);
    });

    it("should defer plan validation to useWizardSubmit and redirect on failure", async () => {
      const onEvent = vi.fn();
      const onPermission = vi.fn().mockResolvedValue(true);
      const onQuestion = vi.fn();
      const agent = new Agent(onEvent, onPermission, onQuestion);

      const planPath = agent.getPlanFilePath();
      fs.mkdirSync(path.dirname(planPath), { recursive: true });
      fs.writeFileSync(planPath, "# Invalid Plan\n## Wrong Header", "utf8");

      const addLine = vi.fn();
      const setActiveWizard = vi.fn();

      const context: any = {
        activeWizard: { type: "plan_approve", step: 1, data: {} },
        setActiveWizard,
        wizardOptions: [],
        setWizardOptions: vi.fn(),
        wizardSelectedIndex: 0,
        setWizardSelectedIndex: vi.fn(),
        setWizardSelectedSet: vi.fn(),
        addLine,
        setIsProcessing: vi.fn(),
        agentRef: { current: agent },
        planState: "PLANNING_PENDING",
      };

      const handleSubmit = useWizardSubmit(context);
      handleSubmit("approve");

      expect(addLine).toHaveBeenCalledWith(expect.objectContaining({
        type: "error",
        content: expect.stringContaining("invalid or lacks structure"),
      }));
      expect(setActiveWizard).toHaveBeenCalledWith({
        type: "plan_approve",
        step: 2,
        data: {},
      });
    });
  });

  describe("3. Inline Subagents", () => {
    it("should run subagent in background when mode is background", async () => {
      const onEvent = vi.fn();
      const onPermission = vi.fn().mockResolvedValue(true);
      const onQuestion = vi.fn();
      const agent = new Agent(onEvent, onPermission, onQuestion);
      agent.planState = "APPROVED";

      const { defineSubagentTool } = await import("../src/core/tools/subagentTools.js");
      await defineSubagentTool.execute({ name: "researcher", description: "research desc", systemPrompt: "system" }, process.cwd());

      vi.spyOn(Agent.prototype, "sendMessage").mockImplementation(async () => {
        return new Promise(() => {});
      });

      const res = await invokeSubagentTool.execute({
        typeName: "researcher",
        role: "researcher",
        prompt: "do research",
        mode: "background",
      }, process.cwd());

      expect(res).toContain("Invoked subagent");
      expect(res).toContain("background");
    });
  });

  describe("4. Improved Background Process Lifecycle", () => {
    it("should autoRetry failed command with npx prefix", async () => {
      vi.useFakeTimers();
      (globalThis as any).mockExeca.mockImplementation((cmd: string) => {
        const isNpx = cmd.includes("npx ");
        const mockProc: any = {
          all: {
            on: vi.fn(),
          },
          on: vi.fn((event, cb) => {
            if (event === "close") {
              cb(isNpx ? 0 : 1);
            }
          }),
        };
        return mockProc;
      });

      const promise = runBackgroundProcessTool.execute({
        command: "tsc",
        autoRetry: true,
      }, process.cwd());

      // Fast-forward time for both health checks (3000ms each)
      await vi.advanceTimersByTimeAsync(3000);
      await vi.advanceTimersByTimeAsync(3000);

      const res = await promise;
      expect(res).toContain("Background process finished successfully immediately");

      vi.useRealTimers();
    });
  });
});

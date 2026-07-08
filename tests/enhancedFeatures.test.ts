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

// Mock net and http for health check tests
vi.mock("net", async (importOriginal) => {
  const actual = await importOriginal<typeof import("net")>();
  const mockFn = vi.fn();
  (globalThis as any).mockNet = mockFn;
  return {
    ...actual,
    createConnection: mockFn,
    default: {
      ...actual.default,
      createConnection: mockFn,
    },
  };
});

vi.mock("http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("http")>();
  const mockFn = vi.fn();
  (globalThis as any).mockHttp = mockFn;
  return {
    ...actual,
    get: mockFn,
    default: {
      ...actual.default,
      get: mockFn,
    },
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
    vi.spyOn(configModule, "getSettings").mockReturnValue({
      concurrencyLimit: 0,
      rateLimitRpm: 60,
      rateLimitCapacity: 60,
      disableStreaming: true,
      contextWindowLimit: 0,
      maxIterations: 50,
      simpleTaskFileThreshold: 3,
      simpleTaskKeywords: ['lanjut', 'coba', 'go ahead', 'proceed', 'try', 'run', 'execute', 'ok', 'yes', 'y'],
      classifierEnabled: false,
    } as any);
  });

  afterEach(() => {
    for (const task of backgroundTasks.values()) {
      if (task.process && typeof task.process.kill === "function") {
        try {
          task.process.kill();
        } catch {}
      }
    }
    backgroundTasks.clear();
    try {
      fs.rmSync(testConfigDir, { recursive: true, force: true });
    } catch {
      // Retry once to allow background processes to fully release file locks on Windows
      try {
        fs.rmSync(testConfigDir, { recursive: true, force: true });
      } catch {}
    }
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

    it("should respect simple task threshold and keywords settings", async () => {
      vi.mocked(generateText).mockResolvedValue({
        text: "yes",
        finishReason: "stop",
        usage: { promptTokens: 10, completionTokens: 10 },
      } as any);

      // Change settings dynamically
      vi.spyOn(configModule, "getSettings").mockReturnValue({
        simpleTaskFileThreshold: 5,
        simpleTaskKeywords: ["jalan", "mulai"],
        classifierEnabled: false,
      } as any);

      const onEvent = vi.fn();
      const onPermission = vi.fn().mockResolvedValue(true);
      const onQuestion = vi.fn();
      const agent = new Agent(onEvent, onPermission, onQuestion);
      agent.planState = "IDLE";
      vi.spyOn(agent as any, "runAgentLoop").mockResolvedValue(undefined);

      await agent.sendMessage("mulai perbaikan ini");

      expect(agent.isSimpleTask).toBe(true);
      expect(agent.simpleTaskApproved).toBe(true); // 'mulai' is in the custom keywords list
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

    it("should validate plans with relaxed variations of headings", () => {
      const relaxedFullPlan = `# Title\n## Changes\n## Verification\n## Tests\n## Manual Testing`;
      expect(checkPlanStructure(relaxedFullPlan)).toBe(true);

      const relaxedQuickPlan = `# Title\n## Changes`;
      expect(checkPlanStructure(relaxedQuickPlan)).toBe(true);

      const relaxedRefactorPlan = `# Title\n## Changes\n## Design`;
      expect(checkPlanStructure(relaxedRefactorPlan)).toBe(true);
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

    it("should allow spawning subagent even when planState is PLANNING_PENDING", async () => {
      const onEvent = vi.fn();
      const onPermission = vi.fn().mockResolvedValue(true);
      const onQuestion = vi.fn();
      const agent = new Agent(onEvent, onPermission, onQuestion);
      agent.planState = "PLANNING_PENDING";

      const { defineSubagentTool } = await import("../src/core/tools/subagentTools.js");
      await defineSubagentTool.execute({ name: "researcher-pending", description: "research desc", systemPrompt: "system" }, process.cwd());

      vi.spyOn(Agent.prototype, "sendMessage").mockImplementation(async () => {
        return new Promise(() => {});
      });

      const { agentLocalStorage } = await import("../src/core/agent.js");
      const res = await agentLocalStorage.run(agent, async () => {
        return await invokeSubagentTool.execute({
          typeName: "researcher-pending",
          role: "researcher",
          prompt: "do research",
          mode: "background",
        }, process.cwd());
      });

      expect(res).toContain("Invoked subagent");
      expect(res).not.toContain("Spawning Subagents is blocked");
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

    it("should fail health check if port ping fails", async () => {
      // Mock execa to return a running process (does not exit)
      (globalThis as any).mockExeca.mockImplementation(() => {
        return {
          all: { on: vi.fn() },
          on: vi.fn(),
          kill: vi.fn(),
        };
      });

      // Mock net.createConnection to return a mock socket that emits error
      const mockSocket = new (await import("events")).EventEmitter() as any;
      mockSocket.end = vi.fn();
      mockSocket.destroy = vi.fn();
      mockSocket.on("error", () => {}); // Prevent unhandled throw
      (globalThis as any).mockNet.mockImplementation(() => {
        setTimeout(() => {
          mockSocket.emit("error", new Error("port closed"));
        }, 10);
        return mockSocket;
      });

      vi.useFakeTimers();
      (globalThis as any).mockNet.mockClear();

      const promise = runBackgroundProcessTool.execute({
        command: "tsc",
        healthCheckPort: 9999,
      }, process.cwd());

      // Wait for net.createConnection to be called, with safety limit
      let ticks1 = 0;
      while ((globalThis as any).mockNet.mock.calls.length === 0 && ticks1 < 100) {
        await Promise.resolve();
        ticks1++;
      }

      // Fast forward time to elapse the health check wait
      await vi.advanceTimersByTimeAsync(6000);

      const res = await promise;
      expect(res).toContain("failed health check");
      vi.useRealTimers();
    });

    it("should pass health check if port ping succeeds", async () => {
      // Mock execa to return a running process (does not exit)
      (globalThis as any).mockExeca.mockImplementation(() => {
        return {
          all: { on: vi.fn() },
          on: vi.fn(),
          kill: vi.fn(),
        };
      });

      // Mock net.createConnection to return a mock socket that emits connect
      const mockSocket = new (await import("events")).EventEmitter() as any;
      mockSocket.end = vi.fn();
      mockSocket.destroy = vi.fn();
      (globalThis as any).mockNet.mockImplementation(() => {
        setTimeout(() => {
          mockSocket.emit("connect");
        }, 10);
        return mockSocket;
      });

      vi.useFakeTimers();
      (globalThis as any).mockNet.mockClear();

      const promise = runBackgroundProcessTool.execute({
        command: "tsc",
        healthCheckPort: 3000,
      }, process.cwd());

      // Wait for net.createConnection to be called, with safety limit
      let ticks2 = 0;
      while ((globalThis as any).mockNet.mock.calls.length === 0 && ticks2 < 100) {
        await Promise.resolve();
        ticks2++;
      }

      // Fast forward
      await vi.advanceTimersByTimeAsync(3000);

      const res = await promise;
      expect(res).toContain("Started background process");
      vi.useRealTimers();
    });

    it("should retry health check with lockfile-based package manager fallback", async () => {
      // Mock fs.existsSync to simulate pnpm-lock.yaml presence
      const originalExistsSync = fs.existsSync;
      vi.spyOn(fs, "existsSync").mockImplementation((p: any) => {
        if (typeof p === "string" && p.includes("pnpm-lock.yaml")) {
          return true;
        }
        return originalExistsSync(p);
      });

      (globalThis as any).mockExeca.mockImplementation((cmd: string) => {
        const isPnpm = cmd.startsWith("pnpm dlx");
        return {
          all: { on: vi.fn() },
          on: vi.fn((event, cb) => {
            if (event === "close") {
              cb(isPnpm ? 0 : 1);
            }
          }),
        };
      });

      vi.useFakeTimers();

      const promise = runBackgroundProcessTool.execute({
        command: "tsc",
        autoRetry: true,
      }, process.cwd());

      // First health check (failed) and second health check (retry)
      await vi.advanceTimersByTimeAsync(3000);
      await vi.advanceTimersByTimeAsync(3000);

      const res = await promise;
      expect(res).toContain("Background process finished successfully immediately");
      expect((globalThis as any).mockExeca).toHaveBeenCalledWith("pnpm dlx tsc", expect.any(Object));

      vi.useRealTimers();
      vi.restoreAllMocks();
    });
  });

  describe("5. Subagent Timeout Execution", () => {
    it("should abort subagent execution when timeout limit is exceeded", async () => {
      vi.useFakeTimers();

      const onEvent = vi.fn();
      const onPermission = vi.fn().mockResolvedValue(true);
      const onQuestion = vi.fn();
      const agent = new Agent(onEvent, onPermission, onQuestion);
      agent.planState = "APPROVED";

      const { defineSubagentTool } = await import("../src/core/tools/subagentTools.js");
      await defineSubagentTool.execute({ name: "researcher-timeout", description: "desc", systemPrompt: "system" }, process.cwd());

      vi.spyOn(Agent.prototype, "sendMessage").mockImplementation(async () => {
        // Infinite promise to simulate hang
        return new Promise(() => {});
      });

      const promise = invokeSubagentTool.execute({
        typeName: "researcher-timeout",
        role: "researcher",
        prompt: "do research",
        mode: "inline",
        timeoutMs: 1000,
      }, process.cwd());

      await vi.advanceTimersByTimeAsync(1000);

      const res = await promise;
      expect(res).toContain("Timeout: Subagent execution exceeded 1000ms limit.");
      
      vi.useRealTimers();
      vi.restoreAllMocks();
    });
  });
});

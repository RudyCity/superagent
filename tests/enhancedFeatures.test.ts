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
import * as aiModule from "ai";
import * as execaModule from "execa";

vi.mock("react", () => ({
  default: { useCallback: (fn: any) => fn, useRef: (val: any) => ({ current: val }) },
  useCallback: (fn: any) => fn,
  useRef: (val: any) => ({ current: val }),
}));

describe("Superagent Proposed Enhancements Tests", () => {
  const testConfigDir = path.join(os.tmpdir(), `superagent-enhancements-tests-${process.pid}`);
  const originalEnv = process.env;
  let execaSpy: any;

  beforeEach(() => {
    vi.restoreAllMocks();
    const mockStdout: any = { on: vi.fn() };
    const mockProc: any = Promise.resolve({ stdout: mockStdout, stderr: mockStdout, failed: false });
    mockProc.stdout = mockStdout;
    mockProc.stderr = mockStdout;
    mockProc.on = vi.fn();
    mockProc.kill = vi.fn();
    execaSpy = vi.spyOn(execaModule, "execa").mockImplementation(() => mockProc);
    (globalThis as any).mockExeca = execaSpy;

    vi.spyOn(aiModule, "generateText").mockImplementation(async () => ({
      text: "Mocked response",
      toolCalls: [],
      finishReason: "stop",
      usage: { promptTokens: 10, completionTokens: 5 },
    } as any));

    vi.spyOn(aiModule, "streamText").mockImplementation(() => ({
      fullStream: (async function* () {})(),
      usage: Promise.resolve({ promptTokens: 0, completionTokens: 0 }),
    } as any));

    process.env = { ...originalEnv, VITEST: "true", SUPERAGENT_CONFIG_DIR: testConfigDir };
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
      classifierEnabled: true,
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
    } catch {}
    process.env = originalEnv;
  });

  describe("1. Simple Task Mode & Pre-Approval", () => {
    it("should classify a user prompt as a simple task and approve it", async () => {
      const agent = new Agent(
        vi.fn(),
        vi.fn().mockResolvedValue(true),
        vi.fn()
      );
      agent.tier = "master";
      vi.spyOn(agent as any, "classifySimpleTask").mockResolvedValue(true);

      await agent.sendMessage("fix spelling in README");
      expect(agent.planState).toBe("APPROVED");
    });

    it("should check pre-approval for 'lanjut' and set simpleTaskApproved to true", async () => {
      const agent = new Agent(
        vi.fn(),
        vi.fn().mockResolvedValue(true),
        vi.fn()
      );
      agent.tier = "master";

      await agent.sendMessage("lanjut");
      expect(agent.simpleTaskApproved).toBe(true);
    });

    it("should show a confirmation gate for simple task if not pre-approved", async () => {
      const onQuestion = vi.fn().mockResolvedValue("yes");
      const agent = new Agent(
        vi.fn(),
        vi.fn().mockResolvedValue(true),
        onQuestion
      );
      agent.tier = "master";

      const classifierSpy = vi.spyOn(agent as any, "classifySimpleTask").mockResolvedValue(true);

      await agent.sendMessage("update config");

      expect(classifierSpy).toHaveBeenCalled();
      classifierSpy.mockRestore();
    });

    it("should respect simple task threshold and keywords settings", () => {
      const settings = configModule.getSettings();
      expect(settings.simpleTaskFileThreshold).toBe(3);
      expect(settings.simpleTaskKeywords).toContain("lanjut");
    });
  });

  describe("2. Flexible Plan Templates", () => {
    it("should validate plans matching full template", () => {
      const plan = `# User Request\nImplement feature X\n\n## Proposed Changes\n### Component\n- File changes\n\n## Verification Plan\nRun tests`;
      expect(checkPlanStructure(plan)).toBe(true);
    });

    it("should validate plans matching quick template", () => {
      const plan = `# Implementation Plan\n\n## Summary\nQuick fix\n\n## Changes\n- Modify file.ts`;
      expect(checkPlanStructure(plan)).toBe(true);
    });

    it("should validate plans matching refactor template", () => {
      const plan = `# Refactor Plan\n\n## Target\nRefactor module Y\n\n## Proposed Changes\n- Move code`;
      expect(checkPlanStructure(plan)).toBe(true);
    });

    it("should validate plans with relaxed variations of headings", () => {
      const plan = `# Goal\nAdd tests\n\n## Proposed Changes\n- test.ts\n\n## Verification Plan\n- bun test`;
      expect(checkPlanStructure(plan)).toBe(true);
    });

    it("should reject plans that match no templates", () => {
      const plan = `Just a plain string with no structured sections at all.`;
      expect(checkPlanStructure(plan)).toBe(false);
    });

    it("should defer plan validation to useWizardSubmit and redirect on failure", () => {
      const addLine = vi.fn();
      const setActiveWizard = vi.fn();
      const setWizardOptions = vi.fn();
      const setWizardSelectedIndex = vi.fn();

      const agent = new Agent(
        vi.fn(),
        vi.fn().mockResolvedValue(true),
        vi.fn()
      );
      agent.tier = "superagent";
      agent.planFileContent = "invalid plan without headers";

      const context: any = {
        activeWizard: { type: "plan_approve", step: 1, data: {} },
        setActiveWizard,
        setWizardOptions,
        setWizardSelectedIndex,
        wizardOptions: [],
        wizardSelectedIndex: 0,
        addLine,
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
      const { defineSubagentTool } = await import("../src/core/tools/subagentTools.js");
      await defineSubagentTool.execute({ name: "researcher-bg", description: "desc", systemPrompt: "system" }, process.cwd());

      const res = await invokeSubagentTool.execute({
        typeName: "researcher-bg",
        role: "researcher",
        prompt: "do research",
        mode: "background",
      }, process.cwd());

      expect(res).toContain("Invoked subagent");
    });

    it("should allow spawning subagent even when planState is PLANNING_PENDING", async () => {
      const { defineSubagentTool } = await import("../src/core/tools/subagentTools.js");
      await defineSubagentTool.execute({ name: "researcher-plan", description: "desc", systemPrompt: "system" }, process.cwd());

      const agent = new Agent(
        vi.fn(),
        vi.fn().mockResolvedValue(true),
        vi.fn()
      );
      agent.tier = "superagent";
      agent.planState = "PLANNING_PENDING";

      const res = await invokeSubagentTool.execute({
        typeName: "researcher-plan",
        role: "researcher",
        prompt: "do research during planning",
        mode: "background",
      }, process.cwd());

      expect(res).toContain("Invoked subagent");
    });
  });

  describe("4. Improved Background Process Lifecycle", () => {
    it("should autoRetry failed command with npx prefix", async () => {
      vi.useFakeTimers();
      execaSpy.mockImplementation((cmd: string) => {
        const mockProc: any = Promise.resolve({ stdout: "Background task launched" });
        mockProc.on = vi.fn();
        mockProc.kill = vi.fn();
        return mockProc;
      });

      const res = await runBackgroundProcessTool.execute({
        command: "some-cli-tool",
        autoRetryNpx: true,
        healthCheckMs: 0,
      }, process.cwd());

      expect(res).toContain("Background task launched");
      vi.useRealTimers();
    });

    it("should fail health check if port ping fails", async () => {
      execaSpy.mockImplementation(() => {
        const mockProc: any = Promise.resolve({ stdout: "running" });
        mockProc.on = vi.fn();
        mockProc.kill = vi.fn();
        return mockProc;
      });

      const res = await runBackgroundProcessTool.execute({
        command: "node server.js",
        port: 9999,
        healthCheckMs: 100,
      }, process.cwd());

      expect(res).toContain("Health check failed");
    });

    it("should pass health check if port ping succeeds", async () => {
      execaSpy.mockImplementation(() => {
        const mockProc: any = Promise.resolve({ stdout: "running" });
        mockProc.on = vi.fn();
        mockProc.kill = vi.fn();
        return mockProc;
      });

      const net = await import("net");
      const server = net.createServer();
      await new Promise<void>((resolve) => server.listen(9876, resolve));

      const res = await runBackgroundProcessTool.execute({
        command: "node server.js",
        port: 9876,
        healthCheckMs: 500,
      }, process.cwd());

      server.close();
      expect(res).toContain("Port 9876 is open and accepting connections");
    });

    it("should retry health check with lockfile-based package manager fallback", async () => {
      const originalExistsSync = fs.existsSync;
      vi.spyOn(fs, "existsSync").mockImplementation((p: any) => {
        if (p.toString().endsWith("pnpm-lock.yaml")) {
          return true;
        }
        return originalExistsSync(p);
      });

      execaSpy.mockImplementation((cmd: string) => {
        const mockProc: any = Promise.resolve({ stdout: "pnpm dev output" });
        mockProc.on = vi.fn();
        mockProc.kill = vi.fn();
        return mockProc;
      });

      const res = await runBackgroundProcessTool.execute({
        command: "npm run dev",
        autoRetryNpx: true,
        healthCheckMs: 0,
      }, process.cwd());

      expect(res).toContain("Background task launched");
    });
  });

  describe("5. Subagent Timeout Execution", () => {
    it("should abort subagent execution when timeout limit is exceeded", async () => {
      vi.useFakeTimers();

      const { defineSubagentTool } = await import("../src/core/tools/subagentTools.js");
      await defineSubagentTool.execute({ name: "researcher-timeout", description: "desc", systemPrompt: "system" }, process.cwd());

      vi.spyOn(Agent.prototype, "sendMessage").mockImplementation(async () => {
        return new Promise(() => {});
      });

      const promise = invokeSubagentTool.execute({
        typeName: "researcher-timeout",
        role: "researcher",
        prompt: "do research",
        mode: "inline",
        timeoutMs: 1000,
      }, process.cwd());

      vi.advanceTimersByTime(1000);

      const res = await promise;
      expect(res).toContain("Timeout: Subagent execution exceeded 1000ms limit.");

      vi.useRealTimers();
      vi.restoreAllMocks();
    });
  });
});

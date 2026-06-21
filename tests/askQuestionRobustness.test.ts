import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Agent } from "../src/core/agent.js";
import { getToolByName } from "../src/core/tools/index.js";
import { registerQuestionHandler } from "../src/core/tools/state.js";
import { streamText } from "ai";
import * as configModule from "../src/core/config.js";
import { clearModelConfigCache } from "../src/core/config/jsonConfig.js";
import fs from "fs";
import path from "path";
import os from "os";

// Mock configuration partially, keeping other config helpers intact
vi.mock("../src/core/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof configModule>();
  return {
    ...actual,
    getConfig: vi.fn().mockReturnValue({
      provider: "openai",
      model: "gpt-4",
      apiKey: "fake-key",
      disableStreaming: false,
      workingDirectory: process.cwd(),
      systemPrompt: "Base Master Agent Prompt Content",
    }),
  };
});

// Mock ai SDK partially
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    generateText: vi.fn(),
    streamText: vi.fn(),
  };
});

describe("ask_question and ReplacementChunks robustness", () => {
  const originalEnv = process.env;
  const testConfigDir = path.join(os.tmpdir(), `superagent-ask-question-${process.pid}`);

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    process.env = { ...originalEnv, SUPERAGENT_CONFIG_DIR: testConfigDir };
    clearModelConfigCache();
    fs.rmSync(testConfigDir, { recursive: true, force: true });
  });

  afterEach(() => {
    clearModelConfigCache();
    fs.rmSync(testConfigDir, { recursive: true, force: true });
    process.env = originalEnv;
  });

  describe("askQuestionTool execution directly", () => {
    it("handles standard options array", async () => {
      const tool = getToolByName("ask_question");
      const questionHandler = vi.fn().mockResolvedValue("Yes");
      registerQuestionHandler(questionHandler);

      const res = await tool?.execute(
        { question: "Is this correct?", options: ["Yes", "No"] },
        process.cwd()
      );
      expect(res).toContain('User selected option: "Yes"');
      expect(questionHandler).toHaveBeenCalledWith("Is this correct?", ["Yes", "No"], undefined);
    });

    it("handles string options parameter (coerces to array)", async () => {
      const tool = getToolByName("ask_question");
      const questionHandler = vi.fn().mockResolvedValue("Yes");
      registerQuestionHandler(questionHandler);

      const res = await tool?.execute(
        { question: "Is this correct?", options: "Yes" },
        process.cwd()
      );
      expect(res).toContain('User selected option: "Yes"');
      expect(questionHandler).toHaveBeenCalledWith("Is this correct?", ["Yes"], undefined);
    });

    it("handles nested questions array", async () => {
      const tool = getToolByName("ask_question");
      const questionHandler = vi.fn().mockResolvedValue("Option B");
      registerQuestionHandler(questionHandler);

      const res = await tool?.execute(
        {
          questions: [
            {
              question: "Which option?",
              options: ["Option A", "Option B"],
              is_multi_select: true
            }
          ]
        },
        process.cwd()
      );
      expect(res).toContain('User selected option: "Option B"');
      expect(questionHandler).toHaveBeenCalledWith("Which option?", ["Option A", "Option B"], true);
    });
  });

  describe("Agent message loop ask_question and ReplacementChunks processing", () => {
    it("handles ask_question with string options in Agent.sendMessage", async () => {
      const onEvent = vi.fn();
      const onPermission = vi.fn().mockResolvedValue(true);
      const onQuestion = vi.fn().mockResolvedValue("Yes");

      const agent = new Agent(onEvent, onPermission, onQuestion);
      agent.tier = "master";
      agent.planState = "APPROVED";

      vi.mocked(streamText).mockImplementation(() => {
        return {
          fullStream: (async function* () {
            yield {
              type: "tool-call",
              toolCallId: "tc-ask-1",
              toolName: "ask_question",
              args: { question: "Really?", options: "Yes" },
            };
          })(),
          usage: Promise.resolve({ promptTokens: 10, completionTokens: 10 }),
        } as any;
      });

      await agent.sendMessage("ask user");

      // Verify no rawOptions.map is not a function error was thrown
      const errorEvent = onEvent.mock.calls.find((call) => call[0].type === "error");
      expect(errorEvent).toBeUndefined();

      const toolEndEvent = onEvent.mock.calls.find(
        (call) => call[0].type === "tool_end" && call[0].toolResult?.toolCallId === "tc-ask-1"
      );
      expect(toolEndEvent).toBeDefined();
      expect(toolEndEvent[0].toolResult.result).toContain('User selected option: "Yes"');
      expect(onQuestion).toHaveBeenCalledWith("Really?", ["Yes"], undefined);
    });

    it("handles ask_question with questions array format in Agent.sendMessage", async () => {
      const onEvent = vi.fn();
      const onPermission = vi.fn().mockResolvedValue(true);
      const onQuestion = vi.fn().mockResolvedValue("Option A");

      const agent = new Agent(onEvent, onPermission, onQuestion);
      agent.tier = "master";
      agent.planState = "APPROVED";

      vi.mocked(streamText).mockImplementation(() => {
        return {
          fullStream: (async function* () {
            yield {
              type: "tool-call",
              toolCallId: "tc-ask-2",
              toolName: "ask_question",
              args: {
                questions: [
                  { question: "Choose one", options: ["Option A"], isMultiSelect: true }
                ]
              },
            };
          })(),
          usage: Promise.resolve({ promptTokens: 10, completionTokens: 10 }),
        } as any;
      });

      await agent.sendMessage("ask user");

      const errorEvent = onEvent.mock.calls.find((call) => call[0].type === "error");
      expect(errorEvent).toBeUndefined();

      const toolEndEvent = onEvent.mock.calls.find(
        (call) => call[0].type === "tool_end" && call[0].toolResult?.toolCallId === "tc-ask-2"
      );
      expect(toolEndEvent).toBeDefined();
      expect(onQuestion).toHaveBeenCalledWith("Choose one", ["Option A"], true);
    });

    it("handles multi_replace_file_content with non-array ReplacementChunks in plan edits", async () => {
      const onEvent = vi.fn();
      const onPermission = vi.fn().mockResolvedValue(true);
      const onQuestion = vi.fn();

      const agent = new Agent(onEvent, onPermission, onQuestion);
      agent.tier = "master";
      
      agent.getCurrentHistoryFilePath();
      const planFile = agent.getPlanFilePath();
      // Ensure target directory exists
      fs.mkdirSync(path.dirname(planFile), { recursive: true });
      fs.writeFileSync(planFile, "# Test Plan\n## Proposed Changes\n- Spawning superagent reviewer\n## Verification Plan\n### Automated Tests\n### Manual Verification\n", "utf8");

      vi.mocked(streamText).mockImplementation(() => {
        return {
          fullStream: (async function* () {
            yield {
              type: "tool-call",
              toolCallId: "tc-replace-1",
              toolName: "multi_replace_file_content",
              args: {
                TargetFile: planFile,
                filePath: planFile,
                Instruction: "Apply malformed chunk",
                Description: "Malformed chunk test",
                ReplacementChunks: { // Object instead of Array
                  StartLine: 1,
                  EndLine: 2,
                  TargetContent: "# Test Plan",
                  ReplacementContent: "# Test Plan Robust",
                  AllowMultiple: false
                }
              },
            };
          })(),
          usage: Promise.resolve({ promptTokens: 10, completionTokens: 10 }),
        } as any;
      });

      await agent.sendMessage("edit plan");

      const errorEvent = onEvent.mock.calls.find((call) => call[0].type === "error");
      expect(errorEvent).toBeUndefined();

      const content = fs.readFileSync(planFile, "utf8");
      expect(content).toContain("# Test Plan Robust");

      // Clean up plan file
      try {
        fs.unlinkSync(planFile);
      } catch {}
    });
  });
});

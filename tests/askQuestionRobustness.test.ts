import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Agent } from "../src/core/agent.js";
import { getToolByName } from "../src/core/tools/index.js";
import { registerQuestionHandler } from "../src/core/tools/state.js";
import * as aiModule from "ai";
import * as configModule from "../src/core/config.js";
import { clearModelConfigCache } from "../src/core/config/jsonConfig.js";
import fs from "fs";
import path from "path";
import os from "os";

describe("ask_question and ReplacementChunks robustness", () => {
  const originalEnv = process.env;
  const testConfigDir = path.join(os.tmpdir(), `superagent-ask-question-${process.pid}`);

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    process.env = { ...originalEnv, SUPERAGENT_CONFIG_DIR: testConfigDir };
    configModule.closeHistoryDb();
    try {
      const { closeHistoryDb } = require("../src/core/storage/historyDb.js");
      closeHistoryDb();
    } catch {}
    clearModelConfigCache();
    try {
      fs.rmSync(testConfigDir, { recursive: true, force: true });
    } catch {}

    vi.spyOn(aiModule, "streamText").mockImplementation(() => ({} as any));
    vi.spyOn(aiModule, "generateText").mockImplementation(async () => ({} as any));

    vi.spyOn(configModule, "getConfig").mockReturnValue({
      provider: "openai",
      model: "gpt-4",
      apiKey: "fake-key",
      disableStreaming: false,
      workingDirectory: process.cwd(),
      systemPrompt: "Base Master Agent Prompt Content",
    } as any);
  });

  afterEach(() => {
    configModule.closeHistoryDb();
    try {
      const { closeHistoryDb } = require("../src/core/storage/historyDb.js");
      closeHistoryDb();
    } catch {}
    clearModelConfigCache();
    registerQuestionHandler(null);
    try {
      fs.rmSync(testConfigDir, { recursive: true, force: true });
    } catch {}
    process.env = originalEnv;
  });

  describe("askQuestionTool execution directly", () => {
    it("handles standard options array", async () => {
      const tool = getToolByName("ask_question");
      const questionHandler = vi.fn().mockResolvedValue("Yes");
      registerQuestionHandler(questionHandler);

      const result = await tool.execute(
        {
          questions: [
            {
              question: "Do you agree?",
              options: ["Yes", "No"],
              is_multi_select: false,
            },
          ],
        },
        process.cwd()
      );

      expect(questionHandler).toHaveBeenCalledWith("Do you agree?", ["Yes", "No"], false);
      expect(result).toBe("User selected option: \"Yes\"");
    });

    it("handles alternative choices key and formats multi-select response", async () => {
      const tool = getToolByName("ask_question");
      const questionHandler = vi.fn().mockResolvedValue(["Choice A", "Choice B"]);
      registerQuestionHandler(questionHandler);

      const result = await tool.execute(
        {
          questions: [
            {
              question: "Select features",
              choices: ["Choice A", "Choice B", "Choice C"],
              is_multi_select: true,
            },
          ],
        } as any,
        process.cwd()
      );

      expect(result).toBe("User selected option: \"Choice A,Choice B\"");
    });
  });

  describe("ReplacementChunks parser resilience in agent loop", () => {
    it("recovers gracefully when LLM sends JSON string instead of array for ReplacementChunks", async () => {
      const onEvent = vi.fn();
      const onPermission = vi.fn().mockResolvedValue(true);
      const onQuestion = vi.fn();

      const agent = new Agent(onEvent, onPermission, onQuestion);
      agent.tier = "superagent";
      agent.planState = "APPROVED";

      const targetFile = path.join(testConfigDir, "test.txt");
      fs.mkdirSync(testConfigDir, { recursive: true });
      fs.writeFileSync(targetFile, "line 1\nline 2\nline 3\n");

      let callCount = 0;
      vi.spyOn(aiModule, "streamText").mockImplementation(() => {
        callCount++;
        const shouldCall = callCount === 1;
        return {
          fullStream: (async function* () {
            if (shouldCall) {
              yield {
                type: "tool-call",
                toolCallId: "call_1",
                toolName: "multi_replace_file_content",
                args: {
                  filePath: targetFile,
                  TargetFile: targetFile,
                  Instruction: "Update line 2",
                  Description: "Update line 2",
                  ReplacementChunks: JSON.stringify([
                    {
                      StartLine: 2,
                      EndLine: 2,
                      TargetContent: "line 2",
                      ReplacementContent: "line 2 modified",
                      AllowMultiple: false,
                    },
                  ]),
                },
              };
            } else {
              yield { type: "text-delta", textDelta: "Done" };
              yield { type: "finish", finishReason: "stop" };
            }
          })(),
          usage: Promise.resolve({ promptTokens: 10, completionTokens: 10 }),
        } as any;
      });

      await agent.sendMessage("Replace content");

      const fileContent = fs.readFileSync(targetFile, "utf-8");
      expect(fileContent).toBe("line 1\nline 2 modified\nline 3\n");
    });
  });
});

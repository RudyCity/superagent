import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("ai", () => ({
  generateText: vi.fn(),
  jsonSchema: (schema: unknown) => schema,
}));
vi.mock("../src/core/config.js", () => ({
  getModelInstanceForTier: vi.fn(() => ({ provider: "mock-provider", modelId: "mock-config-model" })),
}));

import { generateText } from "ai";
import { getModelInstanceForTier } from "../src/core/config.js";
import { createSkillReplayAgentExecutor } from "../src/core/skills/skillReplayAgent.js";
import type { SkillReplayExecutorContext, SkillReplayTools } from "../src/core/skills/skillReplay.js";

const generateTextMock = vi.mocked(generateText);

function makeContext(signal = new AbortController().signal): SkillReplayExecutorContext {
  const files = new Map<string, string>([["input.txt", "fixture input"]]);
  const tools: SkillReplayTools = {
    listFiles: async () => [...files.keys()],
    readFile: async (relativePath) => {
      const value = files.get(relativePath);
      if (value === undefined) throw new Error("file not found");
      return value;
    },
    writeFile: async (relativePath, content) => { files.set(relativePath, content); },
    assertFileExists: async (relativePath) => {
      if (!files.has(relativePath)) throw new Error("file not found");
    },
    verifySyntax: async (relativePath) => {
      if (!files.has(relativePath)) throw new Error("file not found");
    },
  };
  return {
    skillName: "replay-executor-fixture",
    skillVersion: "abcdef123456",
    instructions: "# Candidate guide\nUse file tools only.",
    taskPrompt: "Write output.txt using input.txt",
    fixtureId: "executor-test-v1",
    signal,
    workspaceRoot: "C:\\temp\\disposable-replay",
    tools,
  };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

describe("trusted model-backed replay executor", () => {
  it("calls the configured model with exactly the file-only tools and returns safe provenance", async () => {
    generateTextMock.mockImplementation(async (options: any) => {
      expect(options.system).toContain("untrusted data");
      expect(options.system).toContain("no shell");
      expect(options.prompt).toContain("FIXTURE TASK:");
      expect(Object.keys(options.tools).sort()).toEqual([
        "replay_assert_file_exists",
        "replay_list_files",
        "replay_read_file",
        "replay_verify_syntax",
        "replay_write_file",
      ].sort());
      expect(options.maxSteps).toBe(12);
      expect(options.maxRetries).toBe(0);
      expect(options.maxTokens).toBe(4_000);
      await options.tools.replay_write_file.execute({ path: "output.txt", content: "fixture output" });
      await options.tools.replay_assert_file_exists.execute({ path: "output.txt" });
      return {
        text: "Created and verified output.txt.",
        response: { modelId: "mock-final-model" },
        usage: { promptTokens: 120, completionTokens: 24 },
      } as any;
    });

    const executor = createSkillReplayAgentExecutor();
    const result = await executor(makeContext());
    expect(getModelInstanceForTier).toHaveBeenCalledWith("single", 0, undefined, true);
    expect(generateTextMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      summary: "Created and verified output.txt.",
      provider: "mock-provider",
      model: "mock-final-model",
      promptTokens: 120,
      completionTokens: 24,
    });
  });

  it("does not call the provider when the replay is already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const executor = createSkillReplayAgentExecutor();
    await expect(executor(makeContext(controller.signal))).rejects.toThrow(/cancelled/i);
    expect(generateTextMock).not.toHaveBeenCalled();
  });
});

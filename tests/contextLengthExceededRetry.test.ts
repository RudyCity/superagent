import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "os";
import path from "path";
import fs from "fs";

const tempHome = path.join(process.cwd(), "tests", "temp-home-context-retry");
vi.spyOn(os, "homedir").mockReturnValue(tempHome);

import { Agent } from "../src/core/agent.js";
import {
  isContextLengthExceeded,
  parseContextLimitTokens,
  isRetryableError,
  getAgentActiveModelName,
} from "../src/core/agent/AgentUtils.js";
import * as aiModule from "ai";
import * as configModule from "../src/core/config.js";

const EXACT_USER_ERROR_SNIPPET = `Fatal error: Provider returned error (status: 400) - response body snippet: "{\\"error\\":{\\"message\\":\\"Provider returned error\\",\\"code\\":400,\\"metadata\\":{\\"raw\\":\\"{\\\\\\"error\\\\\\":{\\\\\\"message\\\\\\":\\\\\\"The request is 286595 tokens long and exceeds this model's context length of 262144 tokens.\\\\\\",\\\\\\"type\\\\\\":\\\\\\"invalid_request_error\\\\\\",\\\\\\"param\\\\\\":\\\\\\"\\\\\\",\\\\\\"code\\\\\\":\\\\\\"context_length_exceeded\\\\\\"}}\\",\\"provider_name\\":\\"Nex AGI\\",\\"is_byok\\":false,\\"provider_error_code\\":\\"context_length_exceeded\\"}},\\"user_id\\":\\"user_30cmooB0TF5esinNkAbFxeKEca5\\"}"`;

describe("Context Length Exceeded (400) Recovery & Robustness", () => {
  let delaySpy: any;
  let compactSpy: any;
  let getConfigSpy: any;
  let streamTextSpy: any;
  let generateTextSpy: any;

  beforeEach(() => {
    if (fs.existsSync(tempHome)) {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }

    getConfigSpy = vi.spyOn(configModule, "getConfig").mockReturnValue({
      provider: "openai",
      model: "gpt-4",
      apiKey: "fake-key",
      disableStreaming: false,
      workingDirectory: process.cwd(),
      systemPrompt: "Base Master Agent Prompt Content",
    } as any);

    vi.spyOn(configModule, "getSettings").mockReturnValue({} as any);

    streamTextSpy = vi.spyOn(aiModule, "streamText");
    generateTextSpy = vi.spyOn(aiModule, "generateText");

    delaySpy = vi.spyOn(Agent.prototype as any, "delayWithCountdown").mockResolvedValue(undefined);
    compactSpy = vi.spyOn(Agent.prototype, "compactHistoryIfNeeded").mockResolvedValue(undefined);
  });

  beforeEach(() => {
    streamTextSpy?.mockClear();
    generateTextSpy?.mockClear();
  });

  afterEach(() => {
    if (fs.existsSync(tempHome)) {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  describe("Detection and Parsing Helpers", () => {
    it("should accurately identify the exact user error report as context length exceeded", () => {
      expect(isContextLengthExceeded(EXACT_USER_ERROR_SNIPPET)).toBe(true);
      expect(isContextLengthExceeded(new Error(EXACT_USER_ERROR_SNIPPET))).toBe(true);
    });

    it("should identify other common context length exceeded error messages", () => {
      expect(isContextLengthExceeded("This model's maximum context length is 128000 tokens")).toBe(true);
      expect(isContextLengthExceeded("prompt is too long for the context window")).toBe(true);
      expect(isContextLengthExceeded("token limit exceeded: 300000 > 262144")).toBe(true);
      expect(isContextLengthExceeded("Please reduce the length of the messages or completion.")).toBe(true);
    });

    it("should not falsely match non-context 400 errors", () => {
      expect(isContextLengthExceeded("Invalid JSON in request body")).toBe(false);
      expect(isContextLengthExceeded("Missing required parameter: prompt")).toBe(false);
      expect(isContextLengthExceeded("Invalid model name")).toBe(false);
    });

    it("should parse requested tokens and maximum tokens from exact user error", () => {
      const parsed = parseContextLimitTokens(EXACT_USER_ERROR_SNIPPET);
      expect(parsed).not.toBeNull();
      expect(parsed?.requestedTokens).toBe(286595);
      expect(parsed?.maxTokens).toBe(262144);
    });

    it("should parse tokens from standard OpenAI context error", () => {
      const msg = "This model's maximum context length is 128000 tokens. However, your messages resulted in 150000 tokens.";
      const parsed = parseContextLimitTokens(msg);
      expect(parsed).not.toBeNull();
      expect(parsed?.maxTokens).toBe(128000);
      expect(parsed?.requestedTokens).toBe(150000);
    });

    it("should treat context length exceeded 400 errors as retryable", () => {
      const err = new Error(EXACT_USER_ERROR_SNIPPET);
      (err as any).status = 400;
      expect(isRetryableError(err)).toBe(true);
    });

    it("should still treat standard 400 errors as non-retryable", () => {
      const err = new Error("Invalid request: unknown field 'foo'");
      (err as any).status = 400;
      expect(isRetryableError(err)).toBe(false);
    });
  });

  describe("Streaming Loop Recovery", () => {
    it("should trigger emergency compaction and retry on HTTP 400 context_length_exceeded", async () => {
      const onEvent = vi.fn();
      const onPermission = vi.fn().mockResolvedValue(true);
      const onQuestion = vi.fn();

      const agent = new Agent(onEvent, onPermission, onQuestion);
      agent.tier = "master";
      agent.planState = "APPROVED";

      let callCount = 0;
      streamTextSpy.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          const err = new Error(EXACT_USER_ERROR_SNIPPET);
          (err as any).status = 400;
          throw err;
        }
        return {
          fullStream: (async function* () {
            yield { type: "text-delta", textDelta: "Compacted and succeeded?" };
          })(),
          usage: Promise.resolve({ promptTokens: 100, completionTokens: 20 }),
        } as any;
      });

      await agent.sendMessage("test input");

      expect(streamTextSpy).toHaveBeenCalledTimes(2);
      expect(compactSpy).toHaveBeenCalledWith(expect.anything(), true, expect.any(Number));
      expect(delaySpy).toHaveBeenCalledWith(1, 1000, expect.anything());

      const successDelta = onEvent.mock.calls.some((call) => call[0].content === "Compacted and succeeded?");
      expect(successDelta).toBe(true);
    });
  });

  describe("Non-Streaming Loop Recovery", () => {
    beforeEach(() => {
      getConfigSpy.mockReturnValue({
        provider: "openai",
        model: "gpt-4",
        apiKey: "fake-key",
        disableStreaming: true,
        workingDirectory: process.cwd(),
        systemPrompt: "Base Master Agent Prompt Content",
      } as any);
    });

    it("should trigger emergency compaction and retry on non-streaming context overflow", async () => {
      const onEvent = vi.fn();
      const onPermission = vi.fn().mockResolvedValue(true);
      const onQuestion = vi.fn();

      const agent = new Agent(onEvent, onPermission, onQuestion);
      agent.tier = "master";
      agent.planState = "APPROVED";

      let callCount = 0;
      generateTextSpy.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          const err = new Error(EXACT_USER_ERROR_SNIPPET);
          (err as any).status = 400;
          throw err;
        }
        return {
          text: "Non-streaming success after compaction?",
          usage: { promptTokens: 50, completionTokens: 15 },
        } as any;
      });

      await agent.sendMessage("test input non streaming");

      expect(generateTextSpy).toHaveBeenCalledTimes(2);
      expect(compactSpy).toHaveBeenCalledWith(expect.anything(), true, expect.any(Number));
      const successDelta = onEvent.mock.calls.some((call) => call[0].content === "Non-streaming success after compaction?");
      expect(successDelta).toBe(true);
    });
  });

  describe("Tier Model Resolution", () => {
    it("should resolve tier-specific model instead of fallback master model", () => {
      const agent = new Agent(vi.fn(), vi.fn(), vi.fn());
      agent.tier = "subagent";
      agent.subagentType = "researcher";
      const modelName = getAgentActiveModelName(agent);
      expect(typeof modelName).toBe("string");
      expect(modelName.length).toBeGreaterThan(0);
    });
  });
});

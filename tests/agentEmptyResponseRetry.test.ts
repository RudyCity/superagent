import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Agent } from "../src/core/agent.js";
import { streamText, generateText } from "ai";
import * as configModule from "../src/core/config.js";

// Mock configuration partially, keeping other config helpers intact
vi.mock("../src/core/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof configModule>();
  return {
    ...actual,
    getConfig: vi.fn().mockReturnValue({
      provider: "openai",
      model: "gpt-4",
      apiKey: "fake-key",
      disableStreaming: false, // will override in individual tests if needed
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

describe("Agent - Empty Response Retry", () => {
  let delaySpy: any;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    // Speed up tests by skipping the actual countdown delay
    delaySpy = vi.spyOn(Agent.prototype as any, "delayWithCountdown").mockResolvedValue(undefined);
  });

  afterEach(() => {
    delaySpy.mockRestore();
  });

  describe("Streaming Mode (disableStreaming: false)", () => {
    it("should retry on empty response and succeed when a subsequent response is valid", async () => {
      const onEvent = vi.fn();
      const onPermission = vi.fn().mockResolvedValue(true);
      const onQuestion = vi.fn();

      const agent = new Agent(onEvent, onPermission, onQuestion);
      agent.tier = "master";
      agent.planState = "APPROVED";

      let callCount = 0;

      vi.mocked(streamText).mockImplementation(() => {
        callCount++;
        const currentCall = callCount;
        return {
          fullStream: (async function* () {
            if (currentCall === 1) {
              // First call yields empty response
              yield { type: "text-delta", textDelta: "" };
            } else {
              // Second call yields valid response
              yield { type: "text-delta", textDelta: "Hello!" };
            }
          })(),
          usage: Promise.resolve({ promptTokens: 10, completionTokens: 10 }),
        } as any;
      });

      await agent.sendMessage("test message");

      // Verify that streamText was called twice (initial + 1 retry)
      expect(streamText).toHaveBeenCalledTimes(2);
      expect(delaySpy).toHaveBeenCalledTimes(1);

      // Verify agent successfully saved message and sent text event
      const textEvent = onEvent.mock.calls.find((call) => call[0].type === "text" && call[0].content === "Hello!");
      expect(textEvent).toBeDefined();

      // No error event should be dispatched since it recovered
      const errorEvent = onEvent.mock.calls.find((call) => call[0].type === "error");
      expect(errorEvent).toBeUndefined();
    });

    it("should retry up to maxRetries and fail with formatted error when all responses are empty", async () => {
      const onEvent = vi.fn();
      const onPermission = vi.fn().mockResolvedValue(true);
      const onQuestion = vi.fn();

      const agent = new Agent(onEvent, onPermission, onQuestion);
      agent.tier = "master";
      agent.planState = "APPROVED";

      vi.mocked(streamText).mockImplementation(() => {
        return {
          fullStream: (async function* () {
            yield { type: "text-delta", textDelta: "   " }; // empty/whitespace response
          })(),
          usage: Promise.resolve({ promptTokens: 10, completionTokens: 10 }),
        } as any;
      });

      await agent.sendMessage("test message");

      // maxRetries is 10, so total attempts is 11 (1 initial + 10 retries)
      expect(streamText).toHaveBeenCalledTimes(11);
      expect(delaySpy).toHaveBeenCalledTimes(10);

      // Verify error event is sent with formatted message
      const errorEvent = onEvent.mock.calls.find((call) => call[0].type === "error");
      expect(errorEvent).toBeDefined();
      expect(errorEvent[0].message).toContain("Stream error after 10 retries: Empty response from model. Check your endpoint/model config.");
    });

    it("should fail immediately without retries when encountering a non-retryable authentication error", async () => {
      const onEvent = vi.fn();
      const onPermission = vi.fn().mockResolvedValue(true);
      const onQuestion = vi.fn();

      const agent = new Agent(onEvent, onPermission, onQuestion);
      agent.tier = "master";
      agent.planState = "APPROVED";

      vi.mocked(streamText).mockImplementation(() => {
        throw new Error("Communication error: Missing Authentication header");
      });

      await agent.sendMessage("test message");

      // Verify that streamText was called only once (0 retries)
      expect(streamText).toHaveBeenCalledTimes(1);
      expect(delaySpy).toHaveBeenCalledTimes(0);

      // Verify error event is sent with fatal error formatted message
      const errorEvent = onEvent.mock.calls.find((call) => call[0].type === "error");
      expect(errorEvent).toBeDefined();
      expect(errorEvent[0].message).toContain("Fatal error: Communication error: Missing Authentication header");
    });
  });

  describe("Non-Streaming Mode (disableStreaming: true)", () => {
    beforeEach(() => {
      vi.mocked(configModule.getConfig).mockReturnValue({
        provider: "openai",
        model: "gpt-4",
        apiKey: "fake-key",
        disableStreaming: true, // test non-streaming path
        workingDirectory: process.cwd(),
        systemPrompt: "Base Master Agent Prompt Content",
      });
    });

    it("should retry on empty response and succeed when a subsequent response is valid", async () => {
      const onEvent = vi.fn();
      const onPermission = vi.fn().mockResolvedValue(true);
      const onQuestion = vi.fn();

      const agent = new Agent(onEvent, onPermission, onQuestion);
      agent.tier = "master";
      agent.planState = "APPROVED";

      let callCount = 0;

      vi.mocked(generateText).mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            text: "",
            toolCalls: [],
            finishReason: "stop",
            usage: { promptTokens: 10, completionTokens: 10 },
          } as any;
        } else {
          return {
            text: "Hello from generateText!",
            toolCalls: [],
            finishReason: "stop",
            usage: { promptTokens: 10, completionTokens: 10 },
          } as any;
        }
      });

      await agent.sendMessage("test message");

      // Verify that generateText was called twice (initial + 1 retry)
      expect(generateText).toHaveBeenCalledTimes(2);
      expect(delaySpy).toHaveBeenCalledTimes(1);

      // Verify agent successfully saved message and sent text event
      const textEvent = onEvent.mock.calls.find((call) => call[0].type === "text" && call[0].content === "Hello from generateText!");
      expect(textEvent).toBeDefined();

      // No error event should be dispatched since it recovered
      const errorEvent = onEvent.mock.calls.find((call) => call[0].type === "error");
      expect(errorEvent).toBeUndefined();
    });

    it("should retry up to maxRetries and fail with formatted error when all responses are empty", async () => {
      const onEvent = vi.fn();
      const onPermission = vi.fn().mockResolvedValue(true);
      const onQuestion = vi.fn();

      const agent = new Agent(onEvent, onPermission, onQuestion);
      agent.tier = "master";
      agent.planState = "APPROVED";

      vi.mocked(generateText).mockImplementation(async () => {
        return {
          text: "   ", // empty/whitespace response
          toolCalls: [],
          finishReason: "stop",
          usage: { promptTokens: 10, completionTokens: 10 },
        } as any;
      });

      await agent.sendMessage("test message");

      // maxRetries is 10, so total attempts is 11 (1 initial + 10 retries)
      expect(generateText).toHaveBeenCalledTimes(11);
      expect(delaySpy).toHaveBeenCalledTimes(10);

      // Verify error event is sent with formatted message
      const errorEvent = onEvent.mock.calls.find((call) => call[0].type === "error");
      expect(errorEvent).toBeDefined();
      expect(errorEvent[0].message).toContain("Generate text failed after 10 retries: Empty response from model. Check your endpoint/model config.");
    });

    it("should fail immediately without retries when encountering a non-retryable authentication error", async () => {
      const onEvent = vi.fn();
      const onPermission = vi.fn().mockResolvedValue(true);
      const onQuestion = vi.fn();

      const agent = new Agent(onEvent, onPermission, onQuestion);
      agent.tier = "master";
      agent.planState = "APPROVED";

      vi.mocked(generateText).mockImplementation(async () => {
        throw new Error("Communication error: Missing Authentication header");
      });

      await agent.sendMessage("test message");

      // Verify that generateText was called only once (0 retries)
      expect(generateText).toHaveBeenCalledTimes(1);
      expect(delaySpy).toHaveBeenCalledTimes(0);

      // Verify error event is sent with fatal error formatted message
      const errorEvent = onEvent.mock.calls.find((call) => call[0].type === "error");
      expect(errorEvent).toBeDefined();
      expect(errorEvent[0].message).toContain("Fatal error: Communication error: Missing Authentication header");
    });
  });
});

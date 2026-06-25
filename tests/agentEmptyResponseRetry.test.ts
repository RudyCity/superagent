import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "os";
import path from "path";
import fs from "fs";

const tempHome = path.join(process.cwd(), "tests", "temp-home-empty-retry");
vi.spyOn(os, "homedir").mockReturnValue(tempHome);

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
    if (fs.existsSync(tempHome)) {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
    vi.clearAllMocks();
    // Speed up tests by skipping the actual countdown delay
    delaySpy = vi.spyOn(Agent.prototype as any, "delayWithCountdown").mockResolvedValue(undefined);
  });

  afterEach(() => {
    if (fs.existsSync(tempHome)) {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
    delaySpy.mockRestore();
  });

  describe("Streaming Mode (disableStreaming: false)", () => {
    it("should retry 3 times with 10s, 20s, and 50s delays when receiving an empty response in streaming mode", async () => {
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

      // Verify streamText was called 4 times in total (1 initial + 3 retries)
      expect(streamText).toHaveBeenCalledTimes(4);
      
      // Verify delays were exactly 10s, 20s, and 50s
      expect(delaySpy).toHaveBeenCalledTimes(3);
      expect(delaySpy).toHaveBeenNthCalledWith(1, 1, 10000, expect.anything());
      expect(delaySpy).toHaveBeenNthCalledWith(2, 2, 20000, expect.anything());
      expect(delaySpy).toHaveBeenNthCalledWith(3, 3, 50000, expect.anything());

      // Verify error event is sent with fatal error formatted message
      const errorEvent = onEvent.mock.calls.find((call) => call[0].type === "error");
      expect(errorEvent).toBeDefined();
      expect(errorEvent[0].message).toContain("Fatal error: Empty response from model. Check your endpoint/model config.");
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

    it("should retry 3 times with 10s, 20s, and 50s delays when receiving an empty response in non-streaming mode", async () => {
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

      // Verify generateText was called 4 times in total (1 initial + 3 retries)
      expect(generateText).toHaveBeenCalledTimes(4);

      // Verify delays were exactly 10s, 20s, and 50s
      expect(delaySpy).toHaveBeenCalledTimes(3);
      expect(delaySpy).toHaveBeenNthCalledWith(1, 1, 10000, expect.anything());
      expect(delaySpy).toHaveBeenNthCalledWith(2, 2, 20000, expect.anything());
      expect(delaySpy).toHaveBeenNthCalledWith(3, 3, 50000, expect.anything());

      // Verify error event is sent with fatal error formatted message
      const errorEvent = onEvent.mock.calls.find((call) => call[0].type === "error");
      expect(errorEvent).toBeDefined();
      expect(errorEvent[0].message).toContain("Fatal error: Empty response from model. Check your endpoint/model config.");
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

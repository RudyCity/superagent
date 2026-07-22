import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "os";
import path from "path";
import fs from "fs";

const tempHome = path.join(process.cwd(), "tests", "temp-home-overloaded-retry");
vi.spyOn(os, "homedir").mockReturnValue(tempHome);

import { Agent } from "../src/core/agent.js";
import * as aiModule from "ai";
import * as configModule from "../src/core/config.js";

describe("Agent - Server Overloaded Retry", () => {
  let delaySpy: any;
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

    streamTextSpy = vi.spyOn(aiModule, "streamText");
    generateTextSpy = vi.spyOn(aiModule, "generateText");

    // Speed up tests by skipping the actual countdown delay
    delaySpy = vi.spyOn(Agent.prototype as any, "delayWithCountdown").mockResolvedValue(undefined);
  });

  afterEach(() => {
    if (fs.existsSync(tempHome)) {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  describe("Streaming Mode (disableStreaming: false)", () => {
    it("should retry 5 times with 5s, 10s, 20s, 50s, and 100s delays when encountering overloaded error in streaming mode", async () => {
      const onEvent = vi.fn();
      const onPermission = vi.fn().mockResolvedValue(true);
      const onQuestion = vi.fn();

      const agent = new Agent(onEvent, onPermission, onQuestion);
      agent.tier = "master";
      agent.planState = "APPROVED";

      streamTextSpy.mockImplementation(() => {
        throw new Error("Our servers are currently overloaded. Please try again later.");
      });

      await agent.sendMessage("test message");

      // Verify streamText was called 6 times in total (1 initial + 5 retries)
      expect(streamTextSpy).toHaveBeenCalledTimes(6);

      // Verify delays were exactly 5s, 10s, 20s, 50s, and 100s
      expect(delaySpy).toHaveBeenCalledTimes(5);
      expect(delaySpy).toHaveBeenNthCalledWith(1, 1, 5000, expect.anything());
      expect(delaySpy).toHaveBeenNthCalledWith(2, 2, 10000, expect.anything());
      expect(delaySpy).toHaveBeenNthCalledWith(3, 3, 20000, expect.anything());
      expect(delaySpy).toHaveBeenNthCalledWith(4, 4, 50000, expect.anything());
      expect(delaySpy).toHaveBeenNthCalledWith(5, 5, 100000, expect.anything());

      // Verify error event is sent with fatal error formatted message
      const errorEvent = onEvent.mock.calls.find((call) => call[0].type === "error");
      expect(errorEvent).toBeDefined();
      expect(errorEvent[0].message).toContain("Stream error after 5 retries: Our servers are currently overloaded. Please try again later.");
    });

    it("should also recognize 'overloaded_error' and retry 5 times", async () => {
      const onEvent = vi.fn();
      const onPermission = vi.fn().mockResolvedValue(true);
      const onQuestion = vi.fn();

      const agent = new Agent(onEvent, onPermission, onQuestion);
      agent.tier = "master";
      agent.planState = "APPROVED";

      streamTextSpy.mockImplementation(() => {
        throw new Error("API status error: overloaded_error");
      });

      await agent.sendMessage("test message");

      // Verify streamText was called 6 times in total
      expect(streamTextSpy).toHaveBeenCalledTimes(6);

      // Verify delays
      expect(delaySpy).toHaveBeenCalledTimes(5);
      expect(delaySpy).toHaveBeenNthCalledWith(1, 1, 5000, expect.anything());
      expect(delaySpy).toHaveBeenNthCalledWith(5, 5, 100000, expect.anything());

      const errorEvent = onEvent.mock.calls.find((call) => call[0].type === "error");
      expect(errorEvent).toBeDefined();
      expect(errorEvent[0].message).toContain("Stream error after 5 retries: API status error: overloaded_error");
    });
  });

  describe("Non-Streaming Mode (disableStreaming: true)", () => {
    beforeEach(() => {
      getConfigSpy.mockReturnValue({
        provider: "openai",
        model: "gpt-4",
        apiKey: "fake-key",
        disableStreaming: true, // test non-streaming path
        workingDirectory: process.cwd(),
        systemPrompt: "Base Master Agent Prompt Content",
      } as any);
    });

    it("should retry 5 times with 5s, 10s, 20s, 50s, and 100s delays when encountering overloaded error in non-streaming mode", async () => {
      const onEvent = vi.fn();
      const onPermission = vi.fn().mockResolvedValue(true);
      const onQuestion = vi.fn();

      const agent = new Agent(onEvent, onPermission, onQuestion);
      agent.tier = "master";
      agent.planState = "APPROVED";

      generateTextSpy.mockImplementation(async () => {
        throw new Error("Our servers are currently overloaded. Please try again later.");
      });

      await agent.sendMessage("test message");

      // Verify generateText was called 6 times in total (1 initial + 5 retries)
      expect(generateTextSpy).toHaveBeenCalledTimes(6);

      // Verify delays were exactly 5s, 10s, 20s, 50s, and 100s
      expect(delaySpy).toHaveBeenCalledTimes(5);
      expect(delaySpy).toHaveBeenNthCalledWith(1, 1, 5000, expect.anything());
      expect(delaySpy).toHaveBeenNthCalledWith(2, 2, 10000, expect.anything());
      expect(delaySpy).toHaveBeenNthCalledWith(3, 3, 20000, expect.anything());
      expect(delaySpy).toHaveBeenNthCalledWith(4, 4, 50000, expect.anything());
      expect(delaySpy).toHaveBeenNthCalledWith(5, 5, 100000, expect.anything());

      // Verify error event is sent with fatal error formatted message
      const errorEvent = onEvent.mock.calls.find((call) => call[0].type === "error");
      expect(errorEvent).toBeDefined();
      expect(errorEvent[0].message).toContain("Generate text failed after 5 retries: Our servers are currently overloaded. Please try again later.");
    });
  });
});

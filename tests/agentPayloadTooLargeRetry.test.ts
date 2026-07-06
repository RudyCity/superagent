import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "os";
import path from "path";
import fs from "fs";

const tempHome = path.join(process.cwd(), "tests", "temp-home-payload-retry");
vi.spyOn(os, "homedir").mockReturnValue(tempHome);

import { Agent } from "../src/core/agent.js";
import { streamText, generateText } from "ai";
import * as configModule from "../src/core/config.js";

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

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    generateText: vi.fn(),
    streamText: vi.fn(),
  };
});

describe("Agent - Payload Too Large (413) Retry", () => {
  let delaySpy: any;
  let compactSpy: any;

  beforeEach(() => {
    if (fs.existsSync(tempHome)) {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
    vi.clearAllMocks();
    delaySpy = vi.spyOn(Agent.prototype as any, "delayWithCountdown").mockResolvedValue(undefined);
    compactSpy = vi.spyOn(Agent.prototype, "compactHistoryIfNeeded").mockResolvedValue(undefined);
  });

  afterEach(() => {
    if (fs.existsSync(tempHome)) {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
    delaySpy.mockRestore();
    compactSpy.mockRestore();
  });

  describe("Streaming Mode (disableStreaming: false)", () => {
    it("should trigger compaction with force=true and retry quickly when encountering 413 error", async () => {
      const onEvent = vi.fn();
      const onPermission = vi.fn().mockResolvedValue(true);
      const onQuestion = vi.fn();

      const agent = new Agent(onEvent, onPermission, onQuestion);
      agent.tier = "master";
      agent.planState = "APPROVED";

      let callCount = 0;
      vi.mocked(streamText).mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          throw new Error("Payload Too Large (status: 413) - response body snippet: Request entity too large");
        }
        // Succeed on retry
        return {
          fullStream: (async function* () {
            yield { type: "text-delta", textDelta: "Success after compaction" };
          })(),
          usage: Promise.resolve({ promptTokens: 10, completionTokens: 5 }),
        } as any;
      });

      await agent.sendMessage("test message");

      // Called twice: 1 failure + 1 success retry
      expect(streamText).toHaveBeenCalledTimes(2);
      expect(compactSpy).toHaveBeenCalledWith(expect.anything(), true);
      expect(delaySpy).toHaveBeenCalledWith(1, 1000, expect.anything());

      const successDelta = onEvent.mock.calls.some((call) => call[0].content === "Success after compaction");
      expect(successDelta).toBe(true);
    });
  });

  describe("Non-Streaming Mode (disableStreaming: true)", () => {
    beforeEach(() => {
      vi.mocked(configModule.getConfig).mockReturnValue({
        provider: "openai",
        model: "gpt-4",
        apiKey: "fake-key",
        disableStreaming: true,
        workingDirectory: process.cwd(),
        systemPrompt: "Base Master Agent Prompt Content",
      });
    });

    it("should trigger compaction with force=true and retry quickly when encountering 413 error", async () => {
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
          throw new Error("Payload Too Large (status: 413) - response body snippet: Request entity too large");
        }
        return {
          text: "Success after compaction",
          usage: { promptTokens: 10, completionTokens: 5 },
        } as any;
      });

      await agent.sendMessage("test message");

      // Called twice: 1 failure + 1 success retry
      expect(generateText).toHaveBeenCalledTimes(2);
      expect(compactSpy).toHaveBeenCalledWith(expect.anything(), true);
      expect(delaySpy).toHaveBeenCalledWith(1, 1000, expect.anything());

      const successDelta = onEvent.mock.calls.some((call) => call[0].content === "Success after compaction");
      expect(successDelta).toBe(true);
    });
  });
});

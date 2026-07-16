import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "os";
import path from "path";
import fs from "fs";

const tempHome = path.join(process.cwd(), "tests", "temp-home-payload-retry");
vi.spyOn(os, "homedir").mockReturnValue(tempHome);

import { Agent, parsePayloadLimitBytes } from "../src/core/agent.js";
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
    getSettings: vi.fn().mockReturnValue({
      autoVisionTokenSaving: false,
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
            yield { type: "text-delta", textDelta: "Success after compaction?" };
          })(),
          usage: Promise.resolve({ promptTokens: 10, completionTokens: 5 }),
        } as any;
      });

      await agent.sendMessage("test message");

      // Called twice: 1 failure + 1 success retry
      expect(streamText).toHaveBeenCalledTimes(2);
      expect(compactSpy).toHaveBeenCalledWith(expect.anything(), true, undefined, expect.any(Number));
      expect(delaySpy).toHaveBeenCalledWith(1, 1000, expect.anything());

      const successDelta = onEvent.mock.calls.some((call) => call[0].content === "Success after compaction?");
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
          text: "Success after compaction?",
          usage: { promptTokens: 10, completionTokens: 5 },
        } as any;
      });

      await agent.sendMessage("test message");

      // Called twice: 1 failure + 1 success retry
      expect(generateText).toHaveBeenCalledTimes(2);
      expect(compactSpy).toHaveBeenCalledWith(expect.anything(), true, undefined, expect.any(Number));
      expect(delaySpy).toHaveBeenCalledWith(1, 1000, expect.anything());

      const successDelta = onEvent.mock.calls.some((call) => call[0].content === "Success after compaction?");
      expect(successDelta).toBe(true);
    });
  });

  describe("Proactive Byte-Size Check", () => {
    it("should trigger proactive compaction when messages size exceeds 4MB", async () => {
      const onEvent = vi.fn();
      const onPermission = vi.fn().mockResolvedValue(true);
      const onQuestion = vi.fn();

      const agent = new Agent(onEvent, onPermission, onQuestion);
      agent.tier = "master";
      agent.planState = "APPROVED";

      // Mock Buffer.byteLength to return 5 MB to simulate a large payload
      const byteLengthSpy = vi.spyOn(Buffer, "byteLength").mockImplementation((str) => {
        if (typeof str === "string" && str.includes("test message")) {
          return 5 * 1024 * 1024;
        }
        return 100;
      });

      vi.mocked(streamText).mockImplementation(() => {
        return {
          fullStream: (async function* () {
            yield { type: "text-delta", textDelta: "Success" };
          })(),
          usage: Promise.resolve({ promptTokens: 10, completionTokens: 5 }),
        } as any;
      });

      await agent.sendMessage("test message");

      // Verify compact was triggered with force=true proactively
      expect(compactSpy).toHaveBeenCalledWith(expect.anything(), true, undefined, expect.any(Number));

      byteLengthSpy.mockRestore();
    });
  });

  describe("parsePayloadLimitBytes helper", () => {
    it("should parse KB values correctly", () => {
      expect(parsePayloadLimitBytes("Request too large (max 100KB)")).toBe(100 * 1024);
      expect(parsePayloadLimitBytes("limit: 50 KB")).toBe(50 * 1024);
      expect(parsePayloadLimitBytes("exceeded 2.5kb")).toBe(2.5 * 1024);
    });

    it("should parse MB values correctly", () => {
      expect(parsePayloadLimitBytes("exceeded 1.5MB")).toBe(1.5 * 1024 * 1024);
      expect(parsePayloadLimitBytes("limit is 10 MB")).toBe(10 * 1024 * 1024);
    });

    it("should parse byte values correctly", () => {
      expect(parsePayloadLimitBytes("exceeded 1048576 bytes")).toBe(1048576);
      expect(parsePayloadLimitBytes("max: 102400 b")).toBe(102400);
    });

    it("should parse raw numbers as bytes if they are large", () => {
      expect(parsePayloadLimitBytes("body size exceeds limit: 1048576")).toBe(1048576);
    });

    it("should return null for invalid messages", () => {
      expect(parsePayloadLimitBytes("something went wrong")).toBeNull();
      expect(parsePayloadLimitBytes("max retries reached")).toBeNull();
    });
  });
});


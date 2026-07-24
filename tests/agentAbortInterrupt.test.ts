import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "os";
import path from "path";
import fs from "fs";

const tempHome = path.join(process.cwd(), "tests", "temp-home-abort-interrupt");
vi.spyOn(os, "homedir").mockReturnValue(tempHome);

import { Agent } from "../src/core/agent.js";
import * as aiModule from "ai";
import * as configModule from "../src/core/config.js";

describe("Agent - Abort and Instant Interruption", () => {
  let streamTextSpy: any;
  let getConfigSpy: any;
  let getModelInstanceForTierSpy: any;

  beforeEach(() => {
    if (fs.existsSync(tempHome)) {
      try {
        fs.rmSync(tempHome, { recursive: true, force: true });
      } catch {
        // On Windows the directory may still be locked (EBUSY) from a previous
        // test run; silently ignore so the test can proceed with the existing dir.
      }
    }

    getConfigSpy = vi.spyOn(configModule, "getConfig").mockReturnValue({
      provider: "openai",
      model: "gpt-4",
      apiKey: "fake-key",
      disableStreaming: false,
      workingDirectory: process.cwd(),
      systemPrompt: "Base Master Agent Prompt Content",
    } as any);

    getModelInstanceForTierSpy = vi.spyOn(configModule, "getModelInstanceForTier").mockReturnValue({} as any);

    streamTextSpy = vi.spyOn(aiModule, "streamText");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (fs.existsSync(tempHome)) {
      try {
        fs.rmSync(tempHome, { recursive: true, force: true });
      } catch {
        // On Windows the directory may still be locked (EBUSY); ignore.
      }
    }
  });

  it("should instantly interrupt and fire done event when abort() is called during text streaming", async () => {
    const onEvent = vi.fn();
    const onPermission = vi.fn().mockResolvedValue(true);
    const onQuestion = vi.fn();

    const agent = new Agent(onEvent, onPermission, onQuestion);
    agent.tier = "master";
    agent.planState = "APPROVED";

    let abortSignalPassed: AbortSignal | undefined;

    streamTextSpy.mockImplementation(({ abortSignal }: any) => {
      abortSignalPassed = abortSignal;
      return {
        fullStream: (async function* () {
          // Keep streaming or wait forever to simulate hang/long request
          await new Promise<void>((resolve, reject) => {
            if (abortSignal) {
              abortSignal.addEventListener("abort", () => {
                const err = new Error("AbortError");
                err.name = "AbortError";
                reject(err);
              });
            }
          });
          yield { type: "text-delta", textDelta: "Hello" };
        })(),
        usage: Promise.resolve({ promptTokens: 10, completionTokens: 10 }),
      } as any;
    });

    const sendPromise = agent.sendMessage("test message");

    // Poll until streamText is called (with a reasonable timeout of 10s for high load/CI environments)
    const pollStart = Date.now();
    while (!abortSignalPassed && Date.now() - pollStart < 10000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(agent.isAgentRunning()).toBe(true);
    expect(abortSignalPassed).toBeDefined();
    expect(abortSignalPassed?.aborted).toBe(false);

    // Call abort
    agent.abort();
    expect(agent.wasRunningBeforeAbort).toBe(true);

    // The sendMessage promise should resolve/reject quickly
    await sendPromise;

    expect(agent.isAgentRunning()).toBe(false);
    expect(abortSignalPassed?.aborted).toBe(true);

    // After a short timeout, wasRunningBeforeAbort should be cleared
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(agent.wasRunningBeforeAbort).toBe(false);

    // Verify done event was fired
    const doneEvent = onEvent.mock.calls.find((call) => call[0].type === "done");
    expect(doneEvent).toBeDefined();

    // Verify Interrupted text was printed
    const textEvent = onEvent.mock.calls.find(
      (call) => call[0].type === "text" && call[0].content.includes("[Interrupted]")
    );
    expect(textEvent).toBeDefined();
  });

  it("should instantly interrupt and fire done event when abort() is called during retry delay", async () => {
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
        throw new Error("Temporary network error");
      }
      return {
        fullStream: (async function* () {
          yield { type: "text-delta", textDelta: "Hello" };
        })(),
        usage: Promise.resolve({ promptTokens: 10, completionTokens: 10 }),
      } as any;
    });

    const sendPromise = agent.sendMessage("test message");

    // Poll until agent is running and has entered the retry delay (with timeout of 10s for high load/CI environments)
    const pollStart2 = Date.now();
    while (!agent.isAgentRunning() && Date.now() - pollStart2 < 10000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(agent.isAgentRunning()).toBe(true);

    // Call abort during retry delay
    agent.abort();

    // The sendMessage promise should resolve/reject quickly
    await sendPromise;

    expect(agent.isAgentRunning()).toBe(false);

    // Verify done event was fired
    const doneEvent = onEvent.mock.calls.find((call) => call[0].type === "done");
    expect(doneEvent).toBeDefined();

    // Verify Interrupted text was printed
    const textEvent = onEvent.mock.calls.find(
      (call) => call[0].type === "text" && call[0].content.includes("[Interrupted]")
    );
    expect(textEvent).toBeDefined();
  });
});

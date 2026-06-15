import { describe, it, expect, vi, beforeEach } from "vitest";
import { Agent } from "../src/core/agent.js";
import { streamText } from "ai";
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

describe("Agent - Abort and Instant Interruption", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("should instantly interrupt and fire done event when abort() is called during text streaming", async () => {
    const onEvent = vi.fn();
    const onPermission = vi.fn().mockResolvedValue(true);
    const onQuestion = vi.fn();

    const agent = new Agent(onEvent, onPermission, onQuestion);
    agent.tier = "master";
    agent.planState = "APPROVED";

    let abortSignalPassed: AbortSignal | undefined;

    vi.mocked(streamText).mockImplementation(({ abortSignal }) => {
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

    // Let the event loop cycle so the agent starts running and enters the streaming call
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(agent.isAgentRunning()).toBe(true);
    expect(abortSignalPassed).toBeDefined();
    expect(abortSignalPassed?.aborted).toBe(false);

    // Call abort
    agent.abort();
    expect(agent.wasRunningBeforeAbort).toBe(true);

    // The sendMessage promise should resolve/reject quickly
    await expect(sendPromise).resolves.not.toThrow();

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
});

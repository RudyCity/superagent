import { describe, expect, it, vi } from "vitest";
import { FastPath } from "../src/core/agent/FastPath.js";

describe("FastPath explicit terminal outcomes (DEEP-01)", () => {
  function createMockAgent(modelOverride?: any) {
    const messages: any[] = [];
    const events: any[] = [];
    const logs: any[] = [];
    const agent: any = {
      tier: "single",
      lastTaskOutcome: null,
      isRunning: false,
      abortController: null,
      currentClassification: null,
      pendingMessagesQueue: [],
      writeToLogFile: vi.fn((type: string, msg: string) => logs.push({ type, msg })),
      onEvent: vi.fn((event: any) => events.push(event)),
      compactHistoryIfNeeded: vi.fn(async () => {}),
      saveHistory: vi.fn(async () => {}),
      autoCheckpoint: vi.fn(),
      flushTextLogBuffer: vi.fn(),
      modelSupportsVision: vi.fn(() => false),
      getModel: vi.fn(() => modelOverride || {
        modelId: "mock-model",
      }),
      config: {
        disableStreaming: true,
      },
      conversation: {
        addUserMessage: vi.fn((msg) => messages.push({ role: "user", content: msg })),
        addAssistantMessage: vi.fn((text, _, __, reasoning) => messages.push({ role: "assistant", content: text, reasoning })),
        addMessage: vi.fn((msg) => messages.push(msg)),
        getMessages: vi.fn(() => messages),
        getContextManager: vi.fn(() => null),
        getTokenEstimate: vi.fn(() => 100),
        pruneToTokenLimit: vi.fn(),
      },
    };
    return { agent, messages, events, logs };
  }

  it("sets lastTaskOutcome to task_failed on model missing or network error", async () => {
    const { agent } = createMockAgent(null); // getModel returns null -> throws error
    agent.getModel = () => null;

    await FastPath.runConversationFastPath(agent, "Hello");

    expect(agent.lastTaskOutcome).toBe("task_failed");
    expect(agent.isRunning).toBe(false);
  });

  it("sets lastTaskOutcome to task_aborted on abort", async () => {
    const { agent } = createMockAgent({
      modelId: "mock-model",
    });

    // Mock an immediate abort
    const origRun = FastPath.runConversationFastPath;
    const abortingAgent: any = {
      ...agent,
      compactHistoryIfNeeded: async () => {
        // Abort right during setup
        abortingAgent.abortController?.abort();
      },
    };

    await FastPath.runConversationFastPath(abortingAgent, "Hello");

    expect(abortingAgent.lastTaskOutcome).toBe("task_aborted");
    expect(abortingAgent.isRunning).toBe(false);
  });
});

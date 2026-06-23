import { describe, it, expect, vi } from "vitest";
import { Conversation, Message } from "../src/core/conversation.js";
import { PruningStrategy } from "../src/core/context/strategies/PruningStrategy.js";
import { SummarizationStrategy } from "../src/core/context/strategies/SummarizationStrategy.js";
import { PinningStrategy } from "../src/core/context/strategies/PinningStrategy.js";
import { Agent } from "../src/core/agent.js";
import { streamText } from "ai";

import * as configModule from "../src/core/config.js";

// Mock configuration partially
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
    getContextWindowLimit: vi.fn().mockReturnValue(8000),
  };
});

// Mock ai SDK partially
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    streamText: vi.fn(),
    generateText: vi.fn(),
  };
});

describe("Orphaned Tool Messages & Error Handling", () => {
  describe("isRetryableError Status 400", () => {
    it("should classify DeepSeek/OpenRouter status 400 invalid request error as non-retryable", () => {
      const errorWithStatus400 = new Error(
        "preset stream failed after 1 attempts: status 400: {'error':{'message':'Messages with role \\'tool\\' must be a response to a preceding message with \\'tool_calls\\'','type':'invalid_request_error'}}"
      );
      
      const agent = new Agent(() => {}, () => Promise.resolve(true), () => {});
      const isRetryable = (agent as any).constructor.name === "Agent" 
        ? (agent as any).delayWithCountdown // just a dummy, let's call the unexported fn via agent instance if possible, or trigger it by throwing
        : true;
      
      // Let's test the retry logic by seeing if it immediately fails on sendMessage
      // We mock streamText to throw this error
      vi.mocked(streamText).mockImplementation(() => {
        throw errorWithStatus400;
      });

      const delaySpy = vi.spyOn(Agent.prototype as any, "delayWithCountdown").mockResolvedValue(undefined);
      const onEvent = vi.fn();
      const testAgent = new Agent(onEvent, () => Promise.resolve(true), () => {});
      testAgent.tier = "master";
      testAgent.planState = "APPROVED";

      return testAgent.sendMessage("test").then(() => {
        expect(streamText).toHaveBeenCalledTimes(1);
        expect(delaySpy).toHaveBeenCalledTimes(0);
        const errorCall = onEvent.mock.calls.find(c => c[0].type === "error");
        expect(errorCall).toBeDefined();
        expect(errorCall[0].message).toContain("Fatal error");
        delaySpy.mockRestore();
      });
    });
  });

  describe("Agent buildMessages Filtering", () => {
    it("should filter out tool messages that do not have a preceding assistant message with tool calls", () => {
      const agent = new Agent(() => {}, () => Promise.resolve(true), () => {});
      const conv = (agent as any).conversation;

      // Clean the conversation messages
      conv.messages = [];

      // Add a user summary message
      conv.addUserMessage("Conversation summary");

      // Add an orphaned tool message (no preceding assistant message at all)
      conv.addMessage({
        role: "tool",
        content: "",
        toolResults: [{ toolCallId: "call-1", name: "test-tool", result: "ok" }],
        timestamp: Date.now(),
      });

      // Add a normal user message
      conv.addUserMessage("Hello");

      // Add assistant message with tool calls
      conv.addAssistantMessage("Thinking", [
        { id: "call-2", name: "test-tool-2", args: {} }
      ]);

      // Add valid tool message
      conv.addMessage({
        role: "tool",
        content: "",
        toolResults: [{ toolCallId: "call-2", name: "test-tool-2", result: "success" }],
        timestamp: Date.now(),
      });

      const coreMessages = (agent as any).buildMessages();

      // Expected coreMessages should only contain:
      // 1. user: "Conversation summary"
      // 2. user: "Hello"
      // 3. assistant: with tool-call
      // 4. tool: with tool-result
      // The first tool message (call-1) should have been filtered out!
      expect(coreMessages.length).toBe(4);
      expect(coreMessages[0].role).toBe("user");
      expect(coreMessages[1].role).toBe("user");
      expect(coreMessages[2].role).toBe("assistant");
      expect(coreMessages[3].role).toBe("tool");
    });
  });

  describe("Compaction Strategies slice boundaries", () => {
    const createMessages = (): Message[] => [
      { role: "user", content: "User 1", timestamp: 1 },
      { role: "assistant", content: "Assistant 1", timestamp: 2 },
      { role: "user", content: "User 2", timestamp: 3 },
      {
        role: "assistant",
        content: "Assistant calling tool",
        toolCalls: [{ id: "call-99", name: "some-tool", args: {} }],
        timestamp: 4,
      },
      {
        role: "tool",
        content: "",
        toolResults: [{ toolCallId: "call-99", name: "some-tool", result: "result 99" }],
        timestamp: 5,
      },
      { role: "user", content: "User 3", timestamp: 6 },
    ];

    it("PruningStrategy should not start kept slice with a tool message", async () => {
      const strategy = new PruningStrategy();
      const messages = createMessages();

      // Slicing preserveRecent = 2 means keeping:
      // - tool (timestamp 5)
      // - user (timestamp 6)
      // Since first kept is a tool message, it should walk forward and keep only user 3
      const result = await strategy.execute(messages, { preserveRecent: 2 });
      
      const keptMessages = result.messages.slice(1); // skip summary message
      expect(keptMessages[0].role).not.toBe("tool");
      expect(keptMessages.length).toBe(1);
      expect(keptMessages[0].content).toBe("User 3");
    });

    it("SummarizationStrategy should not start kept slice with a tool message", async () => {
      const strategy = new SummarizationStrategy();
      const messages = createMessages();

      const result = await strategy.execute(messages, { preserveRecent: 2 });
      
      const keptMessages = result.messages.slice(1); // skip summary message
      expect(keptMessages[0].role).not.toBe("tool");
      expect(keptMessages.length).toBe(1);
      expect(keptMessages[0].content).toBe("User 3");
    });

    it("PinningStrategy should not start kept slice with a tool message", async () => {
      const strategy = new PinningStrategy();
      const messages = createMessages();

      const result = await strategy.execute(messages, {
        preserveRecent: 2,
        pinnedMessageIds: new Set(),
      });
      
      const keptMessages = result.messages.slice(1); // skip summary message
      expect(keptMessages[0].role).not.toBe("tool");
      expect(keptMessages.length).toBe(1);
      expect(keptMessages[0].content).toBe("User 3");
    });

    it("conversation.replaceOldMessagesWithSummary should not start kept slice with a tool message", () => {
      const conv = new Conversation();
      const messages = createMessages();
      (conv as any).messages = [...messages];

      // Replacing all messages except the last 2 (which starts with a tool message)
      conv.replaceOldMessagesWithSummary(4, "Summary");

      const kept = (conv as any).messages.slice(1); // skip summary message
      expect(kept[0].role).not.toBe("tool");
      expect(kept.length).toBe(1);
      expect(kept[0].content).toBe("User 3");
    });
  });
});

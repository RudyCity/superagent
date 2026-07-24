import { describe, it, expect, vi, beforeEach, afterEach, mock } from "vitest";

import { Conversation, Message, contentToString } from "../src/core/conversation.js";
import { PruningStrategy } from "../src/core/context/strategies/PruningStrategy.js";
import { SummarizationStrategy } from "../src/core/context/strategies/SummarizationStrategy.js";
import { PinningStrategy } from "../src/core/context/strategies/PinningStrategy.js";
import { Agent } from "../src/core/agent.js";
import { streamText, generateText } from "ai";

import * as baseConfigModule from "../src/core/config/base.js";
import * as modelsConfigModule from "../src/core/config/models.js";
import * as jsonConfigModule from "../src/core/config/jsonConfig.js";

describe("Orphaned Tool Messages & Error Handling", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();

    // Mock configuration using vi.spyOn for local modules directly
    vi.spyOn(baseConfigModule, "getConfig").mockReturnValue({
      provider: "openai",
      model: "gpt-4",
      apiKey: "fake-key",
      disableStreaming: false,
      workingDirectory: process.cwd(),
      systemPrompt: "Base Master Agent Prompt Content",
    } as any);
    vi.spyOn(modelsConfigModule, "getContextWindowLimit").mockReturnValue(8000);
    vi.spyOn(jsonConfigModule, "getSettings").mockReturnValue({
      autoVisionTokenSaving: false,
    } as any);
  });

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
      // 1. user: "Conversation summary" and "Hello" merged
      // 2. assistant: with tool-call
      // 3. tool: with tool-result
      // The first tool message (call-1) should have been filtered out!
      expect(coreMessages.length).toBe(3);
      expect(coreMessages[0].role).toBe("user");
      expect(contentToString(coreMessages[0].content)).toContain("Conversation summary");
      expect(contentToString(coreMessages[0].content)).toContain("Hello");
      expect(coreMessages[1].role).toBe("assistant");
      expect(coreMessages[2].role).toBe("tool");
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

  describe("MessageBuilder cleanMessageSequence", () => {
    it("should merge consecutive user messages", () => {
      const agent = new Agent(() => {}, () => Promise.resolve(true), () => {});
      const conv = (agent as any).conversation;
      conv.messages = [];
      conv.addUserMessage("Hello");
      conv.addUserMessage("World");

      const coreMessages = (agent as any).buildMessages();
      expect(coreMessages.length).toBe(1);
      expect(coreMessages[0].role).toBe("user");
      expect(contentToString(coreMessages[0].content)).toContain("Hello\n\nWorld");
    });

    it("should merge consecutive assistant messages", () => {
      const agent = new Agent(() => {}, () => Promise.resolve(true), () => {});
      const conv = (agent as any).conversation;
      conv.messages = [];
      conv.addUserMessage("Trigger user turn"); // first must be user
      conv.addAssistantMessage("Thinking...");
      conv.addAssistantMessage("Done.");

      const coreMessages = (agent as any).buildMessages();
      // user + merged assistant
      expect(coreMessages.length).toBe(2);
      expect(coreMessages[0].role).toBe("user");
      expect(coreMessages[1].role).toBe("assistant");
      expect(contentToString(coreMessages[1].content)).toContain("Thinking...\n\nDone.");
    });

    it("should strip unanswered tool calls from assistant message", () => {
      const agent = new Agent(() => {}, () => Promise.resolve(true), () => {});
      const conv = (agent as any).conversation;
      conv.messages = [];
      conv.addUserMessage("Trigger user turn");
      conv.addAssistantMessage("Running tool", [
        { id: "call-unanswered", name: "some-tool", args: {} }
      ]);
      // No tool result follows it. A user message follows instead.
      conv.addUserMessage("Next user message");

      const coreMessages = (agent as any).buildMessages();
      // Expect the assistant message to be converted to plain text (tool calls stripped)
      expect(coreMessages.length).toBe(3);
      expect(coreMessages[0].role).toBe("user");
      expect(coreMessages[1].role).toBe("assistant");
      // Check that content does not contain tool-call part type
      if (Array.isArray(coreMessages[1].content)) {
        const hasToolCallPart = coreMessages[1].content.some((p: any) => p.type === "tool-call");
        expect(hasToolCallPart).toBe(false);
      }
      expect(coreMessages[2].role).toBe("user");
    });

    it("should filter out/skip orphaned tool messages", () => {
      const agent = new Agent(() => {}, () => Promise.resolve(true), () => {});
      const conv = (agent as any).conversation;
      conv.messages = [];
      conv.addUserMessage("Hello");
      // Add tool message directly without preceding assistant message
      conv.addMessage({
        role: "tool",
        content: "",
        toolResults: [{ toolCallId: "call-orphaned", name: "some-tool", result: "orphaned result" }],
        timestamp: Date.now(),
      });

      const coreMessages = (agent as any).buildMessages();
      // Should be dropped entirely. So length is 1 (just Hello).
      expect(coreMessages.length).toBe(1);
      expect(coreMessages[0].role).toBe("user");
      expect(contentToString(coreMessages[0].content)).not.toContain("orphaned result");
    });

    it("should insert a dummy assistant message when a tool message is followed by a user message", () => {
      const agent = new Agent(() => {}, () => Promise.resolve(true), () => {});
      const conv = (agent as any).conversation;
      conv.messages = [];
      conv.addUserMessage("Initial prompt");
      conv.addAssistantMessage("Running tool", [
        { id: "call-1", name: "some-tool", args: {} }
      ]);
      conv.addMessage({
        role: "tool",
        content: "",
        toolResults: [{ toolCallId: "call-1", name: "some-tool", result: "tool output" }],
        timestamp: Date.now(),
      });
      conv.addUserMessage("New user instruction");

      const coreMessages = (agent as any).buildMessages();
      // Expect 5 messages:
      // 1. user: "Initial prompt"
      // 2. assistant: "Running tool" with toolCalls
      // 3. tool: with toolResults
      // 4. assistant: "Continuing..." (dummy)
      // 5. user: "New user instruction"
      expect(coreMessages.length).toBe(5);
      expect(coreMessages[0].role).toBe("user");
      expect(coreMessages[1].role).toBe("assistant");
      expect(coreMessages[2].role).toBe("tool");
      expect(coreMessages[3].role).toBe("assistant");
      expect(contentToString(coreMessages[3].content)).toBe("Continuing...");
      expect(coreMessages[4].role).toBe("user");
      expect(contentToString(coreMessages[4].content)).toBe("New user instruction");
    });
  });
});

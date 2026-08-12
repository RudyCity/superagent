import { describe, it, expect } from "vitest";
import { MessageBuilder } from "../src/core/agent/MessageBuilder.js";
import { contentToString } from "../src/core/conversation.js";
import type { CoreMessage } from "ai";

describe("MessageBuilder tool sequence sanitization", () => {
  const messageBuilder = new MessageBuilder();
  const dummyAgent = {} as any;

  it("should absorb tool results into user message when converting leading assistant tool-call message", () => {
    const inputMessages: CoreMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Executing tool..." },
          { type: "tool-call", toolCallId: "call_123", toolName: "read_file", args: { path: "file.txt" } },
        ],
      },
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "call_123", toolName: "read_file", result: "file contents here" },
        ],
      },
      {
        role: "user",
        content: "Now process this file.",
      },
    ];

    const result = (messageBuilder as any).cleanMessageSequence(inputMessages, dummyAgent);

    // The leading assistant message and its tool results should be converted into user text,
    // and merged with the following user message. No orphaned tool message should remain!
    expect(result.length).toBe(1);
    expect(result[0].role).toBe("user");
    const textStr = typeof result[0].content === "string" ? result[0].content : contentToString(result[0].content as any);
    expect(textStr).toContain("[Previous Assistant Message]");
    expect(textStr).toContain("[Tool Results]");
    expect(textStr).toContain("file contents here");
    expect(textStr).toContain("Now process this file.");
  });

  it("should drop orphaned tool messages that do not follow an assistant tool-call", () => {
    const inputMessages: CoreMessage[] = [
      {
        role: "user",
        content: "Hello",
      },
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "orphan_call", toolName: "read_file", result: "data" },
        ],
      },
      {
        role: "assistant",
        content: "Hi there!",
      },
    ];

    const result = (messageBuilder as any).cleanMessageSequence(inputMessages, dummyAgent);

    expect(result.length).toBe(2);
    expect(result[0].role).toBe("user");
    expect(result[1].role).toBe("assistant");
  });

  it("should strip tool calls from assistant message if no matching tool result follows", () => {
    const inputMessages: CoreMessage[] = [
      {
        role: "user",
        content: "Start",
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check" },
          { type: "tool-call", toolCallId: "call_unmatched", toolName: "search", args: {} },
        ],
      },
      {
        role: "user",
        content: "Wait, do something else instead",
      },
    ];

    const result = (messageBuilder as any).cleanMessageSequence(inputMessages, dummyAgent);

    expect(result.length).toBe(3);
    expect(result[1].role).toBe("assistant");
    // Tool calls should be stripped so it does not send an unfulfilled tool call before user message
    const assistantContent = result[1].content;
    if (Array.isArray(assistantContent)) {
      expect(assistantContent.some((p: any) => p.type === "tool-call")).toBe(false);
    }
  });
});

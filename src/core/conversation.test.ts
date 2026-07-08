import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Conversation } from "./conversation.js";
import fs from "fs/promises";
import path from "path";

describe("Conversation", () => {
  const tempConvPath = path.resolve(process.cwd(), "temp_conversation.json");

  afterEach(async () => {
    try {
      await fs.unlink(tempConvPath);
    } catch {}
  });

  it("should add user and assistant messages and retrieve them", () => {
    const conv = new Conversation();
    conv.addUserMessage("Hello there");
    conv.addAssistantMessage("Hi! How can I help you?");

    const msgs = conv.getMessages();
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe("user");
    expect(msgs[0].content).toBe("Hello there");
    expect(msgs[1].role).toBe("assistant");
    expect(msgs[1].content).toBe("Hi! How can I help you?");
  });

  it("should add assistant message with reasoning and retrieve it", () => {
    const conv = new Conversation();
    conv.addAssistantMessage("Response text", undefined, undefined, "Reasoning details");

    const msgs = conv.getMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("assistant");
    expect(msgs[0].content).toBe("Response text");
    expect(msgs[0].reasoning).toBe("Reasoning details");
  });

  it("should filter system messages in getApiMessages", () => {
    const conv = new Conversation();
    conv.addMessage({
      role: "system",
      content: "You are an assistant",
      timestamp: Date.now(),
    });
    conv.addUserMessage("Who are you?");

    const apiMsgs = conv.getApiMessages();
    expect(apiMsgs).toHaveLength(1);
    expect(apiMsgs[0].role).toBe("user");
    expect(apiMsgs[0].content).toBe("Who are you?");
  });

  it("should estimate tokens based on length", () => {
    const conv = new Conversation();
    conv.addUserMessage("12345678"); // 8 chars -> ~2 tokens
    expect(conv.getTokenEstimate()).toBe(2);
  });

  it("should enforce max history limit", () => {
    const conv = new Conversation();
    // maxHistory is 200, let's write 205 messages
    for (let i = 0; i < 205; i++) {
      conv.addUserMessage(`message ${i}`);
    }
    const msgs = conv.getMessages();
    expect(msgs).toHaveLength(200);
    expect(msgs[0].content).toBe("message 5");
    expect(msgs[199].content).toBe("message 204");
  });

  it("should prune messages to fit token limit", () => {
    const conv = new Conversation();
    conv.addUserMessage("A very long message"); // 19 chars -> 5 tokens
    conv.addAssistantMessage("Short"); // 5 chars -> 2 tokens
    conv.addUserMessage("Another message"); // 15 chars -> 4 tokens
    conv.addAssistantMessage("Extra message here"); // 18 chars -> 5 tokens

    // Prune to limit of ~10 tokens
    conv.pruneToTokenLimit(10);
    const msgs = conv.getMessages();
    expect(conv.getTokenEstimate()).toBeLessThanOrEqual(10);
    expect(msgs[msgs.length - 1].content).toBe("Extra message here");
  });

  it("should save and load conversation history to/from file", async () => {
    const conv = new Conversation();
    conv.addUserMessage("Test file save");
    await conv.saveToFile(tempConvPath);

    const loadedConv = new Conversation();
    await loadedConv.loadFromFile(tempConvPath);

    const msgs = loadedConv.getMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe("Test file save");
  });

  it("should proactively strip old tool results and prune routine results faster", () => {
    const conv = new Conversation();

    // Build a result string long enough to exceed PREVIEW_CHARS (800) so truncation triggers
    const longResult = (prefix: string) =>
      Array.from({ length: 60 }, (_, i) => `${prefix} line ${i + 1}: ${"x".repeat(20)}`).join("\n");

    // 1. Add non-routine tool (e.g. run_command)
    conv.addAssistantMessage("running build", [{ id: "c1", name: "run_command", args: {} }]);
    conv.addMessage({
      role: "tool",
      content: "",
      toolResults: [{ toolCallId: "c1", name: "run_command", result: longResult("build output"), isError: false }],
      timestamp: Date.now()
    });

    // 2. Add routine tool (e.g. read_file)
    conv.addAssistantMessage("reading file", [{ id: "c2", name: "read_file", args: {} }]);
    conv.addMessage({
      role: "tool",
      content: "",
      toolResults: [{ toolCallId: "c2", name: "read_file", result: longResult("file content"), isError: false }],
      timestamp: Date.now()
    });

    // At this point:
    // - "read_file" is the most recent (1st tool message seen). It should be intact.
    // - "run_command" is the 2nd tool message seen. Since it is non-routine, and keepCycles is 2, it should be intact.
    let msgs = conv.getMessages();
    expect(msgs.find(m => m.toolResults?.[0]?.name === "read_file")?.toolResults?.[0]?.result).toContain("file content line 1");
    expect(msgs.find(m => m.toolResults?.[0]?.name === "run_command")?.toolResults?.[0]?.result).toContain("build output line 1");

    // 3. Add another tool call to advance the cycle
    conv.addAssistantMessage("running test", [{ id: "c3", name: "run_command", args: {} }]);
    conv.addMessage({
      role: "tool",
      content: "",
      toolResults: [{ toolCallId: "c3", name: "run_command", result: "tests passed", isError: false }],
      timestamp: Date.now()
    });

    // Now:
    // - "run_command (tests passed)" is 1st tool message seen. Intact (short result, no truncation).
    // - "read_file" is 2nd tool message seen. Since it is routine, its keepCycles is 1. It should be stripped!
    // - "run_command (build output)" is 3rd tool message seen. Since toolMessagesSeen (3) > keepCycles (2), it should be stripped!
    msgs = conv.getMessages();
    expect(msgs.find(m => m.toolResults?.[0]?.name === "read_file")?.toolResults?.[0]?.result).toContain("truncated");
    expect(msgs.find(m => m.toolResults?.[0]?.name === "run_command" && m.toolResults?.[0]?.toolCallId === "c1")?.toolResults?.[0]?.result).toContain("truncated");
    expect(msgs.find(m => m.toolResults?.[0]?.name === "run_command" && m.toolResults?.[0]?.toolCallId === "c3")?.toolResults?.[0]?.result).toBe("tests passed");
  });

  it("should save and load conversation history synchronously to/from file", () => {
    const conv = new Conversation();
    conv.addUserMessage("Test sync file save");
    conv.saveToFileSync(tempConvPath);

    const loadedConv = new Conversation();
    // loadFromFile is async, but we can verify it loads the synchronously saved file successfully
    return loadedConv.loadFromFile(tempConvPath).then(() => {
      const msgs = loadedConv.getMessages();
      expect(msgs).toHaveLength(1);
      expect(msgs[0].content).toBe("Test sync file save");
    });
  });
});

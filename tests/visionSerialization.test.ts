import { describe, it, expect, vi, beforeEach } from "vitest";
import { Agent } from "../src/core/agent.js";
import * as configModule from "../src/core/config.js";


describe("Vision Message Serialization", () => {
  let agent: Agent;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(configModule, "getConfig").mockReturnValue({
      provider: "openai",
      model: "gpt-4",
      apiKey: "fake-key",
      disableStreaming: false,
      workingDirectory: process.cwd(),
      systemPrompt: "Base Master Agent Prompt Content",
    } as any);
    vi.spyOn(configModule, "getContextWindowLimit" as any).mockReturnValue(8000);
    vi.spyOn(configModule, "getTierModel" as any).mockReturnValue(undefined);
    vi.spyOn(configModule, "getSettings" as any).mockReturnValue({});
    agent = new Agent(() => {}, () => Promise.resolve(true), () => {});
    agent.tier = "master";
  });

  it("should keep image parts intact when the model supports vision", () => {
    // Mock getTierModel to return a vision-supporting model (e.g., claude-3-5-sonnet)
    vi.mocked(configModule.getTierModel).mockReturnValue("claude-3-5-sonnet-20241022");

    const conv = (agent as any).conversation;
    conv.messages = [];
    conv.addMessage({
      role: "user",
      content: [
        { type: "text", text: "Here is an image" },
        { type: "image", image: "base64data", mimeType: "image/png" }
      ],
      timestamp: Date.now(),
    });

    const sdkMessages = (agent as any).buildMessages();
    expect(sdkMessages).toHaveLength(1);
    expect(sdkMessages[0].role).toBe("user");
    expect(sdkMessages[0].content).toEqual([
      { type: "text", text: "Here is an image" },
      { type: "image", image: "data:image/png;base64,base64data", mimeType: "image/png" }
    ]);
  });

  it("should preserve image parts as-is when model does not support vision", () => {
    // buildPlaintextMessages preserves image parts for any model
    vi.mocked(configModule.getTierModel).mockReturnValue("deepseek-chat");

    const conv = (agent as any).conversation;
    conv.messages = [];
    conv.addMessage({
      role: "user",
      content: [
        { type: "text", text: "Here is an image" },
        { type: "image", image: "base64data", mimeType: "image/png" }
      ],
      timestamp: Date.now(),
    });

    const sdkMessages = (agent as any).buildMessages();
    expect(sdkMessages).toHaveLength(1);
    expect(sdkMessages[0].role).toBe("user");
    expect(sdkMessages[0].content).toEqual([
      { type: "text", text: "Here is an image" },
      { type: "image", image: "data:image/png;base64,base64data", mimeType: "image/png" }
    ]);
  });

  it("should not extract fake/stub base64 data URIs from tool results as images", () => {
    vi.mocked(configModule.getTierModel).mockReturnValue("claude-3-5-sonnet-20241022");

    const conv = (agent as any).conversation;
    conv.messages = [];
    conv.addMessage({
      role: "user",
      content: "check mocks",
      timestamp: Date.now(),
    });
    conv.addMessage({
      role: "assistant",
      content: "Running search",
      toolCalls: [{ id: "call_1", name: "ripgrep_search", args: { query: "fake" } }],
      timestamp: Date.now(),
    });
    conv.addMessage({
      role: "tool",
      content: "",
      toolResults: [
        {
          toolCallId: "call_1",
          name: "ripgrep_search",
          result: "toDataURL: vi.fn().mockResolvedValue('data:image/png;base64,fake-qr')"
        }
      ],
      timestamp: Date.now(),
    });
    conv.addMessage({
      role: "user",
      content: "lanjut",
      timestamp: Date.now(),
    });

    const sdkMessages = (agent as any).buildMessages();
    // Verify tool result retained the raw mock text and did NOT create an image user message
    const toolMessage = sdkMessages.find((m: any) => m.role === "tool");
    expect(toolMessage).toBeDefined();
    expect((toolMessage!.content as any)[0].result).toContain("data:image/png;base64,fake-qr");

    // The user message 'lanjut' should NOT contain any attached fake image parts
    const lastUserMessage = sdkMessages[sdkMessages.length - 1];
    expect(lastUserMessage.role).toBe("user");
    expect(lastUserMessage.content).toBe("lanjut");
  });

  it("should extract valid high-entropy base64 images from tool results when model supports vision", () => {
    vi.mocked(configModule.getTierModel).mockReturnValue("claude-3-5-sonnet-20241022");

    const validPngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const conv = (agent as any).conversation;
    conv.messages = [];
    conv.addMessage({
      role: "user",
      content: "take screenshot",
      timestamp: Date.now(),
    });
    conv.addMessage({
      role: "assistant",
      content: "Taking screenshot",
      toolCalls: [{ id: "call_2", name: "browser_screenshot", args: {} }],
      timestamp: Date.now(),
    });
    conv.addMessage({
      role: "tool",
      content: "",
      toolResults: [
        {
          toolCallId: "call_2",
          name: "browser_screenshot",
          result: `Screenshot taken: data:image/png;base64,${validPngBase64}`
        }
      ],
      timestamp: Date.now(),
    });

    const sdkMessages = (agent as any).buildMessages();
    const toolMessage = sdkMessages.find((m: any) => m.role === "tool");
    expect(toolMessage).toBeDefined();
    expect((toolMessage!.content as any)[0].result).toContain("[Image (image/png) attached as a vision image part]");

    const attachedImageUserMsg = sdkMessages.find((m: any) => m.role === "user" && Array.isArray(m.content) && m.content.some((p: any) => p.type === "image"));
    expect(attachedImageUserMsg).toBeDefined();
  });
});
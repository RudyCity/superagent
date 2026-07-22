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
    vi.spyOn(configModule, "getSettings" as any).mockReturnValue({ autoVisionTokenSaving: false });
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
      { type: "image", image: "base64data", mimeType: "image/png" }
    ]);
  });

  it("should convert image parts to text placeholders when the model does not support vision", () => {
    // Mock getTierModel to return a non-vision model (e.g., deepseek-chat)
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
      {
        type: "text",
        text: "[Image: (image/png) - not sent because the active model (deepseek-chat) does not support vision/images. Base64 Data: data:image/png;base64,base64data]"
      }
    ]);
  });
});

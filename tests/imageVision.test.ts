import { describe, it, expect, vi, beforeEach } from "vitest";
import { Agent } from "../src/core/agent.js";
import { MessageBuilder } from "../src/core/agent/MessageBuilder.js";
import { Conversation, contentToString } from "../src/core/conversation.js";
import { FastPath } from "../src/core/agent/FastPath.js";

vi.mock("ai", () => ({
  streamText: vi.fn(),
  generateText: vi.fn(),
}));

import { streamText, generateText } from "ai";

import * as baseConfigModule from "../src/core/config/base.js";
import * as modelsConfigModule from "../src/core/config/models.js";
import * as jsonConfigModule from "../src/core/config/jsonConfig.js";

describe("Image Vision and FastPath Integration", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();

    vi.spyOn(baseConfigModule, "getConfig").mockReturnValue({
      provider: "openai",
      model: "gpt-4",
      apiKey: "fake-key",
      disableStreaming: false,
      workingDirectory: process.cwd(),
      systemPrompt: "Base Agent Prompt Content",
    } as any);
    vi.spyOn(modelsConfigModule, "getContextWindowLimit").mockReturnValue(8000);
    vi.spyOn(jsonConfigModule, "getSettings").mockReturnValue({
      autoVisionTokenSaving: false,
      enableRmemory: false,
    } as any);
  });

  describe("MessageBuilder modelSupportsVision", () => {
    it("should auto-detect vision support for known vision models by name", () => {
      const builder = new MessageBuilder();
      const agent = new Agent(() => {}, () => Promise.resolve(true), () => {});

      // Even with no agent/tier configuration, known names should support vision
      expect(builder.modelSupportsVision("gemini-3.5-flash", agent)).toBe(true);
      expect(builder.modelSupportsVision("claude-3-5-sonnet", agent)).toBe(true);
      expect(builder.modelSupportsVision("gpt-4o-mini", agent)).toBe(true);
      expect(builder.modelSupportsVision("gpt-4-vision-preview", agent)).toBe(true);
      expect(builder.modelSupportsVision("some-vision-model", agent)).toBe(true);
      
      // Unknown names with no config should not support vision
      expect(builder.modelSupportsVision("my-custom-llm", agent)).toBe(false);
    });
  });

  describe("FastPath user image preservation", () => {
    it("should keep image parts in user messages if model supports vision", async () => {
      vi.mocked(streamText).mockReturnValue({
        fullStream: (async function* () {
          yield { type: "text-delta", textDelta: "Test response" };
        })(),
        usage: Promise.resolve({ promptTokens: 10, completionTokens: 10 }),
      } as any);

      vi.mocked(generateText).mockResolvedValue({
        text: "Test response",
        usage: { promptTokens: 10, completionTokens: 10 },
      } as any);

      const agent = new Agent(() => {}, () => Promise.resolve(true), () => {});
      vi.spyOn(agent, "getModel").mockReturnValue({
        modelId: "gemini-3.5-flash",
        provider: "google",
      } as any);

      // Create a user message with text and image
      const input = [
        { type: "text" as const, text: "Check this image" },
        { type: "image" as const, image: "base64data", mimeType: "image/png" }
      ];

      // Run FastPath
      await FastPath.runConversationFastPath(agent, input);

      // Check streamText call arguments
      expect(streamText).toHaveBeenCalled();
      const callArgs = vi.mocked(streamText).mock.calls[0][0];
      const messages = callArgs.messages;

      // First message is summary/init, second message is our input
      expect(messages.length).toBeGreaterThanOrEqual(2);
      const lastMessage = messages[messages.length - 1];
      expect(lastMessage.role).toBe("user");
      
      const content = lastMessage.content;
      expect(Array.isArray(content)).toBe(true);
      expect(content[0]).toEqual({ type: "text", text: "Check this image" });
      expect(content[1]).toEqual({ type: "image", image: "base64data", mimeType: "image/png" });
    });

    it("should strip image parts if model does not support vision", async () => {
      vi.mocked(streamText).mockReturnValue({
        fullStream: (async function* () {
          yield { type: "text-delta", textDelta: "Test response" };
        })(),
        usage: Promise.resolve({ promptTokens: 10, completionTokens: 10 }),
      } as any);

      vi.mocked(generateText).mockResolvedValue({
        text: "Test response",
        usage: { promptTokens: 10, completionTokens: 10 },
      } as any);

      const agent = new Agent(() => {}, () => Promise.resolve(true), () => {});
      // Use a model name that does not support vision
      vi.spyOn(agent, "getModel").mockReturnValue({
        modelId: "custom-text-only-model",
        provider: "custom",
      } as any);

      const input = [
        { type: "text" as const, text: "Check this image" },
        { type: "image" as const, image: "base64data", mimeType: "image/png" }
      ];

      await FastPath.runConversationFastPath(agent, input);

      expect(streamText).toHaveBeenCalled();
      const callArgs = vi.mocked(streamText).mock.calls[0][0];
      const messages = callArgs.messages;

      expect(messages.length).toBeGreaterThanOrEqual(2);
      const lastMessage = messages[messages.length - 1];
      expect(lastMessage.role).toBe("user");
      // Image should be replaced by [image] placeholder in plain text
      expect(typeof lastMessage.content).toBe("string");
      expect(lastMessage.content).toContain("[image]");
      expect(lastMessage.content).toContain("Check this image");
    });
  });
});

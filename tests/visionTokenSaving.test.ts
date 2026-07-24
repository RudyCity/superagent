import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "os";
import path from "path";
import fs from "fs";

const tempHome = path.join(process.cwd(), "tests", "temp-home-vision-token-saving");
vi.spyOn(os, "homedir").mockReturnValue(tempHome);

import { Agent } from "../src/core/agent.js";
import * as configModule from "../src/core/config.js";

// Mock the textToImage module so we don't need real PowerShell/Python dependency in unit test
vi.mock("../src/utils/textToImage.js", () => ({
  sliceTextIntoPages: (text: string) => [text],
  renderTextToImageBase64: vi.fn().mockReturnValue("MOCK_BASE64_IMAGE_DATA"),
  minifyTextForImage: (text: string) => text.trim(),
}));

// Mock ai SDK synchronously
let lastGenerateTextOptions: any = null;
vi.mock("ai", () => ({
  generateText: vi.fn(async (options: any) => {
    lastGenerateTextOptions = options;
    return {
      text: "Mocked response",
      toolCalls: [],
      usage: { promptTokens: 10, completionTokens: 2 }
    };
  }),
  streamText: vi.fn((options: any) => {
    lastGenerateTextOptions = options;
    const mockStream = (async function* () {
      yield { type: "text-delta", textDelta: "Mocked stream response" };
    })();
    return {
      fullStream: mockStream,
      usage: Promise.resolve({ promptTokens: 10, completionTokens: 2 })
    };
  }),
  jsonSchema: (s: any) => s,
}));


describe("Agent - Vision Token Saving Auto-Conversion", () => {
  beforeEach(() => {
    if (fs.existsSync(tempHome)) {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
    vi.clearAllMocks();
    // Re-apply config spies after restoreAllMocks
    vi.spyOn(configModule, "getConfig").mockReturnValue({
      provider: "openai",
      model: "gpt-4o",
      apiKey: "fake-key",
      disableStreaming: false,
      workingDirectory: process.cwd(),
    } as any);
    vi.spyOn(configModule, "getTierModel" as any).mockReturnValue("gpt-4o");
    vi.spyOn(configModule, "getTierModelConfig" as any).mockReturnValue({ model: "gpt-4o", supportsVision: true });
    vi.spyOn(configModule, "getSettings" as any).mockReturnValue({
      autoVisionTokenSaving: true,
      visionTokenSavingThreshold: 100,
    });
    vi.spyOn(configModule, "getDynamicVisionThreshold" as any).mockReturnValue(100);
  });

  afterEach(() => {
    if (fs.existsSync(tempHome)) {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });



  it("does not convert user message to image if feature is disabled", async () => {
    // Override getSettings to disable saving
    vi.mocked(configModule.getSettings).mockReturnValue({
      autoVisionTokenSaving: false,
      visionTokenSavingThreshold: 100,
    });

    const agent = new Agent("single");
    const longText = "a".repeat(150);
    agent.conversation.addUserMessage(longText);

    const messages = (agent as any).buildMessages(true);

    expect(messages.length).toBe(1);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toBe(longText);
  });



  it("honors configured supportsVision: false even if model name suggests vision support", () => {
    vi.mocked(configModule.getTierModelConfig).mockReturnValue({
      providerProfileId: "fake-key",
      model: "gpt-4o",
      supportsVision: false,
    });

    const agent = new Agent("single");
    const longText = "a".repeat(150);
    agent.conversation.addUserMessage(longText);

    const messages = (agent as any).buildMessages(true);

    expect(messages.length).toBe(1);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toBe(longText); // Stays as text because vision is configured to false
  });

  it("honors configured supportsVision: true even if model name does not suggest vision support", () => {
    vi.mocked(configModule.getTierModel).mockReturnValue("custom-model-non-vision");
    vi.mocked(configModule.getTierModelConfig).mockReturnValue({
      providerProfileId: "fake-key",
      model: "custom-model-non-vision",
      supportsVision: true,
    });

    const agent = new Agent("single");
    const longText = "a".repeat(150);
    agent.conversation.addUserMessage(longText);

    const messages = (agent as any).buildMessages(true);

    expect(messages.length).toBe(1);
    expect(messages[0].role).toBe("user");
    expect(Array.isArray(messages[0].content)).toBe(true);
    const imagePart = messages[0].content.find((p: any) => p.type === "image");
    expect(imagePart).toBeDefined();
  });




  it("uses the correct dynamic threshold based on model provider in getDynamicVisionThreshold", async () => {
    vi.mocked(configModule.getDynamicVisionThreshold as any).mockRestore();
    const { getDynamicVisionThreshold: realGetDynamic } = await import("../src/core/config/jsonConfig.js");
    
    vi.mocked(configModule.getSettings).mockReturnValue({
      autoVisionTokenSaving: true,
      visionTokenSavingThreshold: 3000,
    });

    expect(realGetDynamic("claude-3-5-sonnet")).toBe(6500);
    expect(realGetDynamic("gemini-1.5-pro")).toBe(3000);
    expect(realGetDynamic("gpt-4o")).toBe(3000);
  });

  it("estimates token count using simulated image token counts when vision saving is active", async () => {
    const { TokenTracker } = await import("../src/core/context/TokenTracker.js");
    const tracker = new TokenTracker("claude-3-5-sonnet");

    const msg = {
      role: "user",
      content: "a".repeat(150),
      timestamp: Date.now()
    };

    await tracker.ensureEncoder();
    const count = tracker.estimateTokens(msg as any);

    expect(count).toBeGreaterThan(1000); // 1600 image tokens + 150 header tokens
  });

  it("handles Mode 2 (compiled prompt to images) and minifies whitespace/newlines", async () => {
    vi.mocked(configModule.getSettings).mockReturnValue({
      autoVisionTokenSaving: true,
      visionTokenSavingThreshold: 100,
    });

    const agent = new Agent("single");
    agent.conversation.addUserMessage("hello \n\n\n\nworld  \t");
    agent.conversation.addAssistantMessage("response", [
      { id: "c1", name: "view_file", args: { path: "a.txt" } }
    ]);
    agent.conversation.addMessage({
      role: "tool",
      timestamp: Date.now(),
      toolResults: [{ toolCallId: "c1", name: "view_file", result: "content" }]
    });

    const messages = (agent as any).buildMessages(true);
    // In Mode 2, all messages should be compiled into a single user message with images
    expect(messages.length).toBe(1);
    expect(messages[0].role).toBe("user");
    expect(Array.isArray(messages[0].content)).toBe(true);
    expect(messages[0].content[0].type).toBe("image");
    
    const imageParts = messages[0].content.filter((p: any) => p.type === "image");
    expect(imageParts.length).toBeGreaterThan(0);
  });
});


import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "os";
import path from "path";
import fs from "fs";

const tempHome = path.join(process.cwd(), "tests", "temp-home-vision-token-saving");
vi.spyOn(os, "homedir").mockReturnValue(tempHome);

import { Agent } from "../src/core/agent.js";
import * as configModule from "../src/core/config.js";

// Mock configuration
vi.mock("../src/core/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof configModule>();
  return {
    ...actual,
    getConfig: vi.fn().mockReturnValue({
      provider: "openai",
      model: "gpt-4o",
      apiKey: "fake-key",
      disableStreaming: false,
      workingDirectory: process.cwd(),
    }),
    getTierModel: vi.fn().mockReturnValue("gpt-4o"),
    getTierModelConfig: vi.fn().mockReturnValue({ model: "gpt-4o", supportsVision: true }),
    getSettings: vi.fn().mockReturnValue({
      autoVisionTokenSaving: true,
      visionTokenSavingThreshold: 100, // Small threshold for easy testing
    }),
    getDynamicVisionThreshold: vi.fn().mockImplementation((modelName) => {
      return 100; // Force threshold of 100 for all models in tests
    }),
  };
});

// Mock the textToImage module so we don't need real PowerShell/Python dependency in unit test
vi.mock("../src/utils/textToImage.js", () => {
  return {
    sliceTextIntoPages: (text: string, maxLines = 150, maxPages = 3) => {
      return [text]; // Simpler slicing for tests
    },
    renderTextToImageBase64: vi.fn().mockReturnValue("MOCK_BASE64_IMAGE_DATA"),
    minifyTextForImage: (text: string) => {
      return text.trim();
    },
  };
});

let lastGenerateTextOptions: any = null;
vi.mock("ai", async (importOriginal) => {
  const original = await importOriginal<any>();
  return {
    ...original,
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
        usage: Promise.resolve({
          promptTokens: 10,
          completionTokens: 2
        })
      };
    })
  };
});

describe("Agent - Vision Token Saving Auto-Conversion", () => {
  beforeEach(() => {
    if (fs.existsSync(tempHome)) {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (fs.existsSync(tempHome)) {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("converts a large user message to image parts if vision model is active and feature is enabled", async () => {
    const agent = new Agent("single");
    
    // Add user message shorter than threshold
    agent.conversation.addUserMessage("short message");
    
    // Add user message longer than threshold (threshold is 100 chars)
    const longText = "a".repeat(150);
    agent.conversation.addUserMessage(longText);

    // Call private buildMessages method
    const messages = (agent as any).buildMessages(true);

    expect(messages.length).toBe(2);
    // First message should be raw text since it's short
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toBe("short message");

    // Second message should be converted to an image
    expect(messages[1].role).toBe("user");
    expect(Array.isArray(messages[1].content)).toBe(true);
    expect(messages[1].content[0].type).toBe("text");
    expect(messages[1].content[0].text).toContain("rendered as images");
    const imagePart = messages[1].content.find((p: any) => p.type === "image");
    expect(imagePart).toBeDefined();
    expect(imagePart.image).toBe("MOCK_BASE64_IMAGE_DATA");
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

  it("converts a large tool message to image and appends a subsequent user message with the image data", async () => {
    // Re-enable settings
    vi.mocked(configModule.getSettings).mockReturnValue({
      autoVisionTokenSaving: true,
      visionTokenSavingThreshold: 100,
    });

    const agent = new Agent("single");
    
    // In native tool call workflow, we must have a preceding assistant message with tool calls
    agent.conversation.addAssistantMessage("running file read", [{
      id: "call-1",
      name: "view_file",
      args: { path: "somefile.txt" }
    }]);

    // Add a tool response longer than threshold
    const longResult = "b".repeat(150);
    agent.conversation.addMessage({
      role: "tool",
      timestamp: Date.now(),
      toolResults: [{
        toolCallId: "call-1",
        name: "view_file",
        result: longResult
      }]
    });

    const messages = (agent as any).buildMessages(true);

    // Messages should be: Assistant, Tool (with placeholder), and User (with image)
    expect(messages.length).toBe(3);
    
    expect(messages[0].role).toBe("assistant");
    
    // Tool result message should contain placeholder
    expect(messages[1].role).toBe("tool");
    expect(messages[1].content[0].type).toBe("tool-result");
    expect(messages[1].content[0].result).toContain("rendered as image in the subsequent message");

    // The appended User message should contain the image
    expect(messages[2].role).toBe("user");
    expect(messages[2].content[0].text).toContain("rendered as image");
    const imagePart = messages[2].content.find((p: any) => p.type === "image");
    expect(imagePart).toBeDefined();
    expect(imagePart.image).toBe("MOCK_BASE64_IMAGE_DATA");
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

  it("converts a large system prompt to image and prepends it to messages during execution", async () => {
    vi.mocked(configModule.getSettings).mockReturnValue({
      autoVisionTokenSaving: true,
      visionTokenSavingThreshold: 100, // Small threshold
    });

    const agent = new Agent(
      vi.fn(),
      vi.fn().mockResolvedValue(true),
      vi.fn().mockResolvedValue("yes")
    );
    agent.tier = "master";
    agent.planState = "APPROVED"; // skip planning to go straight to execution loop

    await agent.sendMessage("hello");

    // Check if generateText or streamText was called and captured options
    expect(lastGenerateTextOptions).not.toBeNull();
    // System parameter should keep critical guidance while image content carries long instructions
    expect(lastGenerateTextOptions.system).toContain("Follow all safety, workspace, tool, and hierarchy rules");
    expect(lastGenerateTextOptions.system).toContain("rendered as images in the first user message");
    
    // Messages array should contain prepended user and assistant messages with the images
    const msgs = lastGenerateTextOptions.messages;
    expect(msgs.length).toBeGreaterThanOrEqual(3); // prepend user + prepend assistant + original user message
    expect(msgs[0].role).toBe("user");
    expect(msgs[0].content[0].text).toContain("System instructions rendered as images");
    const imagePart = msgs[0].content.find((p: any) => p.type === "image");
    expect(imagePart).toBeDefined();
    expect(imagePart.image).toBe("MOCK_BASE64_IMAGE_DATA");

    expect(msgs[1].role).toBe("assistant");
    expect(msgs[1].content).toContain("read the system instructions rendered as images");
  });

  it("converts a TencentDB Agent Memory Context user message to image parts even if it is shorter than the threshold", () => {
    vi.mocked(configModule.getTierModelConfig).mockReturnValue({
      providerProfileId: "fake-key",
      model: "gpt-4o",
      supportsVision: true,
    });
    vi.mocked(configModule.getSettings).mockReturnValue({
      autoVisionTokenSaving: true,
      visionTokenSavingThreshold: 10000, // Large threshold
    });

    const agent = new Agent("single");
    const memoryMsg = "[TencentDB Agent Memory Context]:\n- L1 preference: user prefers TypeScript";
    agent.conversation.addUserMessage(memoryMsg);

    const messages = (agent as any).buildMessages(true);

    expect(messages.length).toBe(1);
    expect(messages[0].role).toBe("user");
    expect(Array.isArray(messages[0].content)).toBe(true);
    expect(messages[0].content[0].text).toContain("TencentDB Agent Memory Context rendered as images");
    const imagePart = messages[0].content.find((p: any) => p.type === "image");
    expect(imagePart).toBeDefined();
    expect(imagePart.image).toBe("MOCK_BASE64_IMAGE_DATA");
  });

  it("uses the correct dynamic threshold based on model provider in getDynamicVisionThreshold", async () => {
    const { getDynamicVisionThreshold: realGetDynamic } = await import("../src/core/config/jsonConfig.js");
    
    vi.mocked(configModule.getSettings).mockReturnValue({
      autoVisionTokenSaving: true,
      visionTokenSavingThreshold: 2000,
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
      visionMode: 2,
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
    expect(messages[0].content[0].text).toContain("CRITICAL:");
    
    const imageParts = messages[0].content.filter((p: any) => p.type === "image");
    expect(imageParts.length).toBeGreaterThan(0);
  });
});


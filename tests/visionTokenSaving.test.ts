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
  };
});

// Mock the textToImage module so we don't need real PowerShell/Python dependency in unit test
vi.mock("../src/utils/textToImage.js", () => {
  return {
    sliceTextIntoPages: (text: string, maxLines = 150, maxPages = 3) => {
      return [text]; // Simpler slicing for tests
    },
    renderTextToImageBase64: vi.fn().mockReturnValue("MOCK_BASE64_IMAGE_DATA"),
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
    expect(messages[1].content[1].type).toBe("image");
    expect(messages[1].content[1].image).toBe("MOCK_BASE64_IMAGE_DATA");
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
    expect(messages[2].content[1].type).toBe("image");
    expect(messages[2].content[1].image).toBe("MOCK_BASE64_IMAGE_DATA");
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
    expect(messages[0].content[1].type).toBe("image");
  });
});


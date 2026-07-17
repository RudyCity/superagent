import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "os";
import path from "path";
import fs from "fs";

const tempHome = path.join(process.cwd(), "tests", "temp-home-nudge-skip");
vi.spyOn(os, "homedir").mockReturnValue(tempHome);

import { Agent } from "../src/core/agent.js";
import { generateText } from "ai";
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
      disableStreaming: true, // test with non-streaming to simplify generateText mock
      workingDirectory: process.cwd(),
      systemPrompt: "Base Master Agent Prompt Content",
    }),
    getSettings: vi.fn().mockReturnValue({
      classifierEnabled: false, // disable classifier in config to control manually
      disableStreaming: true,
    }),
  };
});

// Mock ai SDK partially
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();

  // Helper to create a minimal streamText result for the conversation fast-path.
  // The fast-path iterates result.fullStream and then awaits result.usage.
  const makeFakeStreamResult = (text: string) => {
    const fullStream = (async function* () {
      yield { type: "text-delta", textDelta: text };
    })();
    return {
      fullStream,
      usage: Promise.resolve({ promptTokens: 5, completionTokens: 5, totalTokens: 10 }),
    };
  };

  return {
    ...actual,
    generateText: vi.fn(),
    streamText: vi.fn().mockReturnValue(makeFakeStreamResult("Hello! How can I help you?")),
  };
});

describe("Agent - Planning Nudge Skip on Conversation and Question", () => {
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

  it("should skip planning narration nudge when category is conversation", async () => {
    const onEvent = vi.fn();
    const onPermission = vi.fn().mockResolvedValue(true);
    const onQuestion = vi.fn();

    const agent = new Agent(onEvent, onPermission, onQuestion);
    agent.tier = "master";
    agent.planState = "APPROVED"; // Simple task or conversation

    // Explicitly set classification to conversation/high — triggers fast-path.
    // Config has disableStreaming:true so fast-path will use generateText.
    agent.currentClassification = {
      category: "conversation",
      confidence: "high",
      reason: "greetings",
      heuristicOnly: true,
      classificationTokens: 0,
    };

    // Provide mock response for the fast-path generateText call
    vi.mocked(generateText).mockResolvedValue({
      text: "Hello! How can I help you?",
      usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
    } as any);

    await agent.sendMessage("hai");

    // Config has disableStreaming=true → fast-path uses generateText, NOT streamText
    expect(generateText).toHaveBeenCalledTimes(1);
    const { streamText } = await import("ai");
    expect(streamText).not.toHaveBeenCalled();

    // Verify no planning nudge in history
    const messages = agent.getConversationMessages();
    const sysNudgeMsg = messages.find(
      (m) => typeof m.content === "string" && m.content.includes("[SYS] Continue")
    );
    expect(sysNudgeMsg).toBeUndefined();
  });

  it("should skip planning narration nudge when category is question", async () => {
    const onEvent = vi.fn();
    const onPermission = vi.fn().mockResolvedValue(true);
    const onQuestion = vi.fn();

    const agent = new Agent(onEvent, onPermission, onQuestion);
    agent.tier = "master";
    agent.planState = "APPROVED";
    
    // Explicitly set classification to question
    agent.currentClassification = {
      category: "question",
      confidence: "high",
      reason: "Q&A request",
      heuristicOnly: true,
      classificationTokens: 0,
    };

    // Return a short text-only response (normally triggers nudge)
    vi.mocked(generateText).mockResolvedValue({
      text: "Vite is a build tool that aims to provide a faster and leaner development experience.",
      usage: { promptTokens: 10, completionTokens: 10 },
    } as any);

    await agent.sendMessage("what is vite?");

    // generateText should be called exactly once
    expect(generateText).toHaveBeenCalledTimes(1);

    // Verify messages in history does not contain the system nudge
    const messages = agent.getConversationMessages();
    const sysNudgeMsg = messages.find(
      (m) => typeof m.content === "string" && m.content.includes("[SYS] Continue")
    );
    expect(sysNudgeMsg).toBeUndefined();
  });

  it("should still perform planning narration nudge when category is complex_task", async () => {
    const onEvent = vi.fn();
    const onPermission = vi.fn().mockResolvedValue(true);
    const onQuestion = vi.fn();

    const agent = new Agent(onEvent, onPermission, onQuestion);
    agent.tier = "master";
    agent.planState = "APPROVED";
    
    // Explicitly set classification to complex_task
    agent.currentClassification = {
      category: "complex_task",
      confidence: "high",
      reason: "code change",
      heuristicOnly: true,
      classificationTokens: 0,
    };

    // Return a short text-only response first, then a final text response
    vi.mocked(generateText)
      .mockResolvedValueOnce({
        text: "I will modify the application logic now.",
        usage: { promptTokens: 10, completionTokens: 10 },
      } as any)
      .mockResolvedValueOnce({
        text: "Done, code updated. Do you want me to run verification?",
        usage: { promptTokens: 10, completionTokens: 10 },
      } as any);

    await agent.sendMessage("update application");

    // generateText should be called twice because of the nudge
    expect(generateText).toHaveBeenCalledTimes(2);

    // Verify messages in history contains the system nudge
    const messages = agent.getConversationMessages();
    const sysNudgeMsg = messages.find(
      (m) => typeof m.content === "string" && m.content.includes("[SYS] Continue")
    );
    expect(sysNudgeMsg).toBeDefined();
  });
});

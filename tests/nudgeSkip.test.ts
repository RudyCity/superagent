import { describe, it, expect, vi, beforeEach, afterEach, mock } from "vitest";
import os from "os";
import path from "path";
import fs from "fs";

const tempHome = path.join(process.cwd(), "tests", "temp-home-nudge-skip");
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.SUPERAGENT_CONFIG_DIR = tempHome;

import { Agent } from "../src/core/agent.js";
import { generateText } from "ai";
import * as baseConfigModule from "../src/core/config/base.js";
import * as jsonConfigModule from "../src/core/config/jsonConfig.js";

import { closeHistoryDb, clearHistoryCache } from "../src/core/config.js";

describe("Agent - Planning Nudge Skip on Conversation and Question", () => {
  beforeEach(() => {
    console.log("BEFORE EACH START");
    closeHistoryDb();
    clearHistoryCache();
    if (fs.existsSync(tempHome)) {
      try {
        fs.rmSync(tempHome, { recursive: true, force: true });
      } catch {}
    }
    vi.restoreAllMocks();
    vi.clearAllMocks();

    // Mock configuration using vi.spyOn for local modules directly
    vi.spyOn(baseConfigModule, "getConfig").mockReturnValue({
      provider: "openai",
      model: "gpt-4",
      apiKey: "fake-key",
      disableStreaming: true, // test with non-streaming to simplify generateText mock
      workingDirectory: process.cwd(),
      systemPrompt: "Base Master Agent Prompt Content",
    } as any);
    vi.spyOn(jsonConfigModule, "getSettings").mockReturnValue({
      classifierEnabled: false, // disable classifier in config to control manually
      disableStreaming: true,
    } as any);
    console.log("BEFORE EACH END");
  });

  afterEach(() => {
    closeHistoryDb();
    clearHistoryCache();
    if (fs.existsSync(tempHome)) {
      try {
        fs.rmSync(tempHome, { recursive: true, force: true });
      } catch {}
    }
  });

  it("should skip planning narration nudge when category is conversation", async () => {
    const onEvent = vi.fn();
    const onPermission = vi.fn().mockResolvedValue(true);
    const onQuestion = vi.fn();

    const agent = new Agent(onEvent, onPermission, onQuestion);
    agent.tier = "master";
    agent.planState = "APPROVED"; // Simple task or conversation
    agent.disableWorkspaceDiscovery = true;

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
    agent.disableWorkspaceDiscovery = true;
    
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
    agent.disableWorkspaceDiscovery = true;
    
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

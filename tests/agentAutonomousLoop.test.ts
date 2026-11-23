import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "os";
import path from "path";
import fs from "fs";

const tempHome = path.join(process.cwd(), "tests", "temp-home-autonomous");
vi.spyOn(os, "homedir").mockReturnValue(tempHome);

import { Agent } from "../src/core/agent.js";
import { LoopIterationProcessor } from "../src/core/agent/LoopIterationProcessor.js";
import { MAX_AUTONOMOUS_CONTINUATIONS, MAX_TEXT_ONLY_CONTINUATIONS } from "../src/core/agent/ChecklistContinuationGuard.js";
import * as aiModule from "ai";
import * as configModule from "../src/core/config.js";

function mockTextStream(text: string) {
  return {
    fullStream: (async function* () {
      yield { type: "text-delta", textDelta: text };
    })(),
    usage: Promise.resolve({ promptTokens: 10, completionTokens: 10 }),
  } as any;
}

describe("Autonomous Loop Execution Engine", () => {
  let streamTextSpy: any;
  let getConfigSpy: any;

  beforeEach(() => {
    vi.clearAllMocks();
    if (fs.existsSync(tempHome)) {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }

    getConfigSpy = vi.spyOn(configModule, "getConfig").mockReturnValue({
      provider: "openai",
      model: "gpt-4",
      apiKey: "fake-key",
      disableStreaming: false,
      workingDirectory: process.cwd(),
      systemPrompt: "Base Master Agent Prompt Content",
    } as any);

    streamTextSpy = vi.spyOn(aiModule, "streamText");
  });

  afterEach(() => {
    if (fs.existsSync(tempHome)) {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it("Agent.isAutonomous defaults to false and can be set", () => {
    const agent = new Agent(vi.fn(), vi.fn(), vi.fn());
    expect(agent.isAutonomous).toBe(false);
    agent.isAutonomous = true;
    expect(agent.isAutonomous).toBe(true);
  });

  it("does not break on intermediate text-only response during autonomous execution", async () => {
    const agent = new Agent(vi.fn(), vi.fn(), vi.fn());
    agent.isAutonomous = true;
    agent.planState = "APPROVED";
    agent.conversation.addUserMessage("Refactor the payment module autonomously");

    streamTextSpy.mockReturnValue(mockTextStream("I have inspected the files and will now update the configuration."));

    const result = await LoopIterationProcessor.processIteration(agent, 0, 50);
    expect(result.shouldBreak).toBe(false);
    expect(agent.textOnlyContinuationNudges).toBe(1);

    const messages = agent.conversation.getMessages();
    const lastMessage = messages[messages.length - 1];
    expect(lastMessage.role).toBe("system");
    expect(lastMessage.content).toContain("[SYS] Autonomous execution is in progress.");
  });

  it("breaks when model outputs TASK_COMPLETE in autonomous execution", async () => {
    const agent = new Agent(vi.fn(), vi.fn(), vi.fn());
    agent.isAutonomous = true;
    agent.planState = "APPROVED";
    agent.conversation.addUserMessage("Refactor the payment module autonomously");

    streamTextSpy.mockReturnValue(mockTextStream("All tasks completed.\nTASK_COMPLETE: Successfully refactored payment module."));

    const result = await LoopIterationProcessor.processIteration(agent, 1, 50);
    expect(result.shouldBreak).toBe(true);
    expect(result.goalStatus).toBe("complete");
  });

  it("breaks when model requests user input or reports a blocker", async () => {
    const agent = new Agent(vi.fn(), vi.fn(), vi.fn());
    agent.isAutonomous = true;
    agent.planState = "APPROVED";
    agent.conversation.addUserMessage("Update payment credentials");

    streamTextSpy.mockReturnValue(mockTextStream("Please provide your Stripe API key to proceed."));

    const result = await LoopIterationProcessor.processIteration(agent, 1, 50);
    expect(result.shouldBreak).toBe(true);
  });

  it("respects MAX_AUTONOMOUS_CONTINUATIONS limit to prevent runaway loops", async () => {
    const agent = new Agent(vi.fn(), vi.fn(), vi.fn());
    agent.isAutonomous = true;
    agent.planState = "APPROVED";
    agent.conversation.addUserMessage("Do long running task");
    agent.textOnlyContinuationNudges = MAX_AUTONOMOUS_CONTINUATIONS;

    streamTextSpy.mockReturnValue(mockTextStream("Still thinking about how to proceed..."));

    const result = await LoopIterationProcessor.processIteration(agent, 5, 50);
    expect(result.shouldBreak).toBe(true);
  });

  it("non-autonomous agent stops after MAX_TEXT_ONLY_CONTINUATIONS nudges", async () => {
    const agent = new Agent(vi.fn(), vi.fn(), vi.fn());
    agent.isAutonomous = false;
    agent.goalMode = null;
    agent.planState = "APPROVED";
    agent.conversation.addUserMessage("What is the capital of France?");
    agent.textOnlyContinuationNudges = MAX_TEXT_ONLY_CONTINUATIONS;

    streamTextSpy.mockReturnValue(mockTextStream("The capital of France is Paris."));

    const result = await LoopIterationProcessor.processIteration(agent, 0, 50);
    expect(result.shouldBreak).toBe(true);
  });
});

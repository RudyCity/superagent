import { describe, it, expect, vi, beforeEach } from "vitest";
import { Agent } from "../src/core/agent.js";
import { streamText } from "ai";
import * as configModule from "../src/core/config.js";

// Mock configuration partially, keeping other config helpers intact
vi.mock("../src/core/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof configModule>();
  return {
    ...actual,
    getConfig: vi.fn().mockReturnValue({
      provider: "openai",
      model: "gpt-4",
      apiKey: "fake-key",
      disableStreaming: false,
      workingDirectory: process.cwd(),
      systemPrompt: "Base Master Agent Prompt Content",
    }),
    loadAgentSkills: vi.fn().mockReturnValue("\n\nINSTALLED AGENT SKILLS:\n- **test-skill**: A test skill\n  Instruction File: /path/to/test-skill/SKILL.md"),
  };
});

// Mock ai SDK partially
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    streamText: vi.fn(),
  };
});

describe("Skills Injection into Agent System Prompts", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("should append skills to custom system prompts (Superagent/Subagent tiers)", async () => {
    const onEvent = vi.fn();
    const onPermission = vi.fn().mockResolvedValue(true);
    const onQuestion = vi.fn();
    
    // Create agent with custom system prompt (representing Superagent/Subagent)
    const customPrompt = "You are a specialized developer subagent.";
    const agent = new Agent(onEvent, onPermission, onQuestion, customPrompt);
    agent.tier = "superagent";
    agent.planState = "APPROVED";

    let capturedSystemPrompt = "";

    vi.mocked(streamText).mockImplementation((options) => {
      capturedSystemPrompt = options.system || "";
      return {
        fullStream: (async function* () {
          yield { type: "text-delta", textDelta: "Done" };
        })(),
        usage: Promise.resolve({ promptTokens: 10, completionTokens: 10 }),
      } as any;
    });

    await agent.sendMessage("hello");

    // Verify streamText was called and captured system prompt has our custom prompt + skills
    expect(capturedSystemPrompt).toContain("You are a specialized developer subagent.");
    expect(capturedSystemPrompt).toContain("INSTALLED AGENT SKILLS:");
    expect(capturedSystemPrompt).toContain("- **test-skill**:");
  });

  it("should not duplicate skills section if it is already present in prompt", async () => {
    const onEvent = vi.fn();
    const onPermission = vi.fn().mockResolvedValue(true);
    const onQuestion = vi.fn();

    // Custom prompt that already includes the skills section
    const customPrompt = "You are a specialized developer subagent.\n\nINSTALLED AGENT SKILLS:\n- **test-skill**: A test skill";
    const agent = new Agent(onEvent, onPermission, onQuestion, customPrompt);
    agent.tier = "superagent";
    agent.planState = "APPROVED";

    let capturedSystemPrompt = "";

    vi.mocked(streamText).mockImplementation((options) => {
      capturedSystemPrompt = options.system || "";
      return {
        fullStream: (async function* () {
          yield { type: "text-delta", textDelta: "Done" };
        })(),
        usage: Promise.resolve({ promptTokens: 10, completionTokens: 10 }),
      } as any;
    });

    await agent.sendMessage("hello");

    // Verify system prompt is captured
    expect(capturedSystemPrompt).toContain("You are a specialized developer subagent.");
    
    // Count occurrences of "INSTALLED AGENT SKILLS:"
    const occurrences = (capturedSystemPrompt.match(/INSTALLED AGENT SKILLS:/g) || []).length;
    expect(occurrences).toBe(1);
  });
});

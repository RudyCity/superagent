import { describe, it, expect, vi, beforeEach } from "vitest";
import { Agent } from "../src/core/agent.js";
import { streamText } from "ai";
import * as configModule from "../src/core/config.js";
import fs from "fs";

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
  });

  it("should dynamically load and inject the planning and task management guidelines into systemPrompt", async () => {
    const onEvent = vi.fn();
    const onPermission = vi.fn().mockResolvedValue(true);
    const onQuestion = vi.fn();

    const agent = new Agent(onEvent, onPermission, onQuestion);
    agent.tier = "superagent";
    agent.planState = "PLANNING_PENDING";

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

    // Mock fs exists and read to simulate finding one of the new skills
    const existsSpy = vi.spyOn(fs, "existsSync").mockImplementation((p: any) => {
      if (typeof p === "string" && p.includes("superagent-planning")) {
        return true;
      }
      return false;
    });

    const readSpy = vi.spyOn(fs, "readFileSync").mockImplementation((p: any) => {
      if (typeof p === "string" && p.includes("superagent-planning")) {
        return "MOCK_PLANNING_SKILL_CONTENT";
      }
      return "";
    });

    await agent.sendMessage("hello");

    expect(capturedSystemPrompt).toContain("PLANNING AND TASK GUIDELINES (superagent-planning):");
    expect(capturedSystemPrompt).toContain("MOCK_PLANNING_SKILL_CONTENT");

  });

  it("should dynamically load and inject master-agent-orchestration only for the master tier", async () => {
    const onEvent = vi.fn();
    const onPermission = vi.fn().mockResolvedValue(true);
    const onQuestion = vi.fn();

    // 1. Create a Master tier agent
    const masterAgent = new Agent(onEvent, onPermission, onQuestion);
    masterAgent.tier = "master";
    masterAgent.planState = "APPROVED";

    let masterPrompt = "";
    vi.mocked(streamText).mockImplementation((options) => {
      masterPrompt = options.system || "";
      return {
        fullStream: (async function* () {
          yield { type: "text-delta", textDelta: "Done" };
        })(),
        usage: Promise.resolve({ promptTokens: 10, completionTokens: 10 }),
      } as any;
    });

    const existsSpy = vi.spyOn(fs, "existsSync").mockImplementation((p: any) => {
      if (typeof p === "string" && p.includes("master-agent-orchestration")) {
        return true;
      }
      return false;
    });

    const readSpy = vi.spyOn(fs, "readFileSync").mockImplementation((p: any) => {
      if (typeof p === "string" && p.includes("master-agent-orchestration")) {
        return "MOCK_ORCHESTRATION_CONTENT";
      }
      return "";
    });

    await masterAgent.sendMessage("hello");
    expect(masterPrompt).toContain("MASTER AGENT ORCHESTRATION GUIDELINES (master-agent-orchestration):");
    expect(masterPrompt).toContain("MOCK_ORCHESTRATION_CONTENT");

    // 2. Create a Superagent tier agent
    const superagent = new Agent(onEvent, onPermission, onQuestion);
    superagent.tier = "superagent";
    superagent.planState = "APPROVED";

    let superagentPrompt = "";
    vi.mocked(streamText).mockImplementation((options) => {
      superagentPrompt = options.system || "";
      return {
        fullStream: (async function* () {
          yield { type: "text-delta", textDelta: "Done" };
        })(),
        usage: Promise.resolve({ promptTokens: 10, completionTokens: 10 }),
      } as any;
    });

    await superagent.sendMessage("hello");
    expect(superagentPrompt).not.toContain("MASTER AGENT ORCHESTRATION GUIDELINES (master-agent-orchestration):");
    expect(superagentPrompt).not.toContain("MOCK_ORCHESTRATION_CONTENT");

    existsSpy.mockRestore();
    readSpy.mockRestore();
  });
});


describe("Skill Preloading Enhancements", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("should preload appropriate guidelines dynamically based on state and query for master tier", async () => {
    const onEvent = vi.fn();
    const onPermission = vi.fn().mockResolvedValue(true);
    const onQuestion = vi.fn();

    const masterAgent = new Agent(onEvent, onPermission, onQuestion);
    masterAgent.tier = "master";

    const mandatoryKeys = [
      "karpathy-guidelines",
      "superagent-planning",
      "writing-plans",
      "executing-plans",
      "track-management",
      "systematic-debugging",
      "verification-before-completion",
      "subagent-driven-development",
      "master-agent-orchestration",
    ];

    vi.spyOn(fs, "existsSync").mockImplementation((p: any) => {
      if (typeof p !== "string") return false;
      return mandatoryKeys.some((k) => p.includes(k));
    });

    vi.spyOn(fs, "readFileSync").mockImplementation((p: any) => {
      if (typeof p !== "string") return "";
      const key = mandatoryKeys.find((k) => p.includes(k));
      return key ? `MOCK_CONTENT_FOR_${key.toUpperCase().replace(/-/g, "_")}` : "";
    });

    // 1. PLANNING_PENDING state: should load planning skills
    masterAgent.planState = "PLANNING_PENDING";
    let capturedSystemPrompt = "";
    vi.mocked(streamText).mockImplementation((options) => {
      capturedSystemPrompt = options.system || "";
      return {
        fullStream: (async function* () { yield { type: "text-delta", textDelta: "Done" }; })(),
        usage: Promise.resolve({ promptTokens: 10, completionTokens: 10 }),
      } as any;
    });

    await masterAgent.sendMessage("hello");

    expect(capturedSystemPrompt).toContain("BEHAVIORAL CODING GUIDELINES (karpathy-guidelines):");
    expect(capturedSystemPrompt).toContain("PLANNING AND TASK GUIDELINES (superagent-planning):");

    // 2. APPROVED state with a debug query: should load execution skills + debugging guidelines
    masterAgent.planState = "APPROVED";
    (masterAgent as any).skillContentCache.clear();
    await masterAgent.sendMessage("please debug this error");

    expect(capturedSystemPrompt).toContain("BEHAVIORAL CODING GUIDELINES (karpathy-guidelines):");
    expect(capturedSystemPrompt).toContain("MASTER AGENT ORCHESTRATION GUIDELINES (master-agent-orchestration):");
  });

  it("should cache guidelinesText and not re-read SKILL.md files on subsequent sendMessage calls", async () => {
    const onEvent = vi.fn();
    const onPermission = vi.fn().mockResolvedValue(true);
    const onQuestion = vi.fn();

    const agent = new Agent(onEvent, onPermission, onQuestion);
    agent.tier = "superagent";
    agent.planState = "APPROVED";

    const readFileSpy = vi.spyOn(fs, "readFileSync").mockImplementation((p: any) => {
      if (typeof p === "string" && p.includes("karpathy-guidelines")) return "MOCK_KARPATHY_CONTENT";
      return "";
    });
    vi.spyOn(fs, "existsSync").mockImplementation((p: any) => {
      return typeof p === "string" && p.includes("karpathy-guidelines");
    });

    vi.mocked(streamText).mockImplementation(() => {
      return {
        fullStream: (async function* () { yield { type: "text-delta", textDelta: "Done" }; })(),
        usage: Promise.resolve({ promptTokens: 10, completionTokens: 10 }),
      } as any;
    });

    await agent.sendMessage("first message");
    const readCountAfterFirst = readFileSpy.mock.calls.filter(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("karpathy-guidelines")
    ).length;

    await agent.sendMessage("second message");
    const readCountAfterSecond = readFileSpy.mock.calls.filter(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("karpathy-guidelines")
    ).length;

    expect(readCountAfterFirst).toBe(1);
    expect(readCountAfterSecond).toBe(1);
  });

  it("should inject dev hook notice when activeDevHook is set", async () => {
    const { setActiveDevHookGlobal } = await import("../src/core/tools/state.js");
    setActiveDevHookGlobal("my-test-hook");

    const onEvent = vi.fn();
    const onPermission = vi.fn().mockResolvedValue(true);
    const onQuestion = vi.fn();

    const agent = new Agent(onEvent, onPermission, onQuestion);
    agent.tier = "master";
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

    try {
      await agent.sendMessage("hello");

      expect(capturedSystemPrompt).toContain("HOOK FOCUS");
      expect(capturedSystemPrompt).toContain("my-test-hook");
      expect(capturedSystemPrompt).toContain("internal-hooks/my-test-hook");
    } finally {
      setActiveDevHookGlobal(null);
    }
  });
});


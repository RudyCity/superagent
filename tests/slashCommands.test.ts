import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { handleSlashCommand, type ChatLine } from "../src/core/slash-commands.js";
import { Agent } from "../src/core/agent.js";
import * as configModule from "../src/core/config.js";

vi.mock("../src/core/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof configModule>();
  return {
    ...actual,
    getInstalledSkills: () => [
      {
        name: "Test Skill",
        description: "A test skill description",
        path: "/path/to/test-skill/SKILL.md",
      }
    ],
  };
});

describe("Slash Command: /model", () => {
  let originalEnv: NodeJS.ProcessEnv;
  let addedLines: ChatLine[] = [];
  let currentContextLimit = 0;

  let activeWizard: any = null;
  let wizardOptions: string[] = [];
  let wizardSelectedIndex = 0;

  const mockCtx = {
    addLine: (line: ChatLine) => {
      addedLines.push(line);
    },
    exit: () => {},
    agent: null as Agent | null,
    setContextLimit: (limit: number) => {
      currentContextLimit = limit;
    },
    setActiveWizard: (w: any) => {
      activeWizard = w;
    },
    setWizardOptions: (opts: string[]) => {
      wizardOptions = opts;
    },
    setWizardSelectedIndex: (idx: number) => {
      wizardSelectedIndex = idx;
    },
  };

  beforeEach(() => {
    originalEnv = { ...process.env };
    addedLines = [];
    currentContextLimit = 0;
    activeWizard = null;
    wizardOptions = [];
    wizardSelectedIndex = 0;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should show current configurations when run without arguments", () => {
    process.env.MODEL = "openai:gpt-4o";
    process.env.MODEL_DEPTH_0 = "openai:gpt-4o-mini";
    process.env.MODEL_DEPTH_1 = "anthropic:claude-3-5-sonnet";
    process.env.MODEL_DEPTH_2 = "custom:local-llama";
    process.env.MODEL_SUBAGENT_RESEARCHER = "openai:gpt-researcher";

    handleSlashCommand("/model", mockCtx);

    expect(addedLines.length).toBe(1);
    const content = addedLines[0].content;
    expect(content).toContain("Default Model: openai:gpt-4o");
    expect(content).toContain("Master Agent (depth 0): openai:gpt-4o-mini");
    expect(content).toContain("Superagent (depth 1): anthropic:claude-3-5-sonnet");
    expect(content).toContain("Subagent (depth 2): custom:local-llama");
    expect(content).toContain('Subagent "researcher": openai:gpt-researcher');

    expect(activeWizard).toEqual({
      type: "model",
      step: 1,
      data: {},
    });
    expect(wizardOptions).toContain("1. Load/Apply Model Preset");
    expect(wizardOptions).toContain("2. List Model Presets");
    expect(wizardOptions).toContain("3. Create Model Preset");
    expect(wizardOptions).toContain("4. Edit Model Preset");
    expect(wizardOptions).toContain("5. Delete Model Preset");
    expect(wizardOptions).toContain("6. Configure Agent Tier Models");
  });

  it("should update standard MODEL when no tier prefix is supplied", () => {
    handleSlashCommand("/model anthropic:claude-3-5-haiku", mockCtx);

    expect(process.env.MODEL).toBe("anthropic:claude-3-5-haiku");
    expect(addedLines.length).toBe(1);
    expect(addedLines[0].content).toContain("All Tiers (Overwrite All) changed to: anthropic:claude-3-5-haiku");
  });

  it("should update MODEL_DEPTH_0 when master/depth0/dept0 prefix is supplied", () => {
    handleSlashCommand("/model master openai:gpt-4", mockCtx);
    expect(process.env.MODEL_DEPTH_0).toBe("openai:gpt-4");
    expect(process.env.MODEL_DEPT0).toBe("openai:gpt-4");

    handleSlashCommand("/model dept0 anthropic:claude-3", mockCtx);
    expect(process.env.MODEL_DEPTH_0).toBe("anthropic:claude-3");
    expect(process.env.MODEL_DEPT0).toBe("anthropic:claude-3");
  });

  it("should update MODEL_DEPTH_1 when superagent prefix is supplied", () => {
    handleSlashCommand("/model superagent openai:gpt-4", mockCtx);
    expect(process.env.MODEL_DEPTH_1).toBe("openai:gpt-4");
    expect(process.env.MODEL_DEPT1).toBe("openai:gpt-4");
  });

  it("should update MODEL_DEPTH_2 when subagent prefix is supplied", () => {
    handleSlashCommand("/model subagent openai:gpt-4", mockCtx);
    expect(process.env.MODEL_DEPTH_2).toBe("openai:gpt-4");
    expect(process.env.MODEL_DEPT2).toBe("openai:gpt-4");
  });

  it("should update specific subagent model when subagent type is supplied", () => {
    handleSlashCommand("/model researcher openai:gpt-researcher", mockCtx);
    expect(process.env.MODEL_SUBAGENT_RESEARCHER).toBe("openai:gpt-researcher");
    expect(process.env.MODEL_RESEARCHER).toBe("openai:gpt-researcher");
  });
});

describe("Slash Command: /skills and /skill", () => {
  let addedLines: ChatLine[] = [];
  let activeWizard: any = null;
  let wizardOptions: string[] = [];
  let wizardSelectedIndex = -1;

  const mockCtx = {
    addLine: (line: ChatLine) => {
      addedLines.push(line);
    },
    exit: () => {},
    agent: null as Agent | null,
    setActiveWizard: (val: any) => {
      activeWizard = val;
    },
    setWizardOptions: (options: string[]) => {
      wizardOptions = options;
    },
    setWizardSelectedIndex: (index: number) => {
      wizardSelectedIndex = index;
    },
  };

  beforeEach(() => {
    addedLines = [];
    activeWizard = null;
    wizardOptions = [];
    wizardSelectedIndex = -1;
  });

  it("should open wizard on /skills (plural)", () => {
    handleSlashCommand("/skills", mockCtx);

    expect(activeWizard).not.toBeNull();
    expect(activeWizard.type).toBe("skills");
    expect(activeWizard.step).toBe(1);
    expect(wizardOptions.length).toBe(1);
    expect(wizardOptions[0]).toContain("Test Skill");
  });

  it("should open wizard on /skill (singular without args)", () => {
    handleSlashCommand("/skill", mockCtx);

    expect(activeWizard).not.toBeNull();
    expect(activeWizard.type).toBe("skills");
    expect(activeWizard.step).toBe(1);
    expect(wizardOptions.length).toBe(1);
  });

  it("should activate direct skill on /skill <slug> (space separated)", () => {
    const mockSendMessage = vi.fn().mockResolvedValue({});
    const mockAgent = {
      sendMessage: mockSendMessage,
    } as any;

    const ctxWithAgent = {
      ...mockCtx,
      agent: mockAgent,
    };

    handleSlashCommand("/skill test-skill", ctxWithAgent);

    expect(addedLines.length).toBe(2);
    expect(addedLines[0].content).toBe("❯ /skill test-skill");
    expect(addedLines[1].content).toContain("Activating skill \"Test Skill\"");
    expect(mockSendMessage).toHaveBeenCalled();
    expect(mockSendMessage.mock.calls[0][0]).toContain("I would like you to use the following skill: \"Test Skill\"");
  });

  it("should activate direct skill on /skill-<slug> (hyphenated)", () => {
    const mockSendMessage = vi.fn().mockResolvedValue({});
    const mockAgent = {
      sendMessage: mockSendMessage,
    } as any;

    const ctxWithAgent = {
      ...mockCtx,
      agent: mockAgent,
    };

    handleSlashCommand("/skill-test-skill", ctxWithAgent);

    expect(addedLines.length).toBe(2);
    expect(addedLines[0].content).toBe("❯ /skill-test-skill");
    expect(addedLines[1].content).toContain("Activating skill \"Test Skill\"");
    expect(mockSendMessage).toHaveBeenCalled();
  });

  it("should report error if direct skill not found", () => {
    handleSlashCommand("/skill non-existent-skill", mockCtx);

    expect(addedLines.length).toBe(1);
    expect(addedLines[0].type).toBe("error");
    expect(addedLines[0].content).toContain("Skill \"non-existent-skill\" not found");
  });
});

describe("Slash Commands: /settings & /setting-*", () => {
  let originalEnv: NodeJS.ProcessEnv;
  let addedLines: ChatLine[] = [];

  const mockCtx = {
    addLine: (line: ChatLine) => {
      addedLines.push(line);
    },
    exit: () => {},
    agent: null,
  };

  beforeEach(() => {
    originalEnv = { ...process.env };
    addedLines = [];
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should show settings when running /settings", () => {
    process.env.SUPERAGENT_MAX_CONCURRENCY = "1";
    process.env.SUPERAGENT_RATE_LIMIT_RPM = "30";
    process.env.SUPERAGENT_RATE_LIMIT_CAPACITY = "5";

    handleSlashCommand("/settings", mockCtx as any);

    expect(addedLines.length).toBe(1);
    const content = addedLines[0].content;
    expect(content).toContain("Concurrency Limit : 1 (enabled)");
    expect(content).toContain("Rate Limit (RPM)  : 30 RPM");
    expect(content).toContain("Limit Capacity    : 5");
  });

  it("should configure concurrency limit when running /setting-concurrency", () => {
    // Show usage when empty
    handleSlashCommand("/setting-concurrency", mockCtx as any);
    expect(addedLines[addedLines.length - 1].content).toContain("Usage: /setting-concurrency");

    // Invalid value
    handleSlashCommand("/setting-concurrency invalid", mockCtx as any);
    expect(addedLines[addedLines.length - 1].type).toBe("error");

    // Valid value
    handleSlashCommand("/setting-concurrency 1", mockCtx as any);
    expect(process.env.SUPERAGENT_MAX_CONCURRENCY).toBe("1");
    expect(addedLines[addedLines.length - 1].content).toContain("Concurrency limit set to: 1");

    handleSlashCommand("/setting-concurrency 0", mockCtx as any);
    expect(process.env.SUPERAGENT_MAX_CONCURRENCY).toBe("0");
    expect(addedLines[addedLines.length - 1].content).toContain("Concurrency limit set to: 0");
  });

  it("should configure rate limit when running /setting-rpm", () => {
    // Show usage when empty
    handleSlashCommand("/setting-rpm", mockCtx as any);
    expect(addedLines[addedLines.length - 1].content).toContain("Usage: /setting-rpm");

    // Invalid value
    handleSlashCommand("/setting-rpm invalid", mockCtx as any);
    expect(addedLines[addedLines.length - 1].type).toBe("error");

    // Valid value
    handleSlashCommand("/setting-rpm 45", mockCtx as any);
    expect(process.env.SUPERAGENT_RATE_LIMIT_RPM).toBe("45");
    expect(addedLines[addedLines.length - 1].content).toContain("Rate limit set to: 45 RPM");
  });

  it("should configure rate limit capacity when running /setting-capacity", () => {
    // Show usage when empty
    handleSlashCommand("/setting-capacity", mockCtx as any);
    expect(addedLines[addedLines.length - 1].content).toContain("Usage: /setting-capacity");

    // Invalid value
    handleSlashCommand("/setting-capacity invalid", mockCtx as any);
    expect(addedLines[addedLines.length - 1].type).toBe("error");

    // Valid value
    handleSlashCommand("/setting-capacity 15", mockCtx as any);
    expect(process.env.SUPERAGENT_RATE_LIMIT_CAPACITY).toBe("15");
    expect(addedLines[addedLines.length - 1].content).toContain("Rate limit capacity set to: 15");
  });
});


import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

// Mock os.homedir() di paling atas untuk isolasi penuh
const tempHome = path.join(process.cwd(), "tests", "temp-home-slash-commands");
vi.spyOn(os, "homedir").mockReturnValue(tempHome);

import { handleSlashCommand, type ChatLine } from "../src/core/slash-commands.js";
import { Agent } from "../src/core/agent.js";
import * as configModule from "../src/core/config.js";
import { getModelConfigPath, ensureGlobalConfigDir } from "../src/core/config/paths.js";
import { clearModelConfigCache } from "../src/core/config/jsonConfig.js";
import { execa } from "execa";

const configPath = getModelConfigPath();

vi.mock("execa", () => ({
  execa: vi.fn().mockResolvedValue({ stdout: "" }),
}));

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

    // Bersihkan folder temp
    if (fs.existsSync(tempHome)) {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
    ensureGlobalConfigDir();
    clearModelConfigCache();
  });

  afterEach(() => {
    process.env = originalEnv;
    // Bersihkan folder temp
    if (fs.existsSync(tempHome)) {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
    clearModelConfigCache();
  });

  it("should show current configurations when run without arguments", () => {
    mockCtx.agent = { isMultiAgent: true } as any;

    // Write test config with models
    const testConfig = {
      settings: { concurrencyLimit: 0, rateLimitRpm: 60, rateLimitCapacity: 60 },
      providers: [
        { id: "openai", name: "OpenAI", provider: "openai", apiKey: "sk-test", baseUrl: "" },
        { id: "anthropic", name: "Anthropic", provider: "anthropic", apiKey: "sk-ant-test", baseUrl: "" },
        { id: "custom", name: "Custom", provider: "custom", apiKey: "custom-key", baseUrl: "http://localhost:8080/v1" }
      ],
      presets: {
        multi: [{
          id: "test-multi",
          name: "Test Multi",
          description: "Test",
          models: {
            master: { providerProfileId: "openai", model: "gpt-4o-mini" },
            superagent: { providerProfileId: "anthropic", model: "claude-3-5-sonnet" },
            subagentDefault: { providerProfileId: "custom", model: "local-llama" },
            subagentDetails: {
              researcher: { providerProfileId: "openai", model: "gpt-researcher" }
            }
          }
        }],
        single: []
      },
      activePresetId: { multi: "test-multi", single: "" }
    };
    fs.writeFileSync(configPath, JSON.stringify(testConfig, null, 2), "utf-8");
    clearModelConfigCache();

    handleSlashCommand("/model", mockCtx);

    expect(addedLines.length).toBe(1);
    const content = addedLines[0].content;
    expect(content).toContain("Master Agent (depth 0): openai@gpt-4o-mini");
    expect(content).toContain("Superagent (depth 1): anthropic@claude-3-5-sonnet");
    expect(content).toContain("Subagent (depth 2): custom@local-llama");
    expect(content).toContain('Subagent "researcher": openai@gpt-researcher');

    expect(activeWizard).toEqual({
      type: "model",
      step: 1,
      data: {},
    });
    expect(wizardOptions).toContain("1. Load/Apply Model Preset [Multi-Agent]");
    expect(wizardOptions).toContain("2. List Model Presets [Multi-Agent]");
    expect(wizardOptions).toContain("3. Create Model Preset [Multi-Agent]");
    expect(wizardOptions).toContain("4. Edit Model Preset [Multi-Agent]");
    expect(wizardOptions).toContain("5. Delete Model Preset [Multi-Agent]");
    expect(wizardOptions).toContain("< Back");
  });

  it("should update model config when no tier prefix is supplied in multi-agent mode", () => {
    mockCtx.agent = { isMultiAgent: true } as any;

    // Write test config
    const testConfig = {
      settings: { concurrencyLimit: 0, rateLimitRpm: 60, rateLimitCapacity: 60 },
      providers: [
        { id: "anthropic", name: "Anthropic", provider: "anthropic", apiKey: "sk-ant-test", baseUrl: "" }
      ],
      presets: {
        multi: [{
          id: "test-multi",
          name: "Test Multi",
          description: "Test",
          models: {
            master: { providerProfileId: "anthropic", model: "claude-3-5-sonnet" },
            superagent: { providerProfileId: "anthropic", model: "claude-3-5-sonnet" },
            subagentDefault: { providerProfileId: "anthropic", model: "claude-3-5-sonnet" },
            subagentDetails: {}
          }
        }],
        single: []
      },
      activePresetId: { multi: "test-multi", single: "" }
    };
    fs.writeFileSync(configPath, JSON.stringify(testConfig, null, 2), "utf-8");
    clearModelConfigCache();

    handleSlashCommand("/model anthropic:claude-3-5-haiku", mockCtx);

    expect(addedLines.length).toBe(1);
    expect(addedLines[0].content).toContain("All Tiers (Overwrite All) changed to: anthropic:claude-3-5-haiku");
  });

  it("should update model config when no tier prefix is supplied in single-agent mode", () => {
    mockCtx.agent = { isMultiAgent: false } as any;

    // Write test config
    const testConfig = {
      settings: { concurrencyLimit: 0, rateLimitRpm: 60, rateLimitCapacity: 60 },
      providers: [
        { id: "anthropic", name: "Anthropic", provider: "anthropic", apiKey: "sk-ant-test", baseUrl: "" }
      ],
      presets: {
        multi: [],
        single: [{
          id: "test-single",
          name: "Test Single",
          description: "Test",
          models: {
            superagent: { providerProfileId: "anthropic", model: "claude-3-5-sonnet" },
            subagentDefault: { providerProfileId: "anthropic", model: "claude-3-5-sonnet" },
            subagentDetails: {}
          }
        }]
      },
      activePresetId: { multi: "", single: "test-single" }
    };
    fs.writeFileSync(configPath, JSON.stringify(testConfig, null, 2), "utf-8");
    clearModelConfigCache();

    handleSlashCommand("/model anthropic:claude-3-5-haiku", mockCtx);

    expect(addedLines.length).toBe(1);
    expect(addedLines[0].content).toContain("Single Agent Model changed to: anthropic:claude-3-5-haiku");
  });

  it("should update master model when master/depth0/dept0 prefix is supplied", () => {
    mockCtx.agent = { isMultiAgent: true } as any;

    // Write test config
    const testConfig = {
      settings: { concurrencyLimit: 0, rateLimitRpm: 60, rateLimitCapacity: 60 },
      providers: [
        { id: "openai", name: "OpenAI", provider: "openai", apiKey: "sk-test", baseUrl: "" },
        { id: "anthropic", name: "Anthropic", provider: "anthropic", apiKey: "sk-ant-test", baseUrl: "" }
      ],
      presets: {
        multi: [{
          id: "test-multi",
          name: "Test Multi",
          description: "Test",
          models: {
            master: { providerProfileId: "openai", model: "gpt-4o" },
            superagent: { providerProfileId: "openai", model: "gpt-4o" },
            subagentDefault: { providerProfileId: "openai", model: "gpt-4o" },
            subagentDetails: {}
          }
        }],
        single: []
      },
      activePresetId: { multi: "test-multi", single: "" }
    };
    fs.writeFileSync(configPath, JSON.stringify(testConfig, null, 2), "utf-8");
    clearModelConfigCache();

    handleSlashCommand("/model master openai:gpt-4", mockCtx);
    expect(addedLines[0].content).toContain("Master Agent (depth 0) Model changed to: openai:gpt-4");

    // Reset for next command
    addedLines = [];
    fs.writeFileSync(configPath, JSON.stringify(testConfig, null, 2), "utf-8");
    clearModelConfigCache();

    handleSlashCommand("/model dept0 anthropic:claude-3", mockCtx);
    expect(addedLines[0].content).toContain("Master Agent (depth 0) Model changed to: anthropic:claude-3");
  });

  it("should update superagent model when superagent prefix is supplied", () => {
    mockCtx.agent = { isMultiAgent: true } as any;

    // Write test config
    const testConfig = {
      settings: { concurrencyLimit: 0, rateLimitRpm: 60, rateLimitCapacity: 60 },
      providers: [
        { id: "openai", name: "OpenAI", provider: "openai", apiKey: "sk-test", baseUrl: "" }
      ],
      presets: {
        multi: [{
          id: "test-multi",
          name: "Test Multi",
          description: "Test",
          models: {
            master: { providerProfileId: "openai", model: "gpt-4o" },
            superagent: { providerProfileId: "openai", model: "gpt-4o" },
            subagentDefault: { providerProfileId: "openai", model: "gpt-4o" },
            subagentDetails: {}
          }
        }],
        single: []
      },
      activePresetId: { multi: "test-multi", single: "" }
    };
    fs.writeFileSync(configPath, JSON.stringify(testConfig, null, 2), "utf-8");
    clearModelConfigCache();

    handleSlashCommand("/model superagent openai:gpt-4", mockCtx);
    expect(addedLines[0].content).toContain("Superagent (depth 1) Model changed to: openai:gpt-4");
  });

  it("should update subagent model when subagent prefix is supplied in multi-agent mode", () => {
    mockCtx.agent = { isMultiAgent: true } as any;

    // Write test config
    const testConfig = {
      settings: { concurrencyLimit: 0, rateLimitRpm: 60, rateLimitCapacity: 60 },
      providers: [
        { id: "openai", name: "OpenAI", provider: "openai", apiKey: "sk-test", baseUrl: "" }
      ],
      presets: {
        multi: [{
          id: "test-multi",
          name: "Test Multi",
          description: "Test",
          models: {
            master: { providerProfileId: "openai", model: "gpt-4o" },
            superagent: { providerProfileId: "openai", model: "gpt-4o" },
            subagentDefault: { providerProfileId: "openai", model: "gpt-4o" },
            subagentDetails: {}
          }
        }],
        single: []
      },
      activePresetId: { multi: "test-multi", single: "" }
    };
    fs.writeFileSync(configPath, JSON.stringify(testConfig, null, 2), "utf-8");
    clearModelConfigCache();

    handleSlashCommand("/model subagent openai:gpt-4", mockCtx);
    expect(addedLines[0].content).toContain("Subagent (depth 2) Model changed to: openai:gpt-4");
  });

  it("should update subagent model when subagent prefix is supplied in single-agent mode", () => {
    mockCtx.agent = { isMultiAgent: false } as any;

    // Write test config
    const testConfig = {
      settings: { concurrencyLimit: 0, rateLimitRpm: 60, rateLimitCapacity: 60 },
      providers: [
        { id: "openai", name: "OpenAI", provider: "openai", apiKey: "sk-test", baseUrl: "" }
      ],
      presets: {
        multi: [],
        single: [{
          id: "test-single",
          name: "Test Single",
          description: "Test",
          models: {
            superagent: { providerProfileId: "openai", model: "gpt-4o" },
            subagentDefault: { providerProfileId: "openai", model: "gpt-4o" },
            subagentDetails: {}
          }
        }]
      },
      activePresetId: { multi: "", single: "test-single" }
    };
    fs.writeFileSync(configPath, JSON.stringify(testConfig, null, 2), "utf-8");
    clearModelConfigCache();

    handleSlashCommand("/model subagent openai:gpt-4", mockCtx);
    expect(addedLines[0].content).toContain("Subagent (depth 2) Model changed to: openai:gpt-4");
  });

  it("should update specific subagent model when subagent type is supplied in multi-agent mode", () => {
    mockCtx.agent = { isMultiAgent: true } as any;

    // Write test config
    const testConfig = {
      settings: { concurrencyLimit: 0, rateLimitRpm: 60, rateLimitCapacity: 60 },
      providers: [
        { id: "openai", name: "OpenAI", provider: "openai", apiKey: "sk-test", baseUrl: "" }
      ],
      presets: {
        multi: [{
          id: "test-multi",
          name: "Test Multi",
          description: "Test",
          models: {
            master: { providerProfileId: "openai", model: "gpt-4o" },
            superagent: { providerProfileId: "openai", model: "gpt-4o" },
            subagentDefault: { providerProfileId: "openai", model: "gpt-4o" },
            subagentDetails: {}
          }
        }],
        single: []
      },
      activePresetId: { multi: "test-multi", single: "" }
    };
    fs.writeFileSync(configPath, JSON.stringify(testConfig, null, 2), "utf-8");
    clearModelConfigCache();

    handleSlashCommand("/model researcher openai:gpt-researcher", mockCtx);
    expect(addedLines[0].content).toContain('Subagent "researcher" Model changed to: openai:gpt-researcher');
  });

  it("should update specific single subagent model when subagent type is supplied in single-agent mode", () => {
    mockCtx.agent = { isMultiAgent: false } as any;

    // Write test config
    const testConfig = {
      settings: { concurrencyLimit: 0, rateLimitRpm: 60, rateLimitCapacity: 60 },
      providers: [
        { id: "openai", name: "OpenAI", provider: "openai", apiKey: "sk-test", baseUrl: "" }
      ],
      presets: {
        multi: [],
        single: [{
          id: "test-single",
          name: "Test Single",
          description: "Test",
          models: {
            superagent: { providerProfileId: "openai", model: "gpt-4o" },
            subagentDefault: { providerProfileId: "openai", model: "gpt-4o" },
            subagentDetails: {}
          }
        }]
      },
      activePresetId: { multi: "", single: "test-single" }
    };
    fs.writeFileSync(configPath, JSON.stringify(testConfig, null, 2), "utf-8");
    clearModelConfigCache();

    handleSlashCommand("/model researcher openai:gpt-researcher", mockCtx);
    expect(addedLines[0].content).toContain('Subagent "researcher" Model changed to: openai:gpt-researcher');
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
    configModule.updateSettings({ concurrencyLimit: 1, rateLimitRpm: 30, rateLimitCapacity: 5 });

    handleSlashCommand("/settings", mockCtx as any);

    expect(addedLines.length).toBe(1);
    const content = addedLines[0].content;
    expect(content).toContain("Concurrency Limit  : 1 (enabled)");
    expect(content).toContain("Rate Limit (RPM)   : 30 RPM");
    expect(content).toContain("Limit Capacity     : 5");
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

describe("Slash Command: /worktree", () => {
  let addedLines: ChatLine[] = [];
  const mockCtx = {
    addLine: (line: ChatLine) => {
      addedLines.push(line);
    },
    exit: () => {},
    agent: null,
    setIsProcessing: () => {},
  };

  beforeEach(() => {
    addedLines = [];
    vi.mocked(execa).mockReset();
    vi.mocked(execa).mockResolvedValue({ stdout: "" } as any);
  });

  it("should execute list action by default", async () => {
    vi.mocked(execa).mockResolvedValueOnce({ stdout: "/path/to/wt feat/branch" } as any);
    await handleSlashCommand("/worktree", mockCtx as any);
    expect(execa).toHaveBeenCalledWith("git", ["worktree", "list"]);
    expect(addedLines[addedLines.length - 2].content).toContain("Retrieving git worktrees...");
    expect(addedLines[addedLines.length - 1].content).toContain("feat/branch");
  });

  it("should execute prune action", async () => {
    await handleSlashCommand("/worktree prune", mockCtx as any);
    expect(execa).toHaveBeenCalledWith("git", ["worktree", "prune"]);
    expect(addedLines[addedLines.length - 1].content).toContain("Stale git worktrees pruned");
  });

  it("should execute remove action", async () => {
    await handleSlashCommand("/worktree remove my-wt-path", mockCtx as any);
    expect(execa).toHaveBeenCalledWith("git", ["worktree", "remove", "my-wt-path"]);
    expect(execa).toHaveBeenCalledWith("git", ["worktree", "prune"]);
    expect(addedLines[addedLines.length - 1].content).toContain("removed successfully");
  });

  it("should execute remove action with force flag", async () => {
    await handleSlashCommand("/worktree remove my-wt-path --force", mockCtx as any);
    expect(execa).toHaveBeenCalledWith("git", ["worktree", "remove", "--force", "my-wt-path"]);
    expect(addedLines[addedLines.length - 1].content).toContain("removed successfully");
  });
});

describe("Slash Command: /login", () => {
  let addedLines: ChatLine[] = [];
  let activeWizard: any = null;
  let wizardOptions: string[] = [];

  const mockCtx = {
    addLine: (line: ChatLine) => {
      addedLines.push(line);
    },
    exit: () => {},
    agent: null,
    setActiveWizard: (w: any) => {
      activeWizard = w;
    },
    setWizardOptions: (opts: string[]) => {
      wizardOptions = opts;
    },
    setWizardSelectedIndex: () => {},
  };

  beforeEach(() => {
    process.env.MODEL = "openai:gpt-4o";
    addedLines = [];
    activeWizard = null;
    wizardOptions = [];
    vi.restoreAllMocks();
  });

  it("should show usage instructions if run without arguments and setActiveWizard is not present", async () => {
    const ctxNoWizard = {
      addLine: (line: ChatLine) => {
        addedLines.push(line);
      },
      exit: () => {},
      agent: null,
    };
    await handleSlashCommand("/login", ctxNoWizard as any);
    expect(addedLines.length).toBe(1);
    expect(addedLines[0].content).toContain("Usage:");
    expect(addedLines[0].content).toContain("/login add");
    expect(addedLines[0].content).toContain("/login list");
    expect(addedLines[0].content).toContain("/login remove");
  });

  it("should launch wizard if run without arguments and setActiveWizard is present", async () => {
    vi.spyOn(configModule, "getConfiguredProviders").mockReturnValue([]);
    await handleSlashCommand("/login", mockCtx as any);
    expect(activeWizard).toEqual({
      type: "login",
      step: 1,
      data: {},
    });
    expect(wizardOptions[0]).toContain("List Configured Providers");
    expect(wizardOptions[1]).toContain("Create / Log in to a Provider");
  });

  it("should launch wizard at step 1 regardless of configured providers", async () => {
    vi.spyOn(configModule, "getConfiguredProviders").mockReturnValue([
      { id: "openrouter", name: "openrouter", type: "openrouter", apiKey: "sk-or-test" },
    ]);
    await handleSlashCommand("/login", mockCtx as any);
    expect(activeWizard).toEqual({
      type: "login",
      step: 1,
      data: {},
    });
    expect(wizardOptions[0]).toContain("List Configured Providers");
    expect(wizardOptions[1]).toContain("Create / Log in to a Provider");
  });

  it("should list configured providers on /login list", async () => {
    vi.spyOn(configModule, "getConfiguredProviders").mockReturnValue([
      {
        id: "openrouter",
        name: "openrouter",
        type: "openrouter",
        apiKey: "sk-or-test-key-1234",
        baseUrl: "https://openrouter.ai/api/v1",
        isActive: true,
      },
      {
        id: "custom-p",
        name: "custom-p",
        type: "custom",
        apiKey: "custom-key",
        baseUrl: "https://custom.api/v1",
        isActive: false,
      }
    ]);

    await handleSlashCommand("/login list", mockCtx as any);
    expect(addedLines.length).toBe(1);
    expect(addedLines[0].content).toContain("Configured Providers:");
    expect(addedLines[0].content).toContain("- openrouter [openrouter] (API Key: sk-o...1234)");
    expect(addedLines[0].content).toContain("- custom-p [custom] (API Key: cust...-key) (Base URL: https://custom.api/v1)");
  });

  it("should output message if no providers configured on /login list", async () => {
    vi.spyOn(configModule, "getConfiguredProviders").mockReturnValue([]);
    await handleSlashCommand("/login list", mockCtx as any);
    expect(addedLines.length).toBe(1);
    expect(addedLines[0].content).toContain("No providers configured yet.");
  });

  it("should remove provider on /login remove <id>", async () => {
    vi.spyOn(configModule, "getProviders").mockReturnValue([
      {
        id: "openrouter",
        name: "openrouter",
        provider: "openrouter",
        apiKey: "sk-or-test-key-1234",
      }
    ]);
    const removeProviderSpy = vi.spyOn(configModule, "removeProvider").mockImplementation(() => {});

    await handleSlashCommand("/login remove openrouter", mockCtx as any);

    expect(removeProviderSpy).toHaveBeenCalledWith("openrouter");
    expect(addedLines[0].content).toContain("Successfully removed provider: openrouter");
  });

  it("should fail to remove non-existent provider on /login remove <id>", async () => {
    vi.spyOn(configModule, "getProviders").mockReturnValue([]);
    await handleSlashCommand("/login remove non-existent", mockCtx as any);
    expect(addedLines.length).toBe(1);
    expect(addedLines[0].type).toBe("error");
    expect(addedLines[0].content).toContain('Provider with ID "non-existent" not found');
  });

  it("should add provider on /login add <provider> <api_key>", async () => {
    const addProviderSpy = vi.spyOn(configModule, "addProvider").mockImplementation(() => {});
    const switchActiveProviderSpy = vi.spyOn(configModule, "switchActiveProvider").mockImplementation(() => {});
    vi.spyOn(configModule, "fetchAndCacheModels").mockResolvedValue(undefined as any);

    await handleSlashCommand("/login add openrouter sk-or-test-key-5678", mockCtx as any);

    expect(addProviderSpy).toHaveBeenCalledWith({
      id: "openrouter",
      name: "openrouter",
      provider: "openrouter",
      apiKey: "sk-or-test-key-5678",
      baseUrl: "https://openrouter.ai/api/v1",
    });
    expect(switchActiveProviderSpy).toHaveBeenCalledWith("openrouter");
    expect(addedLines[0].content).toContain("Successfully configured provider profile: openrouter (openrouter)");
  });

  it("should add custom provider on /login add custom <base_url> <api_key>", async () => {
    const addProviderSpy = vi.spyOn(configModule, "addProvider").mockImplementation(() => {});
    const switchActiveProviderSpy = vi.spyOn(configModule, "switchActiveProvider").mockImplementation(() => {});
    vi.spyOn(configModule, "fetchAndCacheModels").mockResolvedValue(undefined as any);

    await handleSlashCommand("/login add custom https://custom.api/v1 custom-key-123", mockCtx as any);

    expect(addProviderSpy).toHaveBeenCalledWith({
      id: "custom",
      name: "custom",
      provider: "custom",
      apiKey: "custom-key-123",
      baseUrl: "https://custom.api/v1",
    });
    expect(switchActiveProviderSpy).toHaveBeenCalledWith("custom");
    expect(addedLines[0].content).toContain("Successfully configured provider profile: custom (custom)");
  });

  it("should support auto-detection on /login add <api_key>", async () => {
    const addProviderSpy = vi.spyOn(configModule, "addProvider").mockImplementation(() => {});
    const switchActiveProviderSpy = vi.spyOn(configModule, "switchActiveProvider").mockImplementation(() => {});
    vi.spyOn(configModule, "fetchAndCacheModels").mockResolvedValue(undefined as any);

    await handleSlashCommand("/login add sk-ant-test-key-777", mockCtx as any);

    expect(addProviderSpy).toHaveBeenCalledWith({
      id: "anthropic",
      name: "anthropic",
      provider: "anthropic",
      apiKey: "sk-ant-test-key-777",
      baseUrl: undefined,
    });
    expect(switchActiveProviderSpy).toHaveBeenCalledWith("anthropic");
  });

  it("should fallback to legacy usage with warning", async () => {
    const addProviderSpy = vi.spyOn(configModule, "addProvider").mockImplementation(() => {});
    const switchActiveProviderSpy = vi.spyOn(configModule, "switchActiveProvider").mockImplementation(() => {});
    vi.spyOn(configModule, "fetchAndCacheModels").mockResolvedValue(undefined as any);

    await handleSlashCommand("/login openrouter sk-or-legacy", mockCtx as any);

    expect(addedLines[0].content).toContain("Warning: Direct use of /login is deprecated. Please use: /login add");
    expect(addProviderSpy).toHaveBeenCalledWith({
      id: "openrouter",
      name: "openrouter",
      provider: "openrouter",
      apiKey: "sk-or-legacy",
      baseUrl: "https://openrouter.ai/api/v1",
    });
  });
});



import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { handleSlashCommand, type ChatLine } from "../src/core/slash-commands.js";
import { Agent } from "../src/core/agent.js";

describe("Slash Command: /model", () => {
  let originalEnv: NodeJS.ProcessEnv;
  let addedLines: ChatLine[] = [];
  let currentContextLimit = 0;

  const mockCtx = {
    addLine: (line: ChatLine) => {
      addedLines.push(line);
    },
    exit: () => {},
    agent: null as Agent | null,
    setContextLimit: (limit: number) => {
      currentContextLimit = limit;
    },
  };

  beforeEach(() => {
    originalEnv = { ...process.env };
    addedLines = [];
    currentContextLimit = 0;
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
  });

  it("should update standard MODEL when no tier prefix is supplied", () => {
    handleSlashCommand("/model anthropic:claude-3-5-haiku", mockCtx);

    expect(process.env.MODEL).toBe("anthropic:claude-3-5-haiku");
    expect(addedLines.length).toBe(1);
    expect(addedLines[0].content).toContain("Default Model changed to: anthropic:claude-3-5-haiku");
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

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "os";
import path from "path";
import fs from "fs";
import { Agent } from "../src/core/agent.js";
import * as configModule from "../src/core/config.js";
import {
  masterToolset,
  superagentToolset,
  subagentToolsets,
} from "../src/core/tools/toolsets.js";
import * as rmemoryUtilModule from "../src/core/rmemoryUtil.js";

const tempHome = path.join(process.cwd(), "tests", "temp-home-tier-toolset");
vi.spyOn(os, "homedir").mockReturnValue(tempHome);

const DISCOVERY_NAMES = ["list_tools", "describe_tool"];

function toolNames(tools: Array<{ name: string }>): string[] {
  return tools.map((tool) => tool.name);
}

function createAgent(tier: "master" | "single" | "superagent" | "subagent"): Agent {
  const agent = new Agent(
    vi.fn(),
    vi.fn().mockResolvedValue(true),
    vi.fn(),
    undefined,
    undefined,
    process.cwd(),
  );
  agent.tier = tier;
  return agent;
}

async function exposeAuthorizedToolset(agent: Agent): Promise<string[]> {
  const authorized = await agent.getActiveTools();
  const authorizedNames = toolNames(authorized);
  if (agent.tier === "subagent") return authorizedNames;

  const initialVisible = await agent.getModelVisibleTools(authorized);
  expect(toolNames(initialVisible).sort()).toEqual([...DISCOVERY_NAMES].sort());

  const describeTool = authorized.find((tool) => tool.name === "describe_tool");
  expect(describeTool).toBeDefined();
  const namesToDescribe = authorizedNames.filter((name) => !DISCOVERY_NAMES.includes(name));
  const response = await describeTool!.execute({ names: namesToDescribe }, agent.workingDirectory);
  const described = JSON.parse(String(response)) as Array<{ name?: string; error?: string }>;
  expect(described).toHaveLength(namesToDescribe.length);
  expect(described.every((result) => !result.error)).toBe(true);

  return toolNames(await agent.getModelVisibleTools(authorized));
}

describe("Agent - Tier-Specific Default Toolset Resolution", () => {
  beforeEach(() => {
    if (fs.existsSync(tempHome)) fs.rmSync(tempHome, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.spyOn(rmemoryUtilModule, "getRMemoryClient").mockReturnValue({} as any);
    vi.spyOn(rmemoryUtilModule, "getRMemorySessionKey").mockReturnValue("test-sess");
    vi.spyOn(rmemoryUtilModule, "isRmemoryActive").mockResolvedValue(true);
    vi.spyOn(configModule, "getConfig").mockReturnValue({
      provider: "openai",
      model: "gpt-4",
      apiKey: "fake-key",
      disableStreaming: false,
      workingDirectory: process.cwd(),
      systemPrompt: "Base Agent Prompt Content",
    } as any);
  });

  afterEach(() => {
    if (fs.existsSync(tempHome)) fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it("resolves the authorized master toolset through dynamic discovery", async () => {
    const agent = createAgent("master");
    agent.planState = "APPROVED";

    const exposedNames = await exposeAuthorizedToolset(agent);
    const expectedNames = masterToolset
      .map((tool) => tool.name)
      .filter((name) => name !== "manage_workspace_chain" && name !== "cross_workspace_exec");
    expect(exposedNames.sort()).toEqual(expectedNames.sort());
  });

  it("resolves the authorized single-agent toolset through dynamic discovery", async () => {
    const agent = createAgent("single");
    agent.planState = "APPROVED";

    const exposedNames = await exposeAuthorizedToolset(agent);
    const expectedNames = superagentToolset
      .map((tool) => tool.name)
      .filter((name) => name !== "manage_workspace_chain" && name !== "cross_workspace_exec");
    expect(exposedNames.sort()).toEqual(expectedNames.sort());
  });

  it("resolves the authorized Superagent toolset through dynamic discovery", async () => {
    const agent = createAgent("superagent");
    agent.planState = "APPROVED";

    const exposedNames = await exposeAuthorizedToolset(agent);
    const expectedNames = superagentToolset
      .map((tool) => tool.name)
      .filter((name) => name !== "manage_workspace_chain" && name !== "cross_workspace_exec");
    expect(exposedNames.sort()).toEqual(expectedNames.sort());
  });

  it("resolves the coder subagent toolset without changing its direct-schema contract", async () => {
    const agent = createAgent("subagent");
    agent.subagentType = "coder";
    agent.planState = "APPROVED";

    const exposedNames = await exposeAuthorizedToolset(agent);
    const expectedNames = subagentToolsets.coder.map((tool) => tool.name);
    expect(exposedNames.sort()).toEqual(expectedNames.sort());
  });

  it("resolves the Chrome subagent toolset including all authorized Chrome tools", async () => {
    const agent = createAgent("subagent");
    agent.subagentType = "chrome-agent";
    agent.planState = "APPROVED";

    const exposedNames = await exposeAuthorizedToolset(agent);
    const expectedNames = subagentToolsets["chrome-agent"].map((tool) => tool.name);
    expect(exposedNames.sort()).toEqual(expectedNames.sort());
  });

  it("does not category-filter discovered tools while a plan is active", async () => {
    const agent = createAgent("single");
    agent.planState = "APPROVED";
    agent.currentClassification = {
      category: "conversation",
      confidence: "high",
      reason: "Short acknowledgment",
      heuristicOnly: true,
      classificationTokens: 0,
    };

    const authorized = await agent.getActiveTools();
    const expectedNames = toolNames(authorized);
    const firstContext = await (await import("../src/core/agent/ContextBuilder.js")).ContextBuilder.buildContext(agent);
    expect(firstContext.filteredToolDefs.map((tool: any) => tool.name).sort()).toEqual([...DISCOVERY_NAMES].sort());

    const describeTool = authorized.find((tool) => tool.name === "describe_tool");
    expect(describeTool).toBeDefined();
    const namesToDescribe = expectedNames.filter((name) => !DISCOVERY_NAMES.includes(name));
    const response = await describeTool!.execute({ names: namesToDescribe }, agent.workingDirectory);
    const described = JSON.parse(String(response)) as Array<{ name?: string; error?: string }>;
    expect(described).toHaveLength(namesToDescribe.length);
    expect(described.every((result) => !result.error)).toBe(true);

    const contextAfterDiscovery = await (await import("../src/core/agent/ContextBuilder.js")).ContextBuilder.buildContext(agent);
    expect(contextAfterDiscovery.filteredToolDefs.map((tool: any) => tool.name).sort()).toEqual(expectedNames.sort());
  });
});

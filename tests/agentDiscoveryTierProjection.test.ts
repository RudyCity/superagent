import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import os from "os";
import path from "path";
import fs from "fs";
import { Agent } from "../src/core/agent.js";
import * as configModule from "../src/core/config.js";
import * as rmemoryUtilModule from "../src/core/rmemoryUtil.js";
import {
  masterToolset,
  superagentToolset,
  subagentToolsets,
} from "../src/core/tools/toolsets.js";

const tempHome = path.join(process.cwd(), "tests", "temp-home-tool-discovery-tiers");
vi.spyOn(os, "homedir").mockReturnValue(tempHome);

describe("Agent tier tool visibility with progressive discovery", () => {
  beforeEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.spyOn(os, "homedir").mockReturnValue(tempHome);
    vi.spyOn(rmemoryUtilModule, "getRMemoryClient").mockReturnValue({} as any);
    vi.spyOn(rmemoryUtilModule, "getRMemorySessionKey").mockReturnValue("test-session");
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
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  const createAgent = (tier: "master" | "single" | "superagent" | "subagent", subagentType?: string) => {
    const agent = new Agent(vi.fn(), vi.fn(async () => true), vi.fn(async () => "continue"));
    agent.tier = tier;
    agent.planState = "APPROVED";
    if (subagentType) agent.subagentType = subagentType;
    return agent;
  };

  const withoutWorkspaceChainTools = (names: string[]) =>
    names.filter((name) => name !== "manage_workspace_chain" && name !== "cross_workspace_exec");

  it.each([
    ["master", "master"] as const,
    ["single", "single"] as const,
    ["multi worker", "superagent"] as const,
  ])("%s keeps its full authorized catalog but starts with discovery schemas only", async (_label, tier) => {
    const agent = createAgent(tier);
    try {
      const active = await agent.getActiveTools();
      const visible = await agent.getModelVisibleTools(active);
      const expectedCatalog = tier === "master" ? masterToolset : superagentToolset;

      expect(active.map((tool) => tool.name)).toEqual(
        withoutWorkspaceChainTools(expectedCatalog.map((tool) => tool.name)),
      );
      expect(visible.map((tool) => tool.name)).toEqual(["list_tools", "describe_tool"]);
    } finally {
      agent.dispose();
    }
  });

  it.each(["coder", "chrome-agent"] as const)(
    "preserves the complete specialized %s Subagent toolset",
    async (subagentType) => {
      const agent = createAgent("subagent", subagentType);
      try {
        const active = await agent.getActiveTools();
        const visible = await agent.getModelVisibleTools(active);
        const expected = subagentToolsets[subagentType];

        expect(active.map((tool) => tool.name)).toEqual(expected.map((tool) => tool.name));
        expect(visible.map((tool) => tool.name)).toEqual(expected.map((tool) => tool.name));
      } finally {
        agent.dispose();
      }
    },
  );

  it("keeps discovery schemas exposed when classification would otherwise narrow a Single tier request", async () => {
    const agent = createAgent("single");
    agent.currentClassification = {
      category: "conversation",
      confidence: "high",
      reason: "Short acknowledgment",
      heuristicOnly: true,
      classificationTokens: 0,
    };
    try {
      const active = await agent.getActiveTools();
      expect((await agent.getModelVisibleTools(active)).map((tool) => tool.name)).toEqual([
        "list_tools",
        "describe_tool",
      ]);
    } finally {
      agent.dispose();
    }
  });
});

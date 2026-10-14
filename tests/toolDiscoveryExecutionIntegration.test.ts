import { afterEach, describe, expect, it, vi } from "vitest";
import { Agent, agentLocalStorage } from "../src/core/agent.js";
import { executeToolCall } from "../src/core/permissions.js";
import type { Tool } from "../src/core/tools/types.js";
import { listToolsTool, describeToolTool } from "../src/core/tools/toolDiscoveryTools.js";

function fixture(name: string): Tool {
  return {
    name,
    description: `Agent-local fixture for ${name}`,
    parameters: { type: "object", properties: { pattern: { type: "string" } } },
    async execute() {
      return `${name} executed by this Agent`;
    },
  };
}

function customCatalog(...tools: Tool[]): Tool[] {
  return [{ ...listToolsTool }, { ...describeToolTool }, ...tools];
}

describe.each([
  ["Single Mode", "single"],
  ["Multi Mode worker", "superagent"],
] as const)("Agent-scoped discovery execution — %s", (_label, tier) => {
  const agents: Agent[] = [];

  afterEach(() => {
    for (const agent of agents.splice(0)) agent.dispose();
  });

  it("activates a described schema for the next iteration and executes its Agent-local tool", async () => {
    const agent = new Agent(
      vi.fn(),
      vi.fn(async () => true),
      vi.fn(async () => "continue"),
      undefined,
      customCatalog(fixture("glob")),
      process.cwd(),
    );
    agent.tier = tier;
    agents.push(agent);

    const initialAuthorized = await agent.getActiveTools();
    expect((await agent.getModelVisibleTools(initialAuthorized)).map((tool) => tool.name)).toEqual([
      "list_tools",
      "describe_tool",
    ]);

    const described = await agentLocalStorage.run(agent, () =>
      executeToolCall(
        { id: "describe-glob", name: "describe_tool", args: { tool: "glob" } },
        process.cwd(),
        undefined,
        initialAuthorized,
      ),
    );
    expect(described.isError).not.toBe(true);
    expect(String(described.result)).toContain('"name": "glob"');

    const nextIterationTools = await agent.getModelVisibleTools(await agent.getActiveTools());
    expect(nextIterationTools.map((tool) => tool.name)).toEqual([
      "list_tools",
      "describe_tool",
      "glob",
    ]);

    const currentAuthorized = await agent.getActiveTools();
    const executed = await agentLocalStorage.run(agent, () =>
      executeToolCall(
        { id: "run-glob", name: "glob", args: { pattern: "**/*.ts" } },
        process.cwd(),
        undefined,
        currentAuthorized,
      ),
    );
    expect(executed.isError).not.toBe(true);
    expect(executed.result).toBe("glob executed by this Agent");
  });

  it("still rejects a globally registered tool absent from this Agent's authorized catalog", async () => {
    const agent = new Agent(
      vi.fn(),
      vi.fn(async () => true),
      vi.fn(async () => "continue"),
      undefined,
      customCatalog(fixture("glob")),
      process.cwd(),
    );
    agent.tier = tier;
    agents.push(agent);

    const activeTools = await agent.getActiveTools();
    const denied = await agentLocalStorage.run(agent, () =>
      executeToolCall(
        { id: "unauthorized-bash", name: "bash", args: { command: "echo must-not-run" } },
        process.cwd(),
        undefined,
        activeTools,
      ),
    );

    expect(denied.isError).toBe(true);
    expect(String(denied.result)).toContain("not available for this agent's tier");
  });
});

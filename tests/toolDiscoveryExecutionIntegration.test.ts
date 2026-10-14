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

  it("resolves and executes compatibility aliases (get_tools, describe_tools, read_file) through Agent-scoped dispatch", async () => {
    const agent = new Agent(
      vi.fn(),
      vi.fn(async () => true),
      vi.fn(async () => "continue"),
      undefined,
      customCatalog(fixture("read")),
      process.cwd(),
    );
    agent.tier = tier;
    agents.push(agent);

    const activeTools = await agent.getActiveTools();

    // 1. Call get_tools alias
    const listRes = await agentLocalStorage.run(agent, () =>
      executeToolCall(
        { id: "get-tools-call", name: "get_tools", args: {} },
        process.cwd(),
        undefined,
        activeTools,
      ),
    );
    expect(listRes.isError).not.toBe(true);
    expect(String(listRes.result)).toContain("list_tools");

    // 2. Call describe_tools alias describing an alias "read_file"
    const descRes = await agentLocalStorage.run(agent, () =>
      executeToolCall(
        { id: "describe-tools-call", name: "describe_tools", args: { tool: "read_file" } },
        process.cwd(),
        undefined,
        activeTools,
      ),
    );
    expect(descRes.isError).not.toBe(true);
    expect(String(descRes.result)).toContain('"name": "read"');

    // 3. Verify read is now model-visible
    const visible = await agent.getModelVisibleTools(await agent.getActiveTools());
    expect(visible.map((t) => t.name)).toContain("read");

    // 4. Calling read_file alias executes canonical read
    const execRes = await agentLocalStorage.run(agent, () =>
      executeToolCall(
        { id: "read-alias-call", name: "read_file", args: {} },
        process.cwd(),
        undefined,
        activeTools,
      ),
    );
    expect(execRes.isError).not.toBe(true);
    expect(execRes.result).toBe("read executed by this Agent");
  });

  it("preserves explicitly discovered tools in modelVisibleTools even under question category filtering", async () => {
    const agent = new Agent(
      vi.fn(),
      vi.fn(async () => true),
      vi.fn(async () => "continue"),
      undefined,
      customCatalog(fixture("run_command")),
      process.cwd(),
    );
    agent.tier = tier;
    agent.currentClassification = {
      category: "question",
      confidence: "high",
      reason: "User asking a question",
      heuristicOnly: true,
      classificationTokens: 0,
    };
    agents.push(agent);

    const activeTools = await agent.getActiveTools();

    // Discover run_command (which is normally omitted from question category)
    await agentLocalStorage.run(agent, () =>
      executeToolCall(
        { id: "desc-cmd", name: "describe_tool", args: { tool: "run_command" } },
        process.cwd(),
        undefined,
        activeTools,
      ),
    );

    expect(agent.isToolDiscovered("run_command")).toBe(true);

    const { ContextBuilder } = await import("../src/core/agent/ContextBuilder.js");
    const context = await ContextBuilder.buildContext(agent, false, 10);
    const visibleNames = context.filteredToolDefs.map((t: any) => t.name);
    expect(visibleNames).toContain("run_command");
    expect(visibleNames).toContain("list_tools");
    expect(visibleNames).toContain("describe_tool");
  });

});

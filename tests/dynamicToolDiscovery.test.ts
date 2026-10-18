import { describe, expect, it, vi } from "vitest";
import { Agent } from "../src/core/agent.js";
import type { Tool } from "../src/core/tools/types.js";
import { ToolDiscoveryState } from "../src/core/tools/toolDiscoveryState.js";
import { listToolsTool, describeToolTool } from "../src/core/tools/toolDiscoveryTools.js";

function fixture(name: string, description = `Tool for ${name}`): Tool {
  return {
    name,
    description,
    parameters: { type: "object", properties: {} },
    async execute() {
      return `${name} executed`;
    },
  };
}

function catalog(...tools: Tool[]): Tool[] {
  return [
    { ...listToolsTool, execute: listToolsTool.execute },
    { ...describeToolTool, execute: describeToolTool.execute },
    ...tools,
  ];
}

describe("ToolDiscoveryState", () => {
  it("exposes only discovery schemas before a tool is described", () => {
    const state = new ToolDiscoveryState();
    const authorized = catalog(fixture("read"), fixture("write_to_file"));

    const visible = state.getModelVisibleTools(authorized);

    expect(visible.map((tool) => tool.name)).toEqual(["list_tools", "describe_tool"]);
  });

  it("listing a tool does not expose its full schema", async () => {
    const state = new ToolDiscoveryState();
    const authorized = catalog(fixture("read"), fixture("write_to_file"));
    const wrapped = state.wrapTools(authorized);
    const list = wrapped.find((tool) => tool.name === "list_tools")!;

    await list.execute({ query: "read" }, process.cwd());

    expect(state.getModelVisibleTools(wrapped).map((tool) => tool.name)).toEqual([
      "list_tools",
      "describe_tool",
    ]);
  });

  it("exposes only authorized tools successfully described by the model", async () => {
    const state = new ToolDiscoveryState();
    const authorized = catalog(fixture("read"), fixture("write_to_file"));
    const wrapped = state.wrapTools(authorized);
    const describe = wrapped.find((tool) => tool.name === "describe_tool")!;

    await describe.execute({ tool: "read" }, process.cwd());

    expect(state.getModelVisibleTools(wrapped).map((tool) => tool.name)).toEqual([
      "list_tools",
      "describe_tool",
      "read",
    ]);
  });

  it("can reset discovered schemas between independent tasks", async () => {
    const state = new ToolDiscoveryState();
    const authorized = catalog(fixture("read"));
    const wrapped = state.wrapTools(authorized);
    await wrapped.find((tool) => tool.name === "describe_tool")!.execute(
      { tool: "read" },
      process.cwd(),
    );
    expect(state.getModelVisibleTools(wrapped).map((tool) => tool.name)).toContain("read");

    state.reset();

    expect(state.getModelVisibleTools(wrapped).map((tool) => tool.name)).toEqual([
      "list_tools",
      "describe_tool",
    ]);
  });

  it("does not activate tools outside the agent's authorized catalog", async () => {
    const state = new ToolDiscoveryState();
    const authorized = catalog(fixture("read"));
    const wrapped = state.wrapTools(authorized);
    const describe = wrapped.find((tool) => tool.name === "describe_tool")!;

    const result = await describe.execute({ tool: "run_command" }, process.cwd());

    expect(String(result)).toContain("Unknown tool");
    expect(state.getModelVisibleTools(wrapped).map((tool) => tool.name)).toEqual([
      "list_tools",
      "describe_tool",
    ]);
  });

  it("clears discovered schemas when the authorized catalog changes", async () => {
    const state = new ToolDiscoveryState();
    const firstCatalog = state.wrapTools(catalog(fixture("read")));
    await firstCatalog.find((tool) => tool.name === "describe_tool")!.execute(
      { tool: "read" },
      process.cwd(),
    );
    expect(state.getModelVisibleTools(firstCatalog).map((tool) => tool.name)).toContain("read");

    const changedCatalog = state.wrapTools(catalog(fixture("fetch_url")));
    expect(state.getModelVisibleTools(changedCatalog).map((tool) => tool.name)).toEqual([
      "list_tools",
      "describe_tool",
    ]);
  });

  it("preserves discovery when the wrapped discovery-tool schemas differ from registry metadata", async () => {
    const state = new ToolDiscoveryState();
    const authorized: Tool[] = [
      { ...listToolsTool, description: "Registry's list-tools contract", parameters: { type: "object", properties: { search: { type: "string" } } } },
      { ...describeToolTool, description: "Registry's describe-tools contract", parameters: { type: "object", properties: { selected: { type: "string" } } } },
      fixture("read"),
    ];
    const wrapped = state.wrapTools(authorized);
    await wrapped.find((tool) => tool.name === "describe_tool")!.execute(
      { tool: "read" },
      process.cwd(),
    );

    expect(state.getModelVisibleTools(wrapped).map((tool) => tool.name)).toEqual([
      "list_tools",
      "describe_tool",
      "read",
    ]);
  });

  it("does not hide a custom toolset that has no discovery entry points", () => {
    const state = new ToolDiscoveryState();
    const customTools = [fixture("custom_action")];

    expect(state.getModelVisibleTools(customTools)).toEqual(customTools);
  });

  it("keeps the full authorized catalog for execution while staging Single Mode schemas", async () => {
    const authorized = catalog(fixture("read"), fixture("write_to_file"));
    const agent = new Agent(vi.fn(), vi.fn(async () => true), vi.fn(async () => "continue"), undefined, authorized, process.cwd());
    agent.tier = "single";

    try {
      const activeTools = await agent.getActiveTools();
      expect(activeTools.map((tool) => tool.name)).toEqual([
        "list_tools",
        "describe_tool",
        "read",
        "write_to_file",
      ]);
      expect((await agent.getModelVisibleTools(activeTools)).map((tool) => tool.name)).toEqual([
        "list_tools",
        "describe_tool",
      ]);

      await activeTools.find((tool) => tool.name === "describe_tool")!.execute(
        { tool: "read" },
        process.cwd(),
      );

      expect((await agent.getModelVisibleTools(await agent.getActiveTools())).map((tool) => tool.name)).toEqual([
        "list_tools",
        "describe_tool",
        "read",
      ]);
      expect((await agent.getActiveTools()).map((tool) => tool.name)).toContain("write_to_file");
    } finally {
      agent.dispose();
    }
  });

  it("clears discovered schemas when the Agent changes operational mode", async () => {
    const authorized = catalog(fixture("read"));
    const agent = new Agent(vi.fn(), vi.fn(async () => true), vi.fn(async () => "continue"), undefined, authorized, process.cwd());
    agent.tier = "single";

    try {
      const activeTools = await agent.getActiveTools();
      await activeTools.find((tool) => tool.name === "describe_tool")!.execute(
        { tool: "read" },
        process.cwd(),
      );
      expect(agent.isToolDiscovered("read")).toBe(true);

      agent.setMode("debug");

      expect(agent.isToolDiscovered("read")).toBe(false);
      expect((await agent.getModelVisibleTools(await agent.getActiveTools())).map((tool) => tool.name)).toEqual([
        "list_tools",
        "describe_tool",
      ]);
    } finally {
      agent.dispose();
    }
  });

});

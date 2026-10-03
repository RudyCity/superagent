import { describe, it, expect } from "vitest";
import { describeToolTool, listToolsTool, extractToolNames } from "../src/core/tools/toolDiscoveryTools.js";
import { getToolByName } from "../src/core/tools/index.js";
import { getToolDescription } from "../src/core/permissions.js";

describe("extractToolNames helper", () => {
  it("extracts from singular tool property", () => {
    expect(extractToolNames({ tool: "run_background_process" })).toEqual(["run_background_process"]);
  });

  it("extracts from singular name property", () => {
    expect(extractToolNames({ name: "run_background_process" })).toEqual(["run_background_process"]);
  });

  it("extracts from tool_name and toolName properties", () => {
    expect(extractToolNames({ tool_name: "run_background_process" })).toEqual(["run_background_process"]);
    expect(extractToolNames({ toolName: "run_background_process" })).toEqual(["run_background_process"]);
  });

  it("extracts from names array and tools array", () => {
    expect(extractToolNames({ names: ["run_background_process", "manage_plan"] })).toEqual([
      "run_background_process",
      "manage_plan",
    ]);
    expect(extractToolNames({ tools: ["run_background_process"] })).toEqual(["run_background_process"]);
  });

  it("extracts from single string in names or tools", () => {
    expect(extractToolNames({ names: "run_background_process" })).toEqual(["run_background_process"]);
    expect(extractToolNames({ tools: "run_background_process" })).toEqual(["run_background_process"]);
  });

  it("extracts from raw string argument", () => {
    expect(extractToolNames("run_background_process")).toEqual(["run_background_process"]);
    expect(extractToolNames("\"run_background_process\"")).toEqual(["run_background_process"]);
  });

  it("returns empty array for empty object or invalid inputs", () => {
    expect(extractToolNames({})).toEqual([]);
    expect(extractToolNames(null)).toEqual([]);
    expect(extractToolNames(undefined)).toEqual([]);
  });
});

describe("describe_tool tool", () => {
  it("describes run_background_process when passed singular { tool: 'run_background_process' }", async () => {
    const rawResult = await describeToolTool.execute({ tool: "run_background_process" });
    expect(typeof rawResult).toBe("string");
    expect(rawResult).not.toBe("[]");

    const parsed = JSON.parse(rawResult);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(1);
    expect(parsed[0].name).toBe("run_background_process");
    expect(parsed[0].description).toContain("background");
    expect(parsed[0].parameters).toBeDefined();
    expect(parsed[0].parameters.properties).toHaveProperty("command");
  });

  it("describes run_background_process when passed plural { names: ['run_background_process'] }", async () => {
    const rawResult = await describeToolTool.execute({ names: ["run_background_process"] });
    const parsed = JSON.parse(rawResult);
    expect(parsed.length).toBe(1);
    expect(parsed[0].name).toBe("run_background_process");
  });

  it("describes run_background_process when passed { name: 'run_background_process' }", async () => {
    const rawResult = await describeToolTool.execute({ name: "run_background_process" });
    const parsed = JSON.parse(rawResult);
    expect(parsed.length).toBe(1);
    expect(parsed[0].name).toBe("run_background_process");
  });

  it("handles hyphenated tool names gracefully via normalization", async () => {
    const rawResult = await describeToolTool.execute({ tool: "run-background-process" });
    const parsed = JSON.parse(rawResult);
    expect(parsed.length).toBe(1);
    expect(parsed[0].name).toBe("run_background_process");
  });

  it("handles common aliases like background_process", async () => {
    const rawResult = await describeToolTool.execute({ tool: "background_process" });
    const parsed = JSON.parse(rawResult);
    expect(parsed.length).toBe(1);
    expect(parsed[0].name).toBe("run_background_process");
  });

  it("handles multiple tools in one call", async () => {
    const rawResult = await describeToolTool.execute({
      names: ["run_background_process", "manage_plan"],
    });
    const parsed = JSON.parse(rawResult);
    expect(parsed.length).toBe(2);
    expect(parsed[0].name).toBe("run_background_process");
    expect(parsed[1].name).toBe("manage_plan");
  });

  it("returns actionable guidance instead of [] when called with empty args", async () => {
    const rawResult = await describeToolTool.execute({});
    expect(rawResult).not.toBe("[]");
    const parsed = JSON.parse(rawResult);
    expect(parsed[0].error).toContain("No tool name provided");
  });

  it("returns helpful error and suggestions for unknown tool", async () => {
    const rawResult = await describeToolTool.execute({ tool: "background_unknown_xyz" });
    const parsed = JSON.parse(rawResult);
    expect(parsed[0].error).toContain("Unknown tool");
    expect(parsed[0].error).toContain("Did you mean");
  });
});

describe("list_tools tool", () => {
  it("filters tools matching query", async () => {
    const result = await listToolsTool.execute({ query: "background" });
    expect(typeof result).toBe("string");
    expect(result).toContain("run_background_process");
  });

  it("supports q and filter aliases for query", async () => {
    const result = await listToolsTool.execute({ q: "background" });
    expect(result).toContain("run_background_process");
  });
});

describe("getToolByName resilience", () => {
  it("resolves tool with surrounding quotes and whitespace", () => {
    expect(getToolByName("  run_background_process  ")?.name).toBe("run_background_process");
    expect(getToolByName("\"run_background_process\"")?.name).toBe("run_background_process");
    expect(getToolByName("'run_background_process'")?.name).toBe("run_background_process");
  });

  it("resolves tool case-insensitively", () => {
    expect(getToolByName("RUN_BACKGROUND_PROCESS")?.name).toBe("run_background_process");
    expect(getToolByName("Run_Command")?.name).toBe("run_command");
  });

  it("resolves tool with hyphens instead of underscores", () => {
    expect(getToolByName("run-background-process")?.name).toBe("run_background_process");
    expect(getToolByName("manage-tasks")?.name).toBe("manage_tasks");
  });

  it("resolves common tool aliases", () => {
    expect(getToolByName("background_process")?.name).toBe("run_background_process");
    expect(getToolByName("read_file")?.name).toBe("read");
    expect(getToolByName("write_file")?.name).toBe("write_to_file");
  });
});

describe("getToolDescription for describe_tool and list_tools", () => {
  it("formats describe_tool description nicely", () => {
    const desc = getToolDescription({
      id: "tc-1",
      name: "describe_tool",
      args: { tool: "run_background_process" },
    });
    expect(desc).toBe("Inspecting tool schema: run_background_process");
  });

  it("formats list_tools description nicely", () => {
    const desc = getToolDescription({
      id: "tc-2",
      name: "list_tools",
      args: { query: "background" },
    });
    expect(desc).toBe("Listing tools matching \"background\"");
  });
});

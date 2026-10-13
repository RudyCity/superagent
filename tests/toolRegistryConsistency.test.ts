import { describe, expect, it } from "vitest";
import { allTools, getToolByName } from "../src/core/tools/index.js";
import {
  defaultSubagentToolset,
  masterToolset,
  subagentToolsets,
  superagentToolset,
} from "../src/core/tools/toolsets.js";

describe("tool registry consistency", () => {
  it("does not expose duplicate names within any tier toolset", () => {
    const tierToolsets: Array<[string, Array<{ name: string }>]> = [
      ["master", masterToolset],
      ["superagent", superagentToolset],
      ["defaultSubagent", defaultSubagentToolset],
      ...Object.entries(subagentToolsets).map(([name, tools]) => [`subagent:${name}`, tools] as [string, Array<{ name: string }>]),
    ];

    const duplicatesByTier = tierToolsets.flatMap(([tier, tools]) => {
      const seen = new Set<string>();
      const duplicates = new Set<string>();
      for (const tool of tools) {
        if (seen.has(tool.name)) duplicates.add(tool.name);
        seen.add(tool.name);
      }
      return duplicates.size > 0 ? [`${tier}: ${[...duplicates].join(", ")}`] : [];
    });

    expect(duplicatesByTier).toEqual([]);
  });
  it("resolves documented compatibility aliases without exposing them as separate tools", () => {
    const aliases: Array<[string, string]> = [
      ["get_tools", "list_tools"],
      ["get_tool", "describe_tool"],
      ["describe_tools", "describe_tool"],
      ["cdp", "control_chrome_cdp"],
      ["emulate_device", "control_chrome_cdp"],
      ["drag_and_drop", "control_chrome_cdp"],
    ];

    for (const [alias, canonicalName] of aliases) {
      expect(getToolByName(alias)?.name, `alias ${alias}`).toBe(canonicalName);
      expect(allTools.some((tool) => tool.name === alias), `alias ${alias} should not be separately registered`).toBe(false);
    }
  });

  it("registers every tool exposed by tier toolsets", () => {
    const exposedTools = [
      ...masterToolset,
      ...superagentToolset,
      ...defaultSubagentToolset,
      ...Object.values(subagentToolsets).flat(),
    ];

    const missing = [...new Set(exposedTools.map((tool) => tool.name))]
      .filter((name) => !getToolByName(name));

    expect(missing).toEqual([]);
  });

  it("does not contain duplicate allTools registrations", () => {
    const names = allTools.map((tool) => tool.name);
    const duplicates = names.filter((name, index) => names.indexOf(name) !== index);

    expect(duplicates).toEqual([]);
  });

  it("can execute tools that repeatedly appeared as unknown in logs", () => {
    expect(getToolByName("bash")?.name).toBe("bash");
    expect(getToolByName("git_worktree")?.name).toBe("git_worktree");
    expect(getToolByName("list_peer_superagents")?.name).toBe("list_peer_superagents");
  });

  it("keeps fallback and reviewer-like subagent toolsets side-effect constrained", () => {
    const fallbackNames = defaultSubagentToolset.map((tool) => tool.name);
    const reviewerNames = subagentToolsets.reviewer.map((tool) => tool.name);
    const softwareTesterNames = subagentToolsets["software-tester"].map((tool) => tool.name);

    expect(fallbackNames).not.toEqual(expect.arrayContaining([
      "write_to_file",
      "replace_file_content",
      "run_command",
      "bash",
      "manage_mcp",
      "rmemory_save",
      "rmemory_conversation_add",
    ]));
    expect(reviewerNames).not.toEqual(expect.arrayContaining(["rmemory_save", "rmemory_conversation_add"]));
    expect(softwareTesterNames).not.toEqual(expect.arrayContaining(["rmemory_save", "rmemory_conversation_add"]));
  });
});

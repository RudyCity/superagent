import { describe, expect, it } from "vitest";
import { allTools, getToolByName } from "../src/core/tools/index.js";
import {
  defaultSubagentToolset,
  masterToolset,
  subagentToolsets,
  superagentToolset,
} from "../src/core/tools/toolsets.js";

describe("tool registry consistency", () => {
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
    const manualTesterNames = subagentToolsets["manual-tester"].map((tool) => tool.name);

    expect(fallbackNames).not.toEqual(expect.arrayContaining([
      "write_to_file",
      "replace_file_content",
      "run_command",
      "bash",
      "manage_mcp",
      "tdai_memory_save",
      "tdai_conversation_add",
    ]));
    expect(reviewerNames).not.toEqual(expect.arrayContaining(["tdai_memory_save", "tdai_conversation_add"]));
    expect(manualTesterNames).not.toEqual(expect.arrayContaining(["tdai_memory_save", "tdai_conversation_add"]));
  });
});

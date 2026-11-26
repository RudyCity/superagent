import { describe, expect, it } from "vitest";
import { listToolsTool, runListTools, rankToolsForIntent } from "../src/core/tools/toolDiscoveryTools.js";
import { ToolDiscoveryState } from "../src/core/tools/toolDiscoveryState.js";
import { describeToolTool } from "../src/core/tools/toolDiscoveryTools.js";
import type { Tool } from "../src/core/tools/types.js";

const fixture = (name: string, description: string): Tool => ({
  name, description, parameters: { type: "object", properties: {} },
  async execute() { return "ok"; },
});

describe("Intent-aware tool discovery", () => {
  const authorized = [
    listToolsTool,
    describeToolTool,
    fixture("git_action", "Stage and commit changes to a repository"),
    fixture("grep", "Search for patterns in code files"),
    fixture("write_to_file", "Write and edit code"),
    fixture("browser_click", "Click Chrome browser elements"),
  ];

  it("ranks a natural-language request without exposing schemas or unauthorized tools", async () => {
    const state = new ToolDiscoveryState();
    const wrapped = state.wrapTools(authorized);
    const listing = wrapped.find((t) => t.name === "list_tools")!;
    const output = await listing.execute({ intent: "audit code and commit", limit: 3 }, process.cwd());
    expect(output.split("\n")).toHaveLength(3);
    expect(output).toContain("git_action");
    expect(output).toContain("grep");
    expect(output).not.toContain("browser_click");
    expect(state.getModelVisibleTools(wrapped).map((t) => t.name)).toEqual(["list_tools", "describe_tool"]);
  });

  it("supports keyword discovery unchanged, bounding only when a limit is supplied", async () => {
    const full = await runListTools(authorized, {});
    expect(full.split("\n")).toHaveLength(authorized.length);
    const limited = await runListTools(authorized, { limit: 2 });
    expect(limited.split("\n")).toHaveLength(2);
    const matched = rankToolsForIntent(authorized, "commit to git", 2);
    expect(matched[0].name).toBe("git_action");
    const indo = await runListTools(authorized, { intent: "perbaiki bug pada kode", limit: 4 });
    expect(indo).toContain("write_to_file");
  });

  it("ranks Master and MCP orchestration, media, and history intents accurately", () => {
    const mcpCatalog = [
      fixture("superagent_media_compress", "Compress images and convert media files"),
      fixture("superagent_delegate_search_history", "Search synced ChatGPT Delegate chat history"),
      fixture("superagent_run_task", "Run a multi-agent Superagent orchestration task"),
      fixture("superagent_services_status", "Inspect running Core and MCP background services"),
    ];
    expect(rankToolsForIntent(mcpCatalog, "kompres gambar", 2)[0].name).toBe("superagent_media_compress");
    expect(rankToolsForIntent(mcpCatalog, "cari riwayat chatgpt", 2)[0].name).toBe("superagent_delegate_search_history");
    expect(rankToolsForIntent(mcpCatalog, "orchestrate feature plan", 2)[0].name).toBe("superagent_run_task");
    expect(rankToolsForIntent(mcpCatalog, "cek proses service", 2)[0].name).toBe("superagent_services_status");
  });
});

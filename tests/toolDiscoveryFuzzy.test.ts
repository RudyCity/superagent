/**
 * toolDiscoveryFuzzy.test.ts - fuzzy search for list_tools / describe_tool.
 */
import { describe, it, expect } from "vitest";
import {
  fuzzyScore,
  listToolsTool,
  describeToolTool,
} from "../src/core/tools/toolDiscoveryTools.js";

describe("fuzzyScore", () => {
  it("returns 0 for empty query or non-subsequence", () => {
    expect(fuzzyScore("", "cli_bridge")).toBe(0);
    expect(fuzzyScore("zzz", "cli_bridge")).toBe(0);
    expect(fuzzyScore("cb", "abc")).toBe(0); // wrong order
  });
  it("scores exact and prefix matches highest", () => {
    const exact = fuzzyScore("cli_bridge", "cli_bridge");
    const prefix = fuzzyScore("cli", "cli_bridge");
    const scattered = fuzzyScore("cbe", "cli_bridge");
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(scattered);
    expect(scattered).toBeGreaterThan(0);
  });
  it("rewards word boundaries", () => {
    expect(fuzzyScore("bridge", "cli_bridge")).toBeGreaterThan(
      fuzzyScore("bridge", "clibridgex")
    );
  });
});

describe("list_tools fuzzy filter", () => {
  it("ranks cli_bridge first for 'clibrdg'", async () => {
    const out = (await listToolsTool.execute({ query: "clibrdg" })) as string;
    const first = out.split("\n")[0];
    expect(first).toMatch(/^- cli_bridge:/);
  });
  it("empty query still lists everything", async () => {
    const out = (await listToolsTool.execute({})) as string;
    expect(out).toContain("- cli_bridge:");
    expect(out).toContain("- list_tools:");
  });
  it("filters accurately on description keyword without loose scattered false-positives", async () => {
    const out = (await listToolsTool.execute({ query: "audit" })) as string;
    expect(out).toContain("- generate_lock_report:");
    expect(out).not.toContain("- multi_replace_file_content:");
    expect(out).not.toContain("- read:");
  });
  it("returns no-match message for garbage", async () => {
    const out = (await listToolsTool.execute({ query: "zzzqqq" })) as string;
    expect(out).toMatch(/No tools match/);
  });
});

describe("describe_tool fuzzy suggestions and batching", () => {
  it("suggests cli_bridge for 'cli_brdge'", async () => {
    const out = (await describeToolTool.execute({ tool: "cli_brdge" })) as string;
    const parsed = JSON.parse(out);
    expect(parsed[0].error).toMatch(/Did you mean:.*cli_bridge/);
  });
  it("says Unknown tool for garbage without suggestions", async () => {
    const out = (await describeToolTool.execute({ tool: "zzzqqq" })) as string;
    const parsed = JSON.parse(out);
    expect(parsed[0].error).toMatch(/Unknown tool "zzzqqq"/);
    expect(parsed[0].error).not.toMatch(/Did you mean/);
  });
  it("exact name still resolves", async () => {
    const out = (await describeToolTool.execute({ tool: "cli_bridge" })) as string;
    const parsed = JSON.parse(out);
    expect(parsed[0].name).toBe("cli_bridge");
    expect(parsed[0].description).toBeTruthy();
  });
  it("supports batch describing multiple tools in one turn", async () => {
    const out = (await describeToolTool.execute({ names: ["read", "write_to_file"] })) as string;
    const parsed = JSON.parse(out);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].name).toBe("read");
    expect(parsed[1].name).toBe("write_to_file");
  });
});

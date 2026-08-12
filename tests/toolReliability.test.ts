import { describe, expect, it } from "vitest";
import { ripgrepSearchTool } from "../src/core/tools/systemTools.js";
import { getToolByName } from "../src/core/tools/index.js";

const cwd = process.cwd();

describe("tool reliability guards", () => {
  it("explains combined ripgrep paths instead of passing them to rg", async () => {
    const result = await ripgrepSearchTool.execute({ pattern: "x", path: "src tests" }, cwd);

    expect(result).toContain("Pass one path per ripgrep_search call");
    expect(result).toContain("src tests");
  });

  it("suggests valid manage_subagents actions for common plural mistake", async () => {
    const manageSubagentsTool = getToolByName("manage_subagents")!;
    const result = await manageSubagentsTool.execute({ action: "reports" }, cwd);

    expect(result).toContain("Valid actions: list, status, logs, report, violations, kill, kill_all");
    expect(result).toContain("Use \"report\" (singular), not \"reports\"");
  });
});

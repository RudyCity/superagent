import { describe, expect, it } from "vitest";
import { gitWorktreeTool, managePlanTool, manageTasksTool } from "../src/core/tools/otherTools.js";

const cwd = process.cwd();

describe("expanded tool reliability guards", () => {
  it("suggests valid actions for git_worktree with typo hint", async () => {
    const result = await gitWorktreeTool.execute({ action: "listy" }, cwd);

    expect(result).toContain("Unknown action \"listy\"");
    expect(result).toContain("Use action \"list\"");
  });

  it("suggests valid actions for manage_plan with typo hint", async () => {
    const result = await managePlanTool.execute({ action: "edits" }, cwd);

    expect(result).toContain("Unknown action \"edits\"");
    expect(result).toContain("Use action \"edit\"");
  });

  it("suggests valid actions for manage_tasks with typo hint", async () => {
    const result = await manageTasksTool.execute({ action: "adds" }, cwd);

    expect(result).toContain("Unknown action \"adds\"");
    expect(result).toContain("Use action \"add\"");
  });
});

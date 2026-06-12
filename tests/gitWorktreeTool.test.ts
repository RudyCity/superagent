import { describe, it, expect, vi, beforeEach } from "vitest";
import { execa } from "execa";
import { gitWorktreeTool } from "../src/core/tools/otherTools.js";

vi.mock("execa", () => ({
  execa: vi.fn().mockResolvedValue({ stdout: "" }),
}));

describe("gitWorktreeTool", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("should list worktrees", async () => {
    vi.mocked(execa).mockResolvedValueOnce({ stdout: "my-worktree" } as any);
    const result = await gitWorktreeTool.execute({ action: "list" }, process.cwd());
    expect(result).toBe("my-worktree");
    expect(execa).toHaveBeenCalledWith("git", ["worktree", "list"], expect.any(Object));
  });

  it("should prune worktrees", async () => {
    vi.mocked(execa).mockResolvedValueOnce({ stdout: "Pruned" } as any);
    const result = await gitWorktreeTool.execute({ action: "prune" }, process.cwd());
    expect(result).toBe("Pruned");
    expect(execa).toHaveBeenCalledWith("git", ["worktree", "prune"], expect.any(Object));
  });

  it("should add a worktree", async () => {
    const result = await gitWorktreeTool.execute(
      { action: "add", path: "./test-worktree", branch: "my-branch" },
      process.cwd()
    );
    expect(result).toContain("Worktree added");
    expect(execa).toHaveBeenCalledWith(
      "git",
      ["worktree", "add", expect.stringContaining("test-worktree"), "my-branch"],
      expect.any(Object)
    );
  });

  it("should remove a worktree", async () => {
    const result = await gitWorktreeTool.execute(
      { action: "remove", path: "./test-worktree", force: true },
      process.cwd()
    );
    expect(result).toContain("removed successfully");
    expect(execa).toHaveBeenCalledWith(
      "git",
      ["worktree", "remove", expect.stringContaining("test-worktree"), "--force"],
      expect.any(Object)
    );
  });
});

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

  it("should prune stale metadata when removing a path that is not a working tree", async () => {
    vi.mocked(execa)
      .mockRejectedValueOnce(new Error("fatal: '.worktrees/demo' is not a working tree"))
      .mockResolvedValueOnce({ stdout: "Pruned" } as any);

    const result = await gitWorktreeTool.execute(
      { action: "remove", path: "./.worktrees/demo", force: true },
      process.cwd()
    );

    expect(result).toContain("Worktree metadata pruned after stale remove");
    expect(execa).toHaveBeenLastCalledWith("git", ["worktree", "prune"], expect.any(Object));
  });

  it("should fall back to filesystem removal for forced remove failures", async () => {
    vi.mocked(execa)
      .mockRejectedValueOnce(new Error("Filename too long"))
      .mockResolvedValueOnce({ stdout: "Pruned" } as any);

    const result = await gitWorktreeTool.execute(
      { action: "remove", path: "./tests/temp-worktree-remove", force: true },
      process.cwd()
    );

    expect(result).toContain("Worktree directory removed with filesystem fallback");
    expect(execa).toHaveBeenLastCalledWith("git", ["worktree", "prune"], expect.any(Object));
  });
});

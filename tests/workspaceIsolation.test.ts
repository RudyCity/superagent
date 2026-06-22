import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "fs";
import path from "path";
import { execa } from "execa";
import { ensureGitIgnore, setupWorkspaceForSession, cleanupWorkspaceForSession } from "../src/core/workspaceIsolation.js";

// Mock execa
vi.mock("execa", () => ({
  execa: vi.fn().mockResolvedValue({ stdout: "" }),
}));

describe("workspaceIsolation", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(fs, "writeFileSync").mockImplementation(() => {});
    vi.spyOn(fs, "appendFileSync").mockImplementation(() => {});
  });

  describe("ensureGitIgnore", () => {
    it("should create .gitignore with .worktrees/ if it does not exist", () => {
      const spyExists = vi.spyOn(fs, "existsSync").mockReturnValue(false);
      const spyWrite = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {});

      ensureGitIgnore();

      expect(spyWrite).toHaveBeenCalledWith(
        expect.stringContaining(".gitignore"),
        ".worktrees/\n",
        "utf-8"
      );
    });

    it("should append .worktrees/ to .gitignore if missing", () => {
      const spyExists = vi.spyOn(fs, "existsSync").mockReturnValue(true);
      const spyRead = vi.spyOn(fs, "readFileSync").mockReturnValue("node_modules/\n");
      const spyAppend = vi.spyOn(fs, "appendFileSync").mockImplementation(() => {});

      ensureGitIgnore();

      expect(spyAppend).toHaveBeenCalledWith(
        expect.stringContaining(".gitignore"),
        "\n.worktrees/\n",
        "utf-8"
      );
    });

    it("should not append if already present", () => {
      const spyExists = vi.spyOn(fs, "existsSync").mockReturnValue(true);
      const spyRead = vi.spyOn(fs, "readFileSync").mockReturnValue("node_modules/\n.worktrees/\n");
      const spyAppend = vi.spyOn(fs, "appendFileSync").mockImplementation(() => {});

      ensureGitIgnore();

      expect(spyAppend).not.toHaveBeenCalled();
    });
  });

  describe("setupWorkspaceForSession", () => {
    it("should call git worktree add and create symlink for node_modules", async () => {
      const rootNodeModules = path.join(process.cwd(), "node_modules");
      const spyExists = vi.spyOn(fs, "existsSync").mockImplementation((p) => {
        if (typeof p === "string") {
          const normalizedPath = path.normalize(p).replace(/\\/g, "/");
          const normalizedRoot = path.normalize(rootNodeModules).replace(/\\/g, "/");
          if (normalizedPath === normalizedRoot) return true;
        }
        return false;
      });
      const spyMkdir = vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
      const spySymlink = vi.spyOn(fs.promises, "symlink").mockResolvedValue(undefined as any);

      const result = await setupWorkspaceForSession("session-1", "feature");

      expect(execa).toHaveBeenCalledWith(
        "git",
        ["worktree", "add", expect.stringContaining("session-1"), "-b", "multi-agent/session-1-feature"],
        expect.any(Object)
      );

      expect(spySymlink).toHaveBeenCalled();
      expect(result.branchName).toBe("multi-agent/session-1-feature");
      expect(result.workspacePath).toContain("session-1");
    });
  });

  describe("cleanupWorkspaceForSession", () => {
    it("should remove worktree and branch", async () => {
      const spyExists = vi.spyOn(fs, "existsSync").mockReturnValue(true);

      await cleanupWorkspaceForSession("session-1", "multi-agent/session-1-feature");

      expect(execa).toHaveBeenCalledWith(
        "git",
        ["worktree", "remove", expect.stringContaining("session-1"), "--force"],
        expect.any(Object)
      );

      expect(execa).toHaveBeenCalledWith(
        "git",
        ["branch", "-D", "multi-agent/session-1-feature"],
        expect.any(Object)
      );
    });
  });

  describe("pruneWorktrees", () => {
    it("should call git worktree prune", async () => {
      const { pruneWorktrees } = await import("../src/core/workspaceIsolation.js");
      await pruneWorktrees();
      expect(execa).toHaveBeenCalledWith("git", ["worktree", "prune"], expect.any(Object));
    });
  });
});

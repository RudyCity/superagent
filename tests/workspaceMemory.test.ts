import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { getNormalizedProjectPath } from "../src/core/tools/helpers.js";
import { saveSharedMemoryTool, readSharedMemoryTool } from "../src/core/tools/sharedMemoryTools.js";
import {
  saveWorkspaceSummary,
  readWorkspaceSummary,
  getProjectHash,
} from "../src/core/workspaceSummary.js";

describe("Workspace Memory Enhancements", () => {
  const testDir = path.join(os.tmpdir(), "superagent-memory-test-" + Date.now());
  const mainRepoDir = path.join(testDir, "main-repo");
  const worktreeDir = path.join(testDir, "worktree-1");

  beforeEach(() => {
    fs.mkdirSync(mainRepoDir, { recursive: true });
    fs.mkdirSync(worktreeDir, { recursive: true });

    // Setup git structure for main repo
    fs.mkdirSync(path.join(mainRepoDir, ".git"), { recursive: true });

    // Setup worktree .git file pointing to main repo
    const gitfilePath = path.join(worktreeDir, ".git");
    const fakeGitDir = path.join(mainRepoDir, ".git", "worktrees", "worktree-1");
    fs.mkdirSync(fakeGitDir, { recursive: true });
    fs.writeFileSync(gitfilePath, `gitdir: ${fakeGitDir}\n`, "utf-8");
  });

  afterEach(() => {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  describe("Worktree Path Normalization", () => {
    it("should resolve main repo directory when in a git worktree", () => {
      const normalized = getNormalizedProjectPath(worktreeDir);
      expect(path.resolve(normalized)).toBe(path.resolve(mainRepoDir));
    });

    it("should return the original directory when in a standard repo", () => {
      const normalized = getNormalizedProjectPath(mainRepoDir);
      expect(path.resolve(normalized)).toBe(path.resolve(mainRepoDir));
    });
  });

  describe("Shared Memory Tool Reading & Filtering", () => {
    it("should save and filter shared memory by project scope vs global scope", async () => {
      const saveResGlobal = await saveSharedMemoryTool.execute(
        { key: "global-pref", value: "use vitest", scope: "global" },
        mainRepoDir
      );
      expect(saveResGlobal).toContain("Successfully saved memory");

      const saveResProject = await saveSharedMemoryTool.execute(
        { key: "project-secret", value: "db-port-5432", scope: "project" },
        mainRepoDir
      );
      expect(saveResProject).toContain("Successfully saved memory");

      // Read memories for main repo
      const readProject = await readSharedMemoryTool.execute({ scope: "project" }, mainRepoDir);
      expect(readProject).toContain("project-secret");

      const readGlobal = await readSharedMemoryTool.execute({ scope: "global" }, mainRepoDir);
      expect(readGlobal).toContain("global-pref");
    });
  });

  describe("Workspace Summary Auto-Indexing", () => {
    it("should compute stable project hash and save/read summary", () => {
      const hash1 = getProjectHash(getNormalizedProjectPath(mainRepoDir));
      const hash2 = getProjectHash(getNormalizedProjectPath(worktreeDir));
      expect(hash1).toBe(hash2); // normalized worktree shares project hash

      const saved = saveWorkspaceSummary(
        {
          summary: "Refactored memory architecture.",
          keyFiles: ["src/core/tools/sharedMemoryTools.ts"],
        },
        mainRepoDir
      );

      expect(saved.summary).toBe("Refactored memory architecture.");

      const read = readWorkspaceSummary(worktreeDir); // Reading from worktree returns normalized main repo summary
      expect(read?.summary).toBe("Refactored memory architecture.");
      expect(read?.keyFiles).toContain("src/core/tools/sharedMemoryTools.ts");
    });
  });
});

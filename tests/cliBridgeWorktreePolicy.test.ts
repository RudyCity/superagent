import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { shouldCreateDirectDelegateWorktree } from "../src/core/tools/cliBridgeDelegateJobs.js";
import { getRoleProfile } from "../src/core/tools/cliBridgeRoleProfiles.js";
import { createDagGraph } from "../src/core/tools/cliBridgeDag.js";
import {
  assessAutomaticWorktreeCleanup,
  createIsolatedWorktree,
  removeIsolatedWorktree,
} from "../src/core/tools/cliBridgeWorktreeManager.js";

describe("CLI Bridge worktree opt-in and lossless cleanup", () => {
  it("does not create a worktree by default for direct coder/tester delegation", () => {
    expect(getRoleProfile("coder")?.worktreePolicy).toBe("isolated");
    expect(getRoleProfile("tester")?.worktreePolicy).toBe("isolated");
    expect(shouldCreateDirectDelegateWorktree(undefined)).toBe(false);
    expect(shouldCreateDirectDelegateWorktree(false)).toBe(false);
    expect(shouldCreateDirectDelegateWorktree(true)).toBe(true);
  });

  it("retains role isolation for parallel DAG tasks unless overridden", () => {
    const graph = createDagGraph({
      name: "parallel isolation",
      workspaceRoot: process.cwd(),
      nodes: [
        { id: "coder", roleId: "coder", prompt: "Implement A" },
        { id: "tester", roleId: "tester", prompt: "Test B" },
        { id: "reviewer", roleId: "reviewer", prompt: "Review" },
        { id: "explicit", roleId: "coder", prompt: "In place", worktree: false },
      ],
    });
    expect(graph.nodes.coder.worktree).toBe(true);
    expect(graph.nodes.tester.worktree).toBe(true);
    expect(graph.nodes.reviewer.worktree).toBe(false);
    expect(graph.nodes.explicit.worktree).toBe(false);
  });
});

describe("Automatic worktree cleanup preserves all unfinished work", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "superagent-safe-worktree-"));
  const repoRoot = path.join(tmp, "repo");
  const worktreePath = path.join(tmp, "worktree");
  const branchName = "probe-safe-cleanup";
  let created = false;

  async function git(args: string[], cwd = repoRoot) {
    return execa("git", args, { cwd });
  }

  afterAll(async () => {
    if (created) {
      await removeIsolatedWorktree({
        repoRoot, worktreePath, branchName, force: true, deleteBranch: true,
      }).catch(() => {});
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("refuses main, dirty, ignored, untracked, and unmerged work; permits merged clean work", async () => {
    fs.mkdirSync(repoRoot, { recursive: true });
    await git(["init", "-b", "main"]);
    await git(["config", "user.name", "SuperAgent Test"]);
    await git(["config", "user.email", "test@superagent.local"]);
    fs.writeFileSync(path.join(repoRoot, ".gitignore"), "ignored-output.txt\n");
    fs.writeFileSync(path.join(repoRoot, "README.md"), "initial\n");
    await git(["add", "."]);
    await git(["commit", "-m", "initial"]);

    await createIsolatedWorktree({ repoRoot, branchName, targetDir: worktreePath, linkNodeModules: false });
    created = true;

    expect((await assessAutomaticWorktreeCleanup({ repoRoot, worktreePath: repoRoot })).safe).toBe(false);
    expect((await assessAutomaticWorktreeCleanup({ repoRoot, worktreePath })).safe).toBe(true);

    fs.writeFileSync(path.join(worktreePath, "new.txt"), "untracked");
    expect((await assessAutomaticWorktreeCleanup({ repoRoot, worktreePath })).reason).toMatch(/untracked changes/);
    await expect(removeIsolatedWorktree({
      repoRoot, worktreePath, branchName, force: false,
    })).rejects.toThrow(/refused worktree removal/);
    expect(fs.readFileSync(path.join(worktreePath, "new.txt"), "utf-8")).toBe("untracked");

    fs.rmSync(path.join(worktreePath, "new.txt"));
    fs.writeFileSync(path.join(worktreePath, "ignored-output.txt"), "important output");
    expect((await assessAutomaticWorktreeCleanup({ repoRoot, worktreePath })).reason).toMatch(/ignored or generated artifacts/);
    fs.rmSync(path.join(worktreePath, "ignored-output.txt"));

    fs.writeFileSync(path.join(worktreePath, "README.md"), "modified but not committed\n");
    expect((await assessAutomaticWorktreeCleanup({ repoRoot, worktreePath })).safe).toBe(false);
    await git(["add", "README.md"], worktreePath);
    await git(["commit", "-m", "worktree-only commit"], worktreePath);
    expect((await assessAutomaticWorktreeCleanup({ repoRoot, worktreePath })).reason).toMatch(/not integrated into local main/);

    await git(["merge", "--ff-only", branchName]);
    expect((await assessAutomaticWorktreeCleanup({ repoRoot, worktreePath })).safe).toBe(true);
    await removeIsolatedWorktree({ repoRoot, worktreePath, branchName, force: false, deleteBranch: true });
    created = false;
    expect(fs.existsSync(worktreePath)).toBe(false);
  }, 30000);
});

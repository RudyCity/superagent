import { describe, it, expect, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { execa } from "execa";
import {
  createIsolatedWorktree,
  listIsolatedWorktrees,
  removeIsolatedWorktree,
  getWorktreeCommitProvenance,
  type WorktreeMetadata,
} from "../src/core/tools/cliBridgeWorktreeManager.js";

describe("Milestone M1.7 & M3 — Isolated Git Worktree Manager", () => {
  const repoRoot = path.resolve(process.cwd());
  const tempBase = path.join(os.tmpdir(), `superagent-worktree-test-${Date.now()}`);
  const activeWorktrees: WorktreeMetadata[] = [];

  afterAll(async () => {
    // Teardown any remaining worktrees and branches
    for (const wt of activeWorktrees) {
      try {
        await removeIsolatedWorktree({
          repoRoot,
          worktreePath: wt.worktreePath,
          branchName: wt.branchName,
          force: true,
          deleteBranch: true,
        });
      } catch {
        // ignore teardown errors
      }
    }
    try {
      fs.rmSync(tempBase, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("lists existing worktrees including the main repository", async () => {
    const worktrees = await listIsolatedWorktrees(repoRoot);
    expect(worktrees.length).toBeGreaterThanOrEqual(1);
    const mainWt = worktrees.find((w) => path.resolve(w.worktreePath).toLowerCase() === repoRoot.toLowerCase());
    expect(mainWt).toBeDefined();
    expect(mainWt?.headSha).toBeDefined();
  });

  it("creates an isolated worktree from pinned base commit SHA", async () => {
    const headRes = await execa("git", ["rev-parse", "HEAD"], { cwd: repoRoot });
    const pinnedBaseSha = headRes.stdout.trim();

    const branchName = `test-probe-single-${Date.now()}`;
    const targetDir = path.join(tempBase, "single-probe");

    const wt = await createIsolatedWorktree({
      repoRoot,
      baseCommitSha: pinnedBaseSha,
      branchName,
      targetDir,
      linkNodeModules: false,
    });

    activeWorktrees.push(wt);

    expect(wt.worktreePath).toBe(path.resolve(targetDir));
    expect(wt.baseCommitSha).toBe(pinnedBaseSha);
    expect(wt.branchName).toBe(branchName);
    expect(fs.existsSync(targetDir)).toBe(true);

    const provenance = await getWorktreeCommitProvenance(wt.worktreePath, pinnedBaseSha);
    expect(provenance.headSha).toBe(pinnedBaseSha);
    expect(provenance.branchName).toBe(branchName);
    expect(provenance.commitCount).toBe(0);
    expect(provenance.isClean).toBe(true);

    // Teardown single worktree
    await removeIsolatedWorktree({
      repoRoot,
      worktreePath: wt.worktreePath,
      branchName: wt.branchName,
      force: true,
      deleteBranch: true,
    });
    expect(fs.existsSync(targetDir)).toBe(false);
  }, 20000);

  it("runs four isolated Git-worktree coding probes concurrently without shared-workspace mutation", async () => {
    const headRes = await execa("git", ["rev-parse", "HEAD"], { cwd: repoRoot });
    const pinnedBaseSha = headRes.stdout.trim();

    const timestamp = Date.now();
    const workerConfigs = [
      { id: "alpha", file: "src/probe_alpha.txt", content: "PROBE_ALPHA_SUCCESS" },
      { id: "beta", file: "src/probe_beta.txt", content: "PROBE_BETA_SUCCESS" },
      { id: "gamma", file: "src/probe_gamma.txt", content: "PROBE_GAMMA_SUCCESS" },
      { id: "delta", file: "src/probe_delta.txt", content: "PROBE_DELTA_SUCCESS" },
    ];

    // 1. Create four distinct worktrees concurrently from the pinned base SHA
    const createdWorktrees = await Promise.all(
      workerConfigs.map((cfg) =>
        createIsolatedWorktree({
          repoRoot,
          baseCommitSha: pinnedBaseSha,
          branchName: `probe-m17-${cfg.id}-${timestamp}`,
          targetDir: path.join(tempBase, `probe-${cfg.id}-${timestamp}`),
          linkNodeModules: false,
        })
      )
    );

    for (const wt of createdWorktrees) {
      activeWorktrees.push(wt);
    }

    expect(createdWorktrees).toHaveLength(4);

    // Verify all 4 worktrees appear in git worktree list
    const worktreeList = await listIsolatedWorktrees(repoRoot);
    for (const wt of createdWorktrees) {
      const found = worktreeList.find(
        (w) => path.resolve(w.worktreePath).toLowerCase() === path.resolve(wt.worktreePath).toLowerCase()
      );
      expect(found).toBeDefined();
      expect(found?.headSha).toBe(pinnedBaseSha);
    }

    // 2. Perform non-overlapping edits and commits concurrently in each worktree
    const commitResults = await Promise.all(
      createdWorktrees.map(async (wt, idx) => {
        const cfg = workerConfigs[idx];
        const filePath = path.join(wt.worktreePath, cfg.file);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, `${cfg.content} at ${new Date().toISOString()}`, "utf-8");

        // Verify the file was written ONLY in this worktree, NOT in the main repo
        expect(fs.existsSync(filePath)).toBe(true);
        expect(fs.existsSync(path.join(repoRoot, cfg.file))).toBe(false);

        // Commit change inside the worktree
        await execa("git", ["add", cfg.file], { cwd: wt.worktreePath });
        await execa("git", ["commit", "-m", `probe(${cfg.id}): autonomous worktree modification`], {
          cwd: wt.worktreePath,
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: "SuperAgent Probe",
            GIT_AUTHOR_EMAIL: "probe@superagent.local",
            GIT_COMMITTER_NAME: "SuperAgent Probe",
            GIT_COMMITTER_EMAIL: "probe@superagent.local",
          },
        });

        // Inspect commit provenance
        const provenance = await getWorktreeCommitProvenance(wt.worktreePath, pinnedBaseSha);
        return {
          workerId: cfg.id,
          worktree: wt,
          provenance,
        };
      })
    );

    // 3. Verify each worker produced an independent commit with distinct SHA
    const commitShas = new Set<string>();
    for (const res of commitResults) {
      expect(res.provenance.commitCount).toBe(1);
      expect(res.provenance.isClean).toBe(true);
      expect(res.provenance.headSha).not.toBe(pinnedBaseSha);
      expect(commitShas.has(res.provenance.headSha)).toBe(false);
      commitShas.add(res.provenance.headSha);
    }
    expect(commitShas.size).toBe(4);

    // 4. Verify main repository is completely unmutated
    for (const cfg of workerConfigs) {
      expect(fs.existsSync(path.join(repoRoot, cfg.file))).toBe(false);
    }

    // 5. Clean teardown of all 4 worktrees and branches
    for (const wt of createdWorktrees) {
      await removeIsolatedWorktree({
        repoRoot,
        worktreePath: wt.worktreePath,
        branchName: wt.branchName,
        force: true,
        deleteBranch: true,
      });
      expect(fs.existsSync(wt.worktreePath)).toBe(false);
    }

    // Verify worktrees were removed from git
    const finalList = await listIsolatedWorktrees(repoRoot);
    for (const wt of createdWorktrees) {
      const found = finalList.find(
        (w) => path.resolve(w.worktreePath).toLowerCase() === path.resolve(wt.worktreePath).toLowerCase()
      );
      expect(found).toBeUndefined();
    }
  }, 45000);
});

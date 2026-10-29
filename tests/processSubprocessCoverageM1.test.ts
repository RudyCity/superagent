import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { getProcessSupervisor, resetProcessSupervisorForTest } from "../src/core/process/processSupervisor.js";
import { executeHookCommand } from "../src/core/tools/dynamicHooks.js";
import { createIsolatedWorktree, removeIsolatedWorktree } from "../src/core/tools/cliBridgeWorktreeManager.js";
import { execa } from "execa";

describe("P0 M1 Subprocess Registration Coverage & Splash Elimination", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sp-subproc-cov-"));
    resetProcessSupervisorForTest();
    const sup = getProcessSupervisor({ storagePath: path.join(tmpDir, "proc-reg.json") });
    await sup.initialize();
  });

  afterEach(async () => {
    resetProcessSupervisorForTest();
    // Bun/Windows can retain the SQLite coordination file handle until the
    // test process exits.  Any OTHER leftover file is a real teardown failure.
    try {
      await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 15, retryDelay: 150 });
    } catch (error: any) {
      if (error?.code !== "EBUSY") throw error;
      const remaining = await fs.readdir(tmpDir);
      if (remaining.length === 0 || remaining.some((name) =>
        name !== "proc-reg.json.coordination.sqlite" &&
        name !== "proc-reg.json.coordination.sqlite-journal" && name !== "proc-reg.json")) {
        throw error;
      }
      // Only the OS-managed coordination DB remains; cleanup occurs after this
      // test process exits and Windows releases its SQLite file handle.
    }
  });

  it("1. dynamicHooks.executeHookCommand registers process headlessly and records exit observation", async () => {
    const sup = getProcessSupervisor();
    const result = await executeHookCommand("node -e \"process.stdout.write('hook-ok')\"", tmpDir);
    expect(result.stdout).toBe("hook-ok");
    expect(result.exitCode).toBe(0);

    const records = sup.getRegistry().listRecords();
    const hookRecord = records.find((r) => r.component === "dynamic_hook");
    expect(hookRecord).toBeDefined();
    expect(hookRecord?.launchIntent).toBe("headless");
    expect(hookRecord?.lifecycle).toBe("ephemeral");
    expect(hookRecord?.cleanupPolicy).toBe("caller_owned");
    expect(hookRecord?.state).toBe("exited");
    expect(hookRecord?.exitCode).toBe(0);
  });

  it("2. cliBridgeWorktreeManager worktree creation and removal registers git_worktree headlessly", async () => {
    // Initialize a tiny git repo in tmpDir
    const repoRoot = path.join(tmpDir, "repo");
    await fs.mkdir(repoRoot, { recursive: true });
    await execa("git", ["init"], { cwd: repoRoot, windowsHide: true });
    await execa("git", ["config", "user.email", "test@superagent.internal"], { cwd: repoRoot, windowsHide: true });
    await execa("git", ["config", "user.name", "Test Agent"], { cwd: repoRoot, windowsHide: true });
    await fs.writeFile(path.join(repoRoot, "README.md"), "# Test Repo\n", "utf8");
    await execa("git", ["add", "README.md"], { cwd: repoRoot, windowsHide: true });
    await execa("git", ["commit", "-m", "init"], { cwd: repoRoot, windowsHide: true });

    const sup = getProcessSupervisor();

    // Create isolated worktree
    const meta = await createIsolatedWorktree({
      repoRoot,
      branchName: "feat/test-coverage",
      linkNodeModules: false,
    });
    expect(meta.worktreePath).toBeDefined();

    let records = sup.getRegistry().listRecords();
    const createRecord = records.find((r) => r.component === "git_worktree" && r.sanitizedArgs.includes("add"));
    expect(createRecord).toBeDefined();
    expect(createRecord?.launchIntent).toBe("headless");
    expect(createRecord?.lifecycle).toBe("ephemeral");
    expect(createRecord?.cleanupPolicy).toBe("caller_owned");

    // Remove isolated worktree
    await removeIsolatedWorktree({
      repoRoot,
      worktreePath: meta.worktreePath,
      branchName: meta.branchName,
      deleteBranch: true,
    });

    records = sup.getRegistry().listRecords();
    const removeRecord = records.find((r) => r.component === "git_worktree" && r.sanitizedArgs.includes("remove"));
    expect(removeRecord).toBeDefined();
    expect(removeRecord?.launchIntent).toBe("headless");
    expect(removeRecord?.lifecycle).toBe("ephemeral");
  });

  it("3. Source code audit: all new subprocess spawn sites enforce windowsHide: true or launchIntent: headless", async () => {
    const filesToAudit = [
      "src/core/tools/dynamicHooks.ts",
      "src/core/tools/cliBridgeWorktreeManager.ts",
      "src/core/runtime/museWatchdogSupervisor.ts",
      "src/core/runtime/mcpOwnerLifecycle.ts",
      "src/core/runtime/coreSupervisor.ts",
      "src/core/senopatiLifecycle.ts",
    ];

    for (const relPath of filesToAudit) {
      const fullPath = path.resolve(relPath);
      const content = await fs.readFile(fullPath, "utf8");
      // Must contain registration with supervisor or headless intent
      expect(content).toContain("getProcessSupervisor");
      // Must enforce windowsHide: true or headless intent
      const hasHeadless = content.includes('windowsHide: true') ||
                          content.includes('windowsHide:true') ||
                          content.includes('"headless"') ||
                          content.includes("'headless'");
      expect(hasHeadless).toBe(true);
    }
  });

  it("4. No leaked descendant test: ephemeral subprocesses terminate cleanly with exitCode observed", async () => {
    const sup = getProcessSupervisor();
    // Run two consecutive dynamic hook calls
    const res1 = await executeHookCommand("node -e \"process.stdout.write('run-1')\"", tmpDir);
    const res2 = await executeHookCommand("node -e \"process.stdout.write('run-2')\"", tmpDir);
    expect(res1.stdout).toBe("run-1");
    expect(res2.stdout).toBe("run-2");

    const records = sup.getRegistry().listRecords();
    const hookRecords = records.filter((r) => r.component === "dynamic_hook");
    expect(hookRecords.length).toBeGreaterThanOrEqual(2);
    for (const hr of hookRecords) {
      expect(hr.state).toBe("exited");
      expect(hr.exitCode).toBe(0);
    }
  });
});

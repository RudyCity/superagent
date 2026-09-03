import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import {
  resolveArtifactPaths,
  buildArtifactContextBlock,
  summarizeTaskChecklist,
} from "../src/core/tools/cliBridgeArtifacts.js";
import { cliBridgeTool } from "../src/core/tools/cliBridgeTool.js";

describe("CLI Bridge Artifact Path Injection", () => {
  const testDir = path.join(os.tmpdir(), `superagent_cli_bridge_test_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);

  beforeEach(() => {
    fs.mkdirSync(testDir, { recursive: true });
    delete process.env.SUPERAGENT_SESSION_PATH;
  });

  afterEach(() => {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
    delete process.env.SUPERAGENT_SESSION_PATH;
  });

  it("auto-detects task.md, plan.md, and walkthrough.md in cwd", () => {
    const taskFile = path.join(testDir, "task.md");
    const planFile = path.join(testDir, "plan.md");
    const walkthroughFile = path.join(testDir, "walkthrough.md");

    fs.writeFileSync(taskFile, "- [ ] Task 1\n- [ ] Task 2");
    fs.writeFileSync(planFile, "# My Plan");
    fs.writeFileSync(walkthroughFile, "# Walkthrough");

    const paths = resolveArtifactPaths(testDir);
    expect(paths.taskPath).toBe(taskFile);
    expect(paths.taskExists).toBe(true);
    expect(paths.planPath).toBe(planFile);
    expect(paths.planExists).toBe(true);
    expect(paths.walkthroughPath).toBe(walkthroughFile);
    expect(paths.walkthroughExists).toBe(true);

    const block = buildArtifactContextBlock(paths);
    expect(block).not.toBeNull();
    expect(block).toContain("=== ACTIVE PROJECT ARTIFACTS ===");
    expect(block).toContain(`- Task Checklist: ${taskFile} [Existing file - please update]`);
    expect(block).toContain(`- Implementation Plan: ${planFile} [Existing file - please review]`);
    expect(block).toContain(`- Walkthrough Document: ${walkthroughFile} [Existing file - please append]`);
    expect(block).toContain("• Mark in-progress tasks with ' [/] '");
    expect(block).toContain("• Mark completed tasks with ' [x] '");
  });

  it("prioritizes explicit overrides over auto-detected files", () => {
    const defaultTask = path.join(testDir, "task.md");
    const customTask = path.join(testDir, "custom_tasks.md");
    fs.writeFileSync(defaultTask, "default");
    fs.writeFileSync(customTask, "custom");

    const paths = resolveArtifactPaths(testDir, {
      taskPath: customTask,
    });
    expect(paths.taskPath).toBe(customTask);
    expect(paths.taskExists).toBe(true);
  });

  it("falls back to session path artifacts if workspace lacks artifact files", () => {
    const sessionBase = path.join(testDir, "sess_12345");
    const sessionJson = `${sessionBase}.json`;
    const sessionTask = `${sessionBase}_task.md`;
    const sessionPlan = `${sessionBase}_implementation_plan.md`;

    fs.writeFileSync(sessionJson, "{}");
    fs.writeFileSync(sessionTask, "- [ ] Session Task");
    fs.writeFileSync(sessionPlan, "# Session Plan");

    process.env.SUPERAGENT_SESSION_PATH = sessionJson;

    const emptySubdir = path.join(testDir, "subdir");
    fs.mkdirSync(emptySubdir, { recursive: true });

    const paths = resolveArtifactPaths(emptySubdir, { provideDefaultTargets: false });
    expect(paths.taskPath).toBe(sessionTask);
    expect(paths.taskExists).toBe(true);
    expect(paths.planPath).toBe(sessionPlan);
    expect(paths.planExists).toBe(true);
    expect(paths.walkthroughPath).toBeUndefined();
  });

  it("provides default creation targets when no files exist yet on disk", () => {
    const emptyDir = path.join(testDir, "empty");
    fs.mkdirSync(emptyDir, { recursive: true });

    const paths = resolveArtifactPaths(emptyDir);
    expect(paths.taskPath).toBe(path.join(emptyDir, "task.md"));
    expect(paths.taskExists).toBe(false);
    expect(paths.planPath).toBe(path.join(emptyDir, "plan.md"));
    expect(paths.planExists).toBe(false);
    expect(paths.walkthroughPath).toBe(path.join(emptyDir, "walkthrough.md"));
    expect(paths.walkthroughExists).toBe(false);

    const block = buildArtifactContextBlock(paths);
    expect(block).not.toBeNull();
    expect(block).toContain("[Target file - create if needed]");
  });

  it("returns null block when provideDefaultTargets is false and no files exist", () => {
    const emptyDir = path.join(testDir, "empty2");
    fs.mkdirSync(emptyDir, { recursive: true });

    const paths = resolveArtifactPaths(emptyDir, { provideDefaultTargets: false });
    expect(paths.taskPath).toBeUndefined();
    expect(paths.planPath).toBeUndefined();
    expect(paths.walkthroughPath).toBeUndefined();

    const block = buildArtifactContextBlock(paths);
    expect(block).toBeNull();
  });

  it("summarizes task checklist completion status correctly", () => {
    const taskFile = path.join(testDir, "task.md");
    fs.writeFileSync(
      taskFile,
      "- [x] Design schema\n- [X] Write tests\n- [/] Implement handler\n- [ ] Deploy to prod\n- [ ] Verify metrics"
    );

    const summary = summarizeTaskChecklist(taskFile);
    expect(summary).not.toBeNull();
    expect(summary?.completed).toBe(2);
    expect(summary?.inProgress).toBe(1);
    expect(summary?.pending).toBe(2);
    expect(summary?.total).toBe(5);
    expect(summary?.formatted).toBe("Task Checklist: 2/5 completed, 1 in progress, 2 pending");
  });
});

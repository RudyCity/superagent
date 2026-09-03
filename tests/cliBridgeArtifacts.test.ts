import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import {
  resolveArtifactPaths,
  buildArtifactContextBlock,
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
    expect(paths.planPath).toBe(planFile);
    expect(paths.walkthroughPath).toBe(walkthroughFile);

    const block = buildArtifactContextBlock(paths);
    expect(block).not.toBeNull();
    expect(block).toContain("=== ACTIVE PROJECT ARTIFACTS ===");
    expect(block).toContain(`- Task Checklist: ${taskFile}`);
    expect(block).toContain(`- Implementation Plan: ${planFile}`);
    expect(block).toContain(`- Walkthrough Document: ${walkthroughFile}`);
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

    const paths = resolveArtifactPaths(emptySubdir);
    expect(paths.taskPath).toBe(sessionTask);
    expect(paths.planPath).toBe(sessionPlan);
    expect(paths.walkthroughPath).toBeUndefined();
  });

  it("returns null block when no artifacts exist", () => {
    const emptyDir = path.join(testDir, "empty");
    fs.mkdirSync(emptyDir, { recursive: true });

    const paths = resolveArtifactPaths(emptyDir);
    expect(paths.taskPath).toBeUndefined();
    expect(paths.planPath).toBeUndefined();
    expect(paths.walkthroughPath).toBeUndefined();

    const block = buildArtifactContextBlock(paths);
    expect(block).toBeNull();
  });
});

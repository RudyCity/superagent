import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import os from "os";
import fs from "fs";
import {
  getWatchedWorkspaces,
  addWatchedWorkspace,
  removeWatchedWorkspace,
  setWatchedWorkspaces,
  loadRemoteAgentConfig,
  saveRemoteAgentConfig,
} from "../src/core/remoteAgent/config.js";
import { isMuseOutOfBounds } from "../src/core/permissions.js";
import {
  findMatchingWorkspace,
  resolveCallWorkspace,
  executeBatch,
} from "../src/core/remoteAgent/batchExecutor.js";
import { MuseWatcher } from "../src/core/remoteAgent/museWatcher.js";

describe("Muse Multi-Project Watch Mode", () => {
  let tmpConfigDir: string;
  let tmpConfigFile: string;
  let projectA: string;
  let projectB: string;
  let projectC: string;

  beforeEach(() => {
    tmpConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "muse-multi-test-"));
    tmpConfigFile = path.join(tmpConfigDir, "remote-agent.json");

    projectA = path.join(tmpConfigDir, "project-alpha");
    projectB = path.join(tmpConfigDir, "project-beta");
    projectC = path.join(tmpConfigDir, "project-gamma");

    fs.mkdirSync(projectA, { recursive: true });
    fs.mkdirSync(projectB, { recursive: true });
    fs.mkdirSync(projectC, { recursive: true });

    saveRemoteAgentConfig(
      {
        botToken: "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11",
        groupId: -1001234567890,
        museBotId: 987654321,
        defaultWorkspace: projectA,
        workspaces: [projectA, projectB],
      },
      tmpConfigFile
    );
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpConfigDir, { recursive: true, force: true });
    } catch {}
  });

  describe("Configuration & Workspace Management", () => {
    it("should retrieve normalized list of all watched workspaces", () => {
      const cfg = loadRemoteAgentConfig(tmpConfigFile);
      const watched = getWatchedWorkspaces(cfg);

      expect(watched).toHaveLength(2);
      expect(watched).toContain(path.resolve(projectA));
      expect(watched).toContain(path.resolve(projectB));
    });

    it("should add a new watched workspace dynamically and persist", () => {
      const updated = addWatchedWorkspace(projectC, tmpConfigFile);
      expect(updated.workspaces).toHaveLength(3);
      expect(updated.workspaces).toContain(path.resolve(projectC));

      const reloaded = loadRemoteAgentConfig(tmpConfigFile);
      expect(reloaded.workspaces).toContain(path.resolve(projectC));
    });

    it("should remove a watched workspace and update defaultWorkspace if needed", () => {
      const updated = removeWatchedWorkspace(projectA, tmpConfigFile);
      expect(updated.workspaces).toHaveLength(1);
      expect(updated.workspaces).not.toContain(path.resolve(projectA));
      expect(updated.workspaces).toContain(path.resolve(projectB));
      expect(updated.defaultWorkspace).toBe(path.resolve(projectB));
    });

    it("should overwrite all watched workspaces using setWatchedWorkspaces", () => {
      const updated = setWatchedWorkspaces([projectB, projectC], tmpConfigFile);
      expect(updated.workspaces).toEqual([path.resolve(projectB), path.resolve(projectC)]);
      expect(updated.defaultWorkspace).toBe(path.resolve(projectB));
    });
  });

  describe("Permission Checks (isMuseOutOfBounds) Across Multiple Workspaces", () => {
    it("should permit tool calls targeting files in Project A when watching both A and B", () => {
      const fileInA = path.join(projectA, "src", "index.ts");
      const check = isMuseOutOfBounds(
        { name: "read", args: { filePath: fileInA } },
        [projectA, projectB]
      );
      expect(check.isOutOfBounds).toBe(false);
    });

    it("should permit tool calls targeting files in Project B when watching both A and B", () => {
      const fileInB = path.join(projectB, "package.json");
      const check = isMuseOutOfBounds(
        { name: "write", args: { filePath: fileInB } },
        [projectA, projectB]
      );
      expect(check.isOutOfBounds).toBe(false);
    });

    it("should reject tool calls targeting files outside both Project A and Project B", () => {
      const outsideFile = path.join(os.tmpdir(), "random-secret.txt");
      const check = isMuseOutOfBounds(
        { name: "read", args: { filePath: outsideFile } },
        [projectA, projectB]
      );
      expect(check.isOutOfBounds).toBe(true);
      expect(check.reason).toContain("outside all watched workspaces");
    });

    it("should permit shell commands executing in Project B directory", () => {
      const check = isMuseOutOfBounds(
        { name: "run_command", args: { command: "git status", cwd: projectB } },
        [projectA, projectB]
      );
      expect(check.isOutOfBounds).toBe(false);
    });
  });

  describe("Batch Workspace Resolution & Routing", () => {
    it("should match workspace by exact path, basename, or partial name", () => {
      const list = [projectA, projectB];

      expect(findMatchingWorkspace(projectA, list)).toBe(projectA);
      expect(findMatchingWorkspace("project-beta", list)).toBe(projectB);
      expect(findMatchingWorkspace("alpha", list)).toBe(projectA);
      expect(findMatchingWorkspace("non-existent", list)).toBeUndefined();
    });

    it("should route tool call based on explicit tool args workspace or project", () => {
      const call = {
        id: "c1",
        tool: "run_command",
        args: { project: "project-beta", command: "npm test" },
      };
      const resolved = resolveCallWorkspace(
        call,
        { workspace: projectA, workspaces: [projectA, projectB] },
        projectA
      );
      expect(resolved).toBe(projectB);
    });

    it("should route tool call based on batch-level target workspace", () => {
      const call = {
        id: "c2",
        tool: "read",
        args: { filePath: "src/main.ts" },
      };
      const resolved = resolveCallWorkspace(
        call,
        {
          workspace: projectA,
          workspaces: [projectA, projectB],
          batchProject: "project-beta",
        },
        projectA
      );
      expect(resolved).toBe(projectB);
    });

    it("should route tool call based on candidate filePath belonging to Project B", () => {
      const fileInB = path.join(projectB, "src", "config.ts");
      const call = {
        id: "c3",
        tool: "read",
        args: { filePath: fileInB },
      };
      const resolved = resolveCallWorkspace(
        call,
        {
          workspace: projectA,
          workspaces: [projectA, projectB],
        },
        projectA
      );
      expect(resolved).toBe(projectB);
    });
  });

  describe("MuseWatcher Multi-Project Lifecycle", () => {
    it("should initialize with multiple workspaces and report them in getStats", () => {
      const watcher = new MuseWatcher({
        workspaces: [projectA, projectB],
        customConfigPath: tmpConfigFile,
      });

      const stats = watcher.getStats();
      expect(stats.workspaces).toHaveLength(2);
      expect(stats.workspaces).toContain(path.resolve(projectA));
      expect(stats.workspaces).toContain(path.resolve(projectB));
      expect(stats.workspace).toBe(path.resolve(projectA));
    });

    it("should dynamically add and remove workspaces on an active instance", () => {
      const watcher = new MuseWatcher({
        workspaces: [projectA],
        customConfigPath: tmpConfigFile,
      });

      expect(watcher.getWorkspaces()).toHaveLength(1);

      watcher.addWorkspace(projectB);
      expect(watcher.getWorkspaces()).toHaveLength(2);
      expect(watcher.getWorkspaces()).toContain(path.resolve(projectB));

      const removed = watcher.removeWorkspace(projectA);
      expect(removed).toBe(true);
      expect(watcher.getWorkspaces()).toHaveLength(1);
      expect(watcher.getWorkspaces()).toContain(path.resolve(projectB));
    });

    it("should execute tool calls in appropriate project directory during batch execution", async () => {
      fs.writeFileSync(path.join(projectA, "fileA.txt"), "hello from alpha", "utf-8");
      fs.writeFileSync(path.join(projectB, "fileB.txt"), "hello from beta", "utf-8");

      const calls = [
        {
          id: "call_a",
          tool: "read",
          args: { filePath: path.join(projectA, "fileA.txt") },
        },
        {
          id: "call_b",
          tool: "read",
          args: { filePath: path.join(projectB, "fileB.txt") },
        },
      ];

      const results = await executeBatch(calls, {
        workspace: projectA,
        workspaces: [projectA, projectB],
      });

      expect(results).toHaveLength(2);
      expect(results[0].ok).toBe(true);
      expect(results[0].output).toContain("hello from alpha");
      expect(results[1].ok).toBe(true);
      expect(results[1].output).toContain("hello from beta");
    });
  });
});

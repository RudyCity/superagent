import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "path";
import os from "os";
import fs from "fs";
import { Agent } from "../src/core/agent.js";
import { superagentInstances, subagentInstances } from "../src/core/tools/state.js";
import { clearModelConfigCache } from "../src/core/config/jsonConfig.js";

describe("Master Orchestrator - Multi-Tier Delegation", () => {
  const originalEnv = process.env;
  const testConfigDir = path.join(os.tmpdir(), `superagent-orchestrator-test-${process.pid}`);

  beforeEach(() => {
    vi.restoreAllMocks();
    superagentInstances.clear();
    subagentInstances.clear();
    process.env = { ...originalEnv, SUPERAGENT_CONFIG_DIR: testConfigDir };
    clearModelConfigCache();
    try {
      fs.rmSync(testConfigDir, { recursive: true, force: true });
    } catch {}
  });

  afterEach(() => {
    process.env = originalEnv;
    try {
      fs.rmSync(testConfigDir, { recursive: true, force: true });
    } catch {}
  });

  it("should initialize Agent with tier tracking", () => {
    const agent = new Agent({
      workingDirectory: process.cwd(),
      tier: "master",
    });
    expect(agent).toBeDefined();
    expect(agent.isAgentRunning()).toBe(false);
  });

  it("should support tracking subagent instances in shared state", () => {
    subagentInstances.set("sub-1", {
      id: "sub-1",
      type: "coder",
      role: "Component Builder",
      status: "idle",
      createdAt: Date.now(),
    } as any);

    expect(subagentInstances.has("sub-1")).toBe(true);
    expect(subagentInstances.get("sub-1")?.role).toBe("Component Builder");
  });

  it("should track superagent instances in shared state", () => {
    superagentInstances.set("super-1", {
      id: "super-1",
      role: "Feature Lead",
      branch: "feature/auth",
      worktreePath: "/tmp/worktree-auth",
      status: "running",
      createdAt: Date.now(),
    } as any);

    expect(superagentInstances.has("super-1")).toBe(true);
    expect(superagentInstances.get("super-1")?.branch).toBe("feature/auth");
  });
});

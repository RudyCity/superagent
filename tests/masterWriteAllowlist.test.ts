/**
 * Regression tests for the Master Agent write path-allowlist.
 *
 * The Master Agent (tier === "master") MUST NOT directly edit codebase
 * files. It can only write to paths under `~/.superagent-r/` (the local
 * config/session root) where its plan/task/walkthrough artifacts live.
 * Everything else must be delegated to a Superagent.
 *
 * These tests pin the policy at the execute() level so a future refactor
 * that bypasses the allowlist fails CI.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { writeToFileTool, replaceFileContentTool } from "../src/core/tools/fileEditTools.js";
import { enforceMasterWriteAllowlist } from "../src/core/tools/pathHelpers.js";
import { getRootConfigDir } from "../src/core/config/paths.js";
import path from "path";

describe("enforceMasterWriteAllowlist (unit)", () => {
  it("blocks codebase paths for tier=master", () => {
    const cwd = process.cwd();
    const blocked = enforceMasterWriteAllowlist(path.join(cwd, "src", "foo.ts"), "master");
    expect(blocked).toMatch(/cannot directly edit codebase/i);
  });

  it("allows ~/.superagent-r/ for tier=master", () => {
    const root = getRootConfigDir();
    const allowed = enforceMasterWriteAllowlist(
      path.join(root, "history", "single", "plan.md"),
      "master"
    );
    expect(allowed).toBeNull();
  });

  it("does not restrict tier=superagent", () => {
    const cwd = process.cwd();
    expect(enforceMasterWriteAllowlist(path.join(cwd, "src", "foo.ts"), "superagent")).toBeNull();
    expect(enforceMasterWriteAllowlist(path.join(cwd, "src", "foo.ts"), "single")).toBeNull();
  });

  it("does not restrict tier=undefined (legacy callers)", () => {
    const cwd = process.cwd();
    expect(enforceMasterWriteAllowlist(path.join(cwd, "src", "foo.ts"), undefined)).toBeNull();
  });

  it("handles empty/invalid paths gracefully", () => {
    expect(enforceMasterWriteAllowlist("", "master")).toBeNull();
    expect(enforceMasterWriteAllowlist(undefined, "master")).toBeNull();
  });
});

describe("writeToFileTool — Master tier blocks codebase paths", () => {
  it("rejects a write to a src/ path when tier=master", async () => {
    const agentModule = await import("../src/core/agent.js");
    const fakeAgent: any = { tier: "master", sessionId: "test-master", terminalType: "cli" };
    const origGetStore = agentModule.agentLocalStorage.getStore;
    agentModule.agentLocalStorage.getStore = () => fakeAgent;
    try {
      const cwd = process.cwd();
      const target = path.join(cwd, "src", "_test_should_be_blocked.ts");
      const res = await writeToFileTool.execute(
        { filePath: target, content: "test" },
        cwd
      );
      expect(String(res)).toMatch(/Master Agent cannot directly edit codebase/);
    } finally {
      agentModule.agentLocalStorage.getStore = origGetStore;
    }
  });

  it("accepts a write to ~/.superagent-r/ when tier=master", async () => {
    const agentModule = await import("../src/core/agent.js");
    const fakeAgent: any = { tier: "master", sessionId: "test-master", terminalType: "cli" };
    const origGetStore = agentModule.agentLocalStorage.getStore;
    agentModule.agentLocalStorage.getStore = () => fakeAgent;
    try {
      const target = path.join(getRootConfigDir(), "_master_allowlist_test.md");
      const res = await writeToFileTool.execute(
        { filePath: target, content: "# master test\n", overwrite: true },
        process.cwd()
      );
      expect(String(res)).not.toMatch(/cannot directly edit codebase/);
      try { (await import("fs")).unlinkSync(target); } catch {}
    } finally {
      agentModule.agentLocalStorage.getStore = origGetStore;
    }
  });
});

describe("replaceFileContentTool — Master tier blocks codebase paths", () => {
  it("rejects a replace to a src/ path when tier=master", async () => {
    const agentModule = await import("../src/core/agent.js");
    const fakeAgent: any = { tier: "master", sessionId: "test-master", terminalType: "cli" };
    const origGetStore = agentModule.agentLocalStorage.getStore;
    agentModule.agentLocalStorage.getStore = () => fakeAgent;
    try {
      const cwd = process.cwd();
      const target = path.join(cwd, "src", "_test_should_be_blocked.ts");
      const res = await replaceFileContentTool.execute(
        {
          filePath: target,
          targetContent: "x",
          replacementContent: "y",
          startLine: 1,
          endLine: 1,
        },
        cwd
      );
      expect(String(res)).toMatch(/Master Agent cannot directly edit codebase/);
    } finally {
      agentModule.agentLocalStorage.getStore = origGetStore;
    }
  });
});

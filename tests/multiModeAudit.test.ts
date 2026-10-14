import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import * as execaModule from "execa";
import {
  classifyRequest,
  classifyWithSenopatiONNX,
  clearLocalClassifierCache,
  CONTINUATION_COMMANDS,
  getToolsetForCategory,
  isHighConfidenceConversation,
} from "../src/core/requestClassifier.js";
import { masterToolset } from "../src/core/tools/toolsets.js";
import { reconcileRegistry, upsertEntry } from "../src/core/tools/superagentRegistry.js";
import { superagentInstances, subagentInstances } from "../src/core/tools/state.js";
import {
  awaitSuperagentsTool,
  invokeSuperagentTool,
  manageSuperagentsTool,
  mergeSuperagentsTool,
} from "../src/core/tools/superagentTools.js";
import { manageSubagentsTool } from "../src/core/tools/subagentTools.js";
import { multiReplaceFileContentTool } from "../src/core/tools/fileEditTools.js";
import { agentLocalStorage } from "../src/core/agent.js";

describe("Multi-Mode (3-Tier Orchestration) Audit Regressions", () => {
  const isolatedConfigDir = path.join(os.tmpdir(), `superagent-multimode-audit-${process.pid}`);
  let originalConfigDir: string | undefined;

  beforeEach(() => {
    vi.restoreAllMocks();
    clearLocalClassifierCache();
    superagentInstances.clear();
    subagentInstances.clear();
    originalConfigDir = process.env.SUPERAGENT_CONFIG_DIR;
    process.env.SUPERAGENT_CONFIG_DIR = isolatedConfigDir;
    try {
      fs.rmSync(isolatedConfigDir, { recursive: true, force: true });
    } catch {}
  });

  afterEach(() => {
    superagentInstances.clear();
    subagentInstances.clear();
    if (originalConfigDir !== undefined) {
      process.env.SUPERAGENT_CONFIG_DIR = originalConfigDir;
    } else {
      delete process.env.SUPERAGENT_CONFIG_DIR;
    }
    try {
      fs.rmSync(isolatedConfigDir, { recursive: true, force: true });
    } catch {}
  });

  it("never classifies 'audit' or 'review' as casual conversation in Senopati ONNX or FastPath (sess_1791684450338_6f27a7)", async () => {
    for (const input of ["audit", "audit multi mode", "review", "periksa", "analisa", "inspect"]) {
      const onnxRes = await classifyWithSenopatiONNX(input);
      expect(onnxRes?.category).not.toBe("conversation");
      const reqRes = await classifyRequest(input, {});
      expect(reqRes.category).not.toBe("conversation");
      expect(isHighConfidenceConversation(reqRes, "master", "IDLE", false, input)).toBe(false);
    }
  });

  it("treats Indonesian/English confirmation tokens ('iya', 'ya', 'oke', 'sip') as continuation commands when prior messages exist", () => {
    const fakeConv = {
      category: "conversation" as const,
      confidence: "high" as const,
      reason: "test",
      heuristicOnly: true,
      classificationTokens: 0,
    };
    for (const token of ["iya", "ya", "oke", "ok", "sip", "siap", "setuju", "boleh", "lanjut"]) {
      expect(CONTINUATION_COMMANDS.has(token)).toBe(true);
      expect(isHighConfidenceConversation(fakeConv, "master", "IDLE", true, token)).toBe(false);
    }
  });

  it("preserves Master Agent orchestration and planning tools in question and research categories", () => {
    for (const category of ["question", "research"] as const) {
      const filtered = getToolsetForCategory(category, masterToolset);
      const names = new Set(filtered.map((t) => t.name));
      expect(names.has("invoke_superagent")).toBe(true);
      expect(names.has("await_superagents")).toBe(true);
      expect(names.has("merge_superagents")).toBe(true);
      expect(names.has("manage_superagents")).toBe(true);
      expect(names.has("manage_subagents")).toBe(true);
      expect(names.has("manage_plan")).toBe(true);
      expect(names.has("manage_tasks")).toBe(true);
      expect(names.has("git_worktree")).toBe(true);
    }
  });

  it("restores task and historyFilePath when reconcileRegistry rehydrates a worktree entry", () => {
    const wtDir = path.join(isolatedConfigDir, "wt-rehydrate");
    fs.mkdirSync(wtDir, { recursive: true });
    upsertEntry({
      id: "sa-rehydrate-1",
      name: "backend-api",
      role: "backend-api",
      branch: "feat/backend-api",
      worktreePath: wtDir,
      status: "completed",
      updatedAt: Date.now(),
      task: "Implement /api/health endpoint",
      historyFilePath: "/tmp/history-sa-1.json",
    });

    const result = reconcileRegistry(superagentInstances);
    expect(result.rehydratedIds).toContain("sa-rehydrate-1");
    const rehydrated = superagentInstances.get("sa-rehydrate-1");
    expect(rehydrated?.task).toBe("Implement /api/health endpoint");
    expect(rehydrated?.historyFilePath).toBe("/tmp/history-sa-1.json");
  });

  it("safely handles undefined inst.agent in manage_superagents and manage_subagents kill/kill_all, and kills waiting Superagents", async () => {
    vi.spyOn(execaModule, "execa").mockResolvedValue({ stdout: "" } as any);
    const parentAgent = { delegationDepth: 0 } as any;

    superagentInstances.set("sa-waiting", {
      id: "sa-waiting",
      role: "waiting-dev",
      task: "wait task",
      branch: "feat/waiting",
      worktreePath: "",
      agent: undefined,
      status: "waiting",
      logs: [],
    });

    const killAllRes = await agentLocalStorage.run(parentAgent, () =>
      manageSuperagentsTool.execute({ action: "kill_all" }, process.cwd())
    );
    expect(killAllRes).toContain("sa-waiting");
    expect(superagentInstances.get("sa-waiting")?.status).toBe("error");

    subagentInstances.set("sub-no-agent", {
      id: "sub-no-agent",
      typeName: "researcher",
      role: "researcher",
      agent: undefined,
      status: "completed",
      logs: [],
    });

    const subKillRes = await manageSubagentsTool.execute(
      { action: "kill", conversationIds: ["sub-no-agent"] },
      process.cwd()
    );
    expect(subKillRes).toContain("sub-no-agent");
    expect(subagentInstances.has("sub-no-agent")).toBe(false);
  });

  it("waits for 'waiting' Superagents in await_superagents instead of exiting prematurely", async () => {
    superagentInstances.set("sa-dep-wait", {
      id: "sa-dep-wait",
      role: "dep-worker",
      task: "dependent task",
      branch: "feat/dep",
      worktreePath: "/dummy/dep",
      agent: undefined,
      status: "waiting",
      logs: [],
    });

    setTimeout(() => {
      const inst = superagentInstances.get("sa-dep-wait");
      if (inst) {
        inst.status = "completed";
        inst.result = "Status: Completed";
      }
    }, 50);

    const res = await awaitSuperagentsTool.execute({ timeoutSeconds: 5 }, process.cwd());
    expect(res).toContain("All Superagents finished");
    expect(res).toContain("dep-worker (feat/dep) — completed");
  });

  it("never deletes the main workspace directory (cwd) when cleaning up patch-mode Superagents", async () => {
    const execaSpy = vi.spyOn(execaModule, "execa").mockResolvedValue({ stdout: "" } as any);
    const rmSyncSpy = vi.spyOn(fs, "rmSync");
    const parentAgent = { delegationDepth: 0, planState: "APPROVED" } as any;
    const mainCwd = process.cwd();

    superagentInstances.set("sa-patch", {
      id: "sa-patch",
      role: "patch-worker",
      task: "quick patch",
      branch: "feat/patch",
      worktreePath: mainCwd,
      agent: undefined,
      status: "running",
      logs: [],
    });

    await agentLocalStorage.run(parentAgent, () =>
      manageSuperagentsTool.execute({ action: "kill", superagentIds: ["sa-patch"] }, mainCwd)
    );

    const worktreeRemoveCalls = execaSpy.mock.calls.filter(
      (call) => call[0] === "git" && Array.isArray(call[1]) && call[1][0] === "worktree" && call[1][1] === "remove"
    );
    expect(worktreeRemoveCalls).toHaveLength(0);
    expect(rmSyncSpy).not.toHaveBeenCalledWith(mainCwd, expect.anything());
  });

  it("allows merge_superagents when Master Agent has isSimpleTask=true and simpleTaskApproved=true in IDLE state", async () => {
    const parentAgent = {
      delegationDepth: 0,
      planState: "IDLE",
      isSimpleTask: true,
      simpleTaskApproved: true,
      getPlanFilePath: () => "/dummy/plan.md",
    } as any;

    const res = await agentLocalStorage.run(parentAgent, () =>
      mergeSuperagentsTool.execute({}, process.cwd())
    );
    expect(res).toContain("No completed Superagents to merge");
  });

  it("blocks Master Agent from directly editing source files via multi_replace_file_content", async () => {
    const masterAgent = {
      tier: "master",
      delegationDepth: 0,
      planState: "APPROVED",
      isSimpleTask: true,
      simpleTaskApproved: true,
    } as any;

    const res = await agentLocalStorage.run(masterAgent, () =>
      multiReplaceFileContentTool.execute(
        { files: [{
          filePath: path.join(process.cwd(), "src", "cli.tsx"),
          chunks: [{ startLine: 1, endLine: 1, targetContent: "import", replacementContent: "// import" }],
        }] },
        process.cwd()
      )
    );
    expect(res).toContain("Master Agent cannot directly edit codebase files");
  });
});

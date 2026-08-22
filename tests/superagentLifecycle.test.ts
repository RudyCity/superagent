import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "path";
import os from "os";
import fs from "fs";

// ── Break circular dependency chain (mirrors pausedResumeWorkflow.test.ts) ──
vi.mock("../src/core/tools.js", async (importOriginal) => {
  const original = await importOriginal<any>();
  return {
    ...original,
    getToolDefinitions: () => [],
    backgroundTasks: new Map(),
    isTaskInWorkspace: () => false,
  };
});

vi.mock("../src/core/masterAgent.js", async (importOriginal) => {
  const original = await importOriginal<any>();
  return {
    ...original,
    MasterAgent: class {},
  };
});

// Dynamic imports after mocks are established
const { appendCapped, MAX_LOG_ENTRIES, cleanupStaleInstances, superagentInstances, subagentInstances } =
  await import("../src/core/tools/state.js");
const { loadRegistry, upsertEntry, removeEntries, reconcileRegistry } = await import(
  "../src/core/tools/superagentRegistry.js"
);
const { manageSuperagentsTool } = await import("../src/core/tools/superagentTools.js");
const { Agent, agentLocalStorage } = await import("../src/core/agent.js");
const { clearModelConfigCache } = await import("../src/core/config/jsonConfig.js");

const testConfigDir = path.join(os.tmpdir(), `superagent-lifecycle-test-${process.pid}`);

function freshInstance(overrides: Partial<Record<string, any>> = {}): any {
  return {
    id: "sa-1",
    role: "alpha-dev",
    task: "original task text",
    branch: "feat/alpha",
    worktreePath: "/dummy/worktree",
    agent: undefined,
    status: "error",
    logs: [],
    completedAt: Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  superagentInstances.clear();
  subagentInstances.clear();
  try {
    fs.rmSync(testConfigDir, { recursive: true, force: true });
  } catch {}
  process.env.SUPERAGENT_CONFIG_DIR = testConfigDir;
  clearModelConfigCache();
});

afterEach(() => {
  delete process.env.SUPERAGENT_CONFIG_DIR;
  try {
    fs.rmSync(testConfigDir, { recursive: true, force: true });
  } catch {}
});

describe("appendCapped log/output cap helper", () => {
  it("caps at the default of 500 entries and keeps the newest", () => {
    expect(MAX_LOG_ENTRIES).toBe(500);
    const arr: number[] = [];
    for (let i = 0; i < 600; i++) {
      appendCapped(arr, i);
    }
    expect(arr.length).toBe(500);
    expect(arr[0]).toBe(100);
    expect(arr[arr.length - 1]).toBe(599);
  });

  it("respects a custom max", () => {
    const arr: string[] = [];
    for (const item of ["a", "b", "c", "d", "e"]) {
      appendCapped(arr, item, 3);
    }
    expect(arr).toEqual(["c", "d", "e"]);
  });

  it("mutates the same array reference so consumers can join it", () => {
    const arr: string[] = [];
    const ref = arr;
    appendCapped(ref, "x\n");
    appendCapped(ref, "y\n");
    expect(ref.join("")).toBe("x\ny\n");
  });
});

describe("cleanupStaleInstances TTL skip-completed logic", () => {
  const NOW = 1_000_000_000_000;
  const TTL = 10 * 60 * 1000;
  const OLD = NOW - TTL - 5_000;
  const RECENT = NOW - 1_000;

  function seedSuperagents(): void {
    superagentInstances.clear();
    superagentInstances.set("completed-old", freshInstance({ id: "completed-old", status: "completed", completedAt: OLD }));
    superagentInstances.set("error-old", freshInstance({ id: "error-old", status: "error", completedAt: OLD }));
    superagentInstances.set("terminated-old", freshInstance({ id: "terminated-old", status: "terminated", completedAt: OLD }));
    superagentInstances.set("running-old", freshInstance({ id: "running-old", status: "running", completedAt: OLD }));
    superagentInstances.set("waiting-old", freshInstance({ id: "waiting-old", status: "waiting", completedAt: OLD }));
    superagentInstances.set("error-recent", freshInstance({ id: "error-recent", status: "error", completedAt: RECENT }));
  }

  it("never deletes completed instances pending merge consumption", () => {
    seedSuperagents();
    cleanupStaleInstances({ now: NOW, ttlMs: TTL });
    expect(superagentInstances.has("completed-old")).toBe(true);
  });

  it("evicts only error/terminated instances older than the TTL", () => {
    seedSuperagents();
    cleanupStaleInstances({ now: NOW, ttlMs: TTL });
    expect(superagentInstances.has("error-old")).toBe(false);
    expect(superagentInstances.has("terminated-old")).toBe(false);
  });

  it("keeps running/waiting instances and recent failures regardless of age", () => {
    seedSuperagents();
    cleanupStaleInstances({ now: NOW, ttlMs: TTL });
    expect(superagentInstances.has("running-old")).toBe(true);
    expect(superagentInstances.has("waiting-old")).toBe(true);
    expect(superagentInstances.has("error-recent")).toBe(true);
  });

  it("still evicts completed subagents (no merge consumption) but keeps running ones", () => {
    subagentInstances.clear();
    subagentInstances.set("sub-completed-old", { id: "sub-completed-old", typeName: "coder", role: "r", status: "completed", completedAt: OLD, logs: [] } as any);
    subagentInstances.set("sub-running-old", { id: "sub-running-old", typeName: "coder", role: "r", status: "running", completedAt: OLD, logs: [] } as any);
    cleanupStaleInstances({ now: NOW, ttlMs: TTL });
    expect(subagentInstances.has("sub-completed-old")).toBe(false);
    expect(subagentInstances.has("sub-running-old")).toBe(true);
  });

  it("defaults to wall clock and the built-in TTL when no options are passed", () => {
    superagentInstances.clear();
    superagentInstances.set("error-ancient", freshInstance({ id: "error-ancient", completedAt: Date.now() - 24 * 60 * 60 * 1000 }));
    superagentInstances.set("completed-ancient", freshInstance({ id: "completed-ancient", status: "completed", completedAt: Date.now() - 24 * 60 * 60 * 1000 }));
    cleanupStaleInstances();
    expect(superagentInstances.has("error-ancient")).toBe(false);
    expect(superagentInstances.has("completed-ancient")).toBe(true);
  });
});

describe("superagent worktree registry persistence", () => {
  it("round-trips entries through save/load with upsert deduplication", () => {
    upsertEntry({ id: "sa-a", name: "alpha-dev", role: "alpha-dev", branch: "feat/alpha", worktreePath: "/wt/a", status: "running", updatedAt: 111 });
    upsertEntry({ id: "sa-b", name: "beta-dev", role: "beta-dev", branch: "feat/beta", worktreePath: "/wt/b", baseCommit: "abc123", status: "completed", updatedAt: 222 });

    let entries = loadRegistry();
    expect(entries.length).toBe(2);
    const a = entries.find((e) => e.id === "sa-a")!;
    expect(a.role).toBe("alpha-dev");
    expect(a.branch).toBe("feat/alpha");
    expect(a.status).toBe("running");
    expect(entries.find((e) => e.id === "sa-b")!.baseCommit).toBe("abc123");

    // Upserting an existing id updates in place instead of duplicating
    upsertEntry({ id: "sa-a", name: "alpha-dev", role: "alpha-dev", branch: "feat/alpha", worktreePath: "/wt/a", status: "error", updatedAt: 333 });
    entries = loadRegistry();
    expect(entries.length).toBe(2);
    expect(entries.find((e) => e.id === "sa-a")!.status).toBe("error");
  });

  it("removeEntries drops only the requested ids", () => {
    upsertEntry({ id: "sa-a", name: "a", role: "a", branch: "b-a", worktreePath: "/wt/a", status: "error", updatedAt: 1 });
    upsertEntry({ id: "sa-b", name: "b", role: "b", branch: "b-b", worktreePath: "/wt/b", status: "error", updatedAt: 2 });
    removeEntries(["sa-a"]);
    const ids = loadRegistry().map((e) => e.id);
    expect(ids).toEqual(["sa-b"]);
  });

  it("reconcileRegistry rehydrates entries with intact worktrees and drops missing ones", () => {
    const existingWorktree = path.join(testConfigDir, "wt-alpha");
    fs.mkdirSync(existingWorktree, { recursive: true });
    upsertEntry({ id: "sa-alive", name: "alive", role: "alive-role", branch: "feat/alive", worktreePath: existingWorktree, status: "completed", updatedAt: 1 });
    upsertEntry({ id: "sa-gone", name: "gone", role: "gone-role", branch: "feat/gone", worktreePath: path.join(testConfigDir, "does-not-exist"), status: "error", updatedAt: 2 });

    const map = new Map<string, any>();
    const result = reconcileRegistry(map);

    expect(result.rehydratedIds).toEqual(["sa-alive"]);
    expect(result.droppedIds).toEqual(["sa-gone"]);

    const inst = map.get("sa-alive");
    expect(inst).toBeDefined();
    expect(inst.status).toBe("completed");
    expect(inst.branch).toBe("feat/alive");
    expect(inst.worktreePath).toBe(existingWorktree);
    expect(inst.agent).toBeUndefined();

    // The dropped entry must also be purged from the persisted journal
    expect(loadRegistry().map((e) => e.id)).toEqual(["sa-alive"]);
  });

  it("rehydrates non-terminal statuses as error so crashed agents stay retryable", () => {
    const existingWorktree = path.join(testConfigDir, "wt-crashed");
    fs.mkdirSync(existingWorktree, { recursive: true });
    upsertEntry({ id: "sa-crashed", name: "crashed", role: "crashed-role", branch: "feat/crashed", worktreePath: existingWorktree, status: "running", updatedAt: 1 });

    const map = new Map<string, any>();
    reconcileRegistry(map);
    expect(map.get("sa-crashed").status).toBe("error");
  });

  it("skips entries that already exist in the in-memory instance map", () => {
    const existingWorktree = path.join(testConfigDir, "wt-tracked");
    fs.mkdirSync(existingWorktree, { recursive: true });
    upsertEntry({ id: "sa-live", name: "live", role: "live-role", branch: "feat/live", worktreePath: existingWorktree, status: "completed", updatedAt: 1 });

    const tracked = freshInstance({ id: "sa-live" });
    const map = new Map<string, any>([["sa-live", tracked]]);
    const result = reconcileRegistry(map);

    expect(result.rehydratedIds).toEqual([]);
    expect(result.droppedIds).toEqual([]);
    expect(map.get("sa-live")).toBe(tracked);
  });
});

describe("manage_superagents retry_failed action", () => {
  let sendMessageSpy: any;
  let loadHistorySpy: any;

  beforeEach(() => {
    vi.restoreAllMocks();
    loadHistorySpy = vi.spyOn(Agent.prototype, "loadHistoryFromPath").mockResolvedValue(undefined as any);
    sendMessageSpy = vi.spyOn(Agent.prototype, "sendMessage").mockImplementation(async function (this: any) {
      return "### TASK REPORT\n- **Status**: Completed";
    });
  });

  it("retries a specific failed instance through the resume path with its original task", async () => {
    const wt = path.join(testConfigDir, "wt-retry");
    fs.mkdirSync(wt, { recursive: true });
    superagentInstances.set(
      "sa-fail",
      freshInstance({
        id: "sa-fail",
        worktreePath: wt,
        historyFilePath: "/dummy/history.json",
        logs: ["[TOOL:OK] bash → ok\n", "[ERROR] Superagent failed: verification exploded\n"],
        result: undefined,
      })
    );

    const parentAgent = { delegationDepth: 0 } as any;
    const result = await agentLocalStorage.run(parentAgent, () =>
      manageSuperagentsTool.execute({ action: "retry_failed", superagentIds: ["sa-fail"] }, testConfigDir)
    );

    expect(result).toContain("Retry initiated");
    expect(result).toContain("sa-fail");

    await vi.waitFor(() => {
      expect(sendMessageSpy).toHaveBeenCalled();
    });
    const sentMessage = sendMessageSpy.mock.calls[0][0] as string;
    expect(sentMessage).toContain("[RETRY]");
    expect(sentMessage).toContain("verification exploded");
    expect(sentMessage).toContain("original task text");

    await vi.waitFor(() => {
      const inst = superagentInstances.get("sa-fail");
      expect(inst?.status).toBe("completed");
    });
    expect(loadHistorySpy).toHaveBeenCalledWith("/dummy/history.json");
  });

  it("picks the most recent failed instance when no id is given and reports none eligible otherwise", async () => {
    const wt = path.join(testConfigDir, "wt-auto");
    fs.mkdirSync(wt, { recursive: true });
    superagentInstances.set(
      "sa-newest",
      freshInstance({ id: "sa-newest", worktreePath: wt, completedAt: Date.now() - 1000, logs: ["[ERROR] boom\n"] })
    );

    const parentAgent = { delegationDepth: 0 } as any;
    const result = await agentLocalStorage.run(parentAgent, () =>
      manageSuperagentsTool.execute({ action: "retry_failed" }, testConfigDir)
    );
    expect(result).toContain("sa-newest");

    // No eligible candidates left -> explicit error
    superagentInstances.clear();
    superagentInstances.set("sa-done", freshInstance({ id: "sa-done", status: "completed", completedAt: Date.now() }));
    const noneEligible = await agentLocalStorage.run(parentAgent, () =>
      manageSuperagentsTool.execute({ action: "retry_failed" }, testConfigDir)
    );
    expect(noneEligible).toContain("Error:");
  });

  it("rejects retrying an instance without an intact worktree directory", async () => {
    superagentInstances.set(
      "sa-nowt",
      freshInstance({ id: "sa-nowt", worktreePath: path.join(testConfigDir, "missing-wt"), logs: [] })
    );

    const parentAgent = { delegationDepth: 0 } as any;
    const result = await agentLocalStorage.run(parentAgent, () =>
      manageSuperagentsTool.execute({ action: "retry_failed", superagentIds: ["sa-nowt"] }, testConfigDir)
    );
    expect(result).not.toContain("Retry initiated");
    expect(superagentInstances.get("sa-nowt")?.status).toBe("error");
  });
});

describe("manage_superagents kill action registry + branch cleanup wiring", () => {
  it("marks the instance error, removes the worktree dir, and purges the registry entry", async () => {
    const wt = path.join(testConfigDir, "wt-kill");
    fs.mkdirSync(path.join(wt, "nested"), { recursive: true });
    fs.writeFileSync(path.join(wt, "file.txt"), "x", "utf-8");

    upsertEntry({ id: "sa-kill", name: "killer", role: "killer-role", branch: "multi-agent/test-kill", worktreePath: wt, status: "running", updatedAt: 1 });
    superagentInstances.set(
      "sa-kill",
      freshInstance({
        id: "sa-kill",
        role: "killer-role",
        branch: "multi-agent/test-kill",
        worktreePath: wt,
        status: "running",
        agent: { abort: vi.fn(), writeToLogFile: vi.fn() },
      })
    );

    const parentAgent = { delegationDepth: 0 } as any;
    const result = await agentLocalStorage.run(parentAgent, () =>
      manageSuperagentsTool.execute({ action: "kill", superagentIds: ["sa-kill"] }, testConfigDir)
    );

    expect(result).toContain("Terminated Superagents: sa-kill");
    const inst = superagentInstances.get("sa-kill")!;
    expect(inst.status).toBe("error");
    expect(inst.logs.join("")).toContain("[TERMINATED]");
    expect(inst.logs.join("")).toContain("[CLEANUP]");
    expect(fs.existsSync(wt)).toBe(false);
    expect(loadRegistry().map((e) => e.id)).not.toContain("sa-kill");
  });
});

describe("manage_superagents cleanup_orphans action", () => {
  it("removes registry entries whose worktree dirs vanished and keeps valid ones", async () => {
    const validWt = path.join(testConfigDir, "wt-valid");
    fs.mkdirSync(validWt, { recursive: true });
    upsertEntry({ id: "sa-valid", name: "v", role: "v-role", branch: "feat/v", worktreePath: validWt, status: "completed", updatedAt: 1 });
    upsertEntry({ id: "sa-orphan", name: "o", role: "o-role", branch: "feat/o", worktreePath: path.join(testConfigDir, "vanished"), status: "error", updatedAt: 2 });

    const parentAgent = { delegationDepth: 0 } as any;
    const result = await agentLocalStorage.run(parentAgent, () =>
      manageSuperagentsTool.execute({ action: "cleanup_orphans" }, testConfigDir)
    );

    expect(result).toContain("Removed 1 stale entr");
    expect(result).toContain("sa-orphan");
    expect(loadRegistry().map((e) => e.id)).toEqual(["sa-valid"]);
  });

  it("reports nothing to clean when the registry is empty", async () => {
    const parentAgent = { delegationDepth: 0 } as any;
    const result = await agentLocalStorage.run(parentAgent, () =>
      manageSuperagentsTool.execute({ action: "cleanup_orphans" }, testConfigDir)
    );
    expect(result).toContain("No worktree registry entries found");
  });
});

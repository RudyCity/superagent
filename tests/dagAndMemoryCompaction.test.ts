import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { superagentInstances } from "../src/core/tools/state.js";
import { invokeSuperagentTool } from "../src/core/tools/superagentTools.js";
import { saveSharedMemoryTool } from "../src/core/tools/sharedMemoryTools.js";
import { agentLocalStorage } from "../src/core/agent.js";

// Mock execa
vi.mock("execa", () => ({
  execa: vi.fn().mockResolvedValue({ stdout: "" }),
}));

// Mock config
vi.mock("../src/core/config.js", () => {
  let settings = { enableTencentdbMemory: false };
  return {
    getSettings: () => settings,
    setSettings: (s: any) => { settings = s; },
    getRootConfigDir: () => "/dummy/config/dir",
    ensureGlobalConfigDir: () => "/dummy/config/dir",
    getGlobalConfigDir: () => "/dummy/config/dir",
  };
});

// Mock tencentdbClient
const mockUpdateAtomic = vi.fn().mockResolvedValue({ id: "1", updated_at: "now" });
const mockDeleteAtomic = vi.fn().mockResolvedValue({ deleted_count: 1 });
vi.mock("../src/core/tencentdbUtil.js", () => {
  return {
    getTencentDBClient: () => ({
      updateAtomic: mockUpdateAtomic,
      deleteAtomic: mockDeleteAtomic,
    }),
    isTencentdbActive: vi.fn().mockImplementation(async () => {
      const { getSettings } = await import("../src/core/config.js");
      return !!getSettings().enableTencentdbMemory;
    }),
  };
});

// Mock workspace isolation
vi.mock("../src/core/workspaceIsolation.js", () => ({
  ensureGitIgnore: vi.fn(),
  pruneWorktrees: vi.fn().mockResolvedValue(undefined),
}));

describe("DAG Cycle Detection", () => {
  beforeEach(() => {
    superagentInstances.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    superagentInstances.clear();
  });

  it("should succeed if there are no dependency cycles", async () => {
    // Parent agent state is approved
    agentLocalStorage.run({ planState: "APPROVED", delegationDepth: 0 } as any, async () => {
      // Spawn A
      superagentInstances.set("agent-a", {
        id: "agent-a",
        role: "A",
        branch: "branch-a",
        task: "task a",
        worktreePath: "/tmp/a",
        agent: {},
        status: "running",
        logs: [],
        dependsOn: [],
      });

      // Spawn B depending on A (should succeed)
      const res = await invokeSuperagentTool.execute({
        role: "B",
        branch: "branch-b",
        task: "task b",
        dependsOn: ["A"],
      }, process.cwd());

      expect(res).not.toContain("Dependency cycle detected");
    });
  });

  it("should fail if there is a direct cycle", async () => {
    agentLocalStorage.run({ planState: "APPROVED", delegationDepth: 0 } as any, async () => {
      // Spawn A depending on B
      superagentInstances.set("agent-a", {
        id: "agent-a",
        role: "A",
        branch: "branch-a",
        task: "task a",
        worktreePath: "/tmp/a",
        agent: {},
        status: "running",
        logs: [],
        dependsOn: ["B"],
      });

      // Spawn B depending on A (should fail due to cycle A -> B -> A)
      const res = await invokeSuperagentTool.execute({
        role: "B",
        branch: "branch-b",
        task: "task b",
        dependsOn: ["A"],
      }, process.cwd());

      expect(res).toContain("Dependency cycle detected");
      expect(res).toContain("B (branch-b) -> A (branch-a) -> B (branch-b)");
    });
  });

  it("should fail if there is a complex cycle (A -> B -> C -> A)", async () => {
    agentLocalStorage.run({ planState: "APPROVED", delegationDepth: 0 } as any, async () => {
      // A depends on B
      superagentInstances.set("agent-a", {
        id: "agent-a",
        role: "A",
        branch: "branch-a",
        task: "task a",
        worktreePath: "/tmp/a",
        agent: {},
        status: "running",
        logs: [],
        dependsOn: ["B"],
      });

      // B depends on C
      superagentInstances.set("agent-b", {
        id: "agent-b",
        role: "B",
        branch: "branch-b",
        task: "task b",
        worktreePath: "/tmp/b",
        agent: {},
        status: "running",
        logs: [],
        dependsOn: ["C"],
      });

      // Spawn C depending on A (should fail due to cycle)
      const res = await invokeSuperagentTool.execute({
        role: "C",
        branch: "branch-c",
        task: "task c",
        dependsOn: ["A"],
      }, process.cwd());

      expect(res).toContain("Dependency cycle detected");
      expect(res).toContain("C (branch-c) -> A (branch-a) -> B (branch-b) -> C (branch-c)");
    });
  });
});

describe("Shared Memory Compaction", () => {
  const dummyDir = path.join(process.cwd(), "tests", "temp-shared-mem");

  beforeEach(() => {
    if (!fs.existsSync(dummyDir)) {
      fs.mkdirSync(dummyDir, { recursive: true });
    }
    const originalExistsSync = fs.existsSync;
    vi.spyOn(fs, "existsSync").mockImplementation((p) => {
      if (String(p).includes("shared-memory.json")) return true;
      return originalExistsSync(p);
    });
    mockUpdateAtomic.mockClear();
    mockDeleteAtomic.mockClear();
  });

  afterEach(() => {
    if (fs.existsSync(dummyDir)) {
      try {
        fs.rmSync(dummyDir, { recursive: true, force: true });
      } catch {}
    }
    vi.restoreAllMocks();
  });

  it("should prune memories older than 7 days and keep at most 30 entries", async () => {
    // Generate 40 memories, some older than 7 days
    const now = Date.now();
    const oneDay = 24 * 60 * 60 * 1000;
    const memories: any[] = [];
    
    // 5 memories older than 7 days (should be pruned)
    for (let i = 0; i < 5; i++) {
      memories.push({
        key: `old-${i}`,
        value: `val-${i}`,
        source: "system",
        timestamp: now - 8 * oneDay,
      });
    }

    // 35 fresh memories
    for (let i = 0; i < 35; i++) {
      memories.push({
        key: `fresh-${i}`,
        value: `val-${i}`,
        source: "system",
        timestamp: now - i * 1000, // spaced slightly to check sorting
      });
    }

    // Mock readFileSync to return these 40 memories
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify(memories));
    
    // Mock writeFileSync to inspect final written value
    let finalWritten: any[] = [];
    vi.spyOn(fs, "writeFileSync").mockImplementation((p, content) => {
      if (String(p).includes("shared-memory.json.tmp")) {
        finalWritten = JSON.parse(content as string);
      }
      return undefined as any;
    });
    vi.spyOn(fs, "renameSync").mockImplementation(() => {});

    // Save a new memory
    const res = await saveSharedMemoryTool.execute({
      key: "new-key",
      value: "new-val",
      scope: "project",
    }, process.cwd());

    expect(res).toContain("Successfully saved memory");
    expect(res).toContain("project scope");

    // The old-x memories should be pruned by TTL.
    // The oldest fresh memories should be pruned by count, leaving exactly 30 entries (including the new-key).
    expect(finalWritten.length).toBe(30);
    const keys = finalWritten.map(m => m.key);
    expect(keys).toContain("new-key");
    expect(keys.some(k => k.startsWith("old-"))).toBe(false);
    
    const savedEntry = finalWritten.find(m => m.key === "new-key");
    expect(savedEntry?.scope).toBe("project");
    expect(savedEntry?.projectPath).toBeTruthy();
  });

  it("should support saving global scope memories", async () => {
    let finalWritten: any[] = [];
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue("[]");
    vi.spyOn(fs, "writeFileSync").mockImplementation((filePath, content) => {
      if (typeof filePath === "string" && filePath.endsWith(".tmp")) {
        finalWritten = JSON.parse(content as string);
      }
      return undefined as any;
    });
    vi.spyOn(fs, "renameSync").mockImplementation(() => {});

    const res = await saveSharedMemoryTool.execute({
      key: "user-pref-theme",
      value: "dark-mode",
      scope: "global",
    }, process.cwd());

    expect(res).toContain("global scope");
    expect(finalWritten.length).toBe(1);
    expect(finalWritten[0].scope).toBe("global");
    expect(finalWritten[0].projectPath).toBeUndefined();
  });

  it("should sync updates and deletions to TencentDB if enabled", async () => {
    // Import and update mock config to enable TencentDB Memory
    const { getSettings } = await import("../src/core/config.js");
    const settings = getSettings();
    settings.enableTencentdbMemory = true;

    const memories = [
      { key: "to-prune", value: "prune me", source: "system", timestamp: Date.now() - 10 * 24 * 60 * 60 * 1000 } // old TTL
    ];

    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify(memories));
    vi.spyOn(fs, "writeFileSync").mockImplementation(() => {});
    vi.spyOn(fs, "renameSync").mockImplementation(() => {});

    await saveSharedMemoryTool.execute({
      key: "new-key",
      value: "new-val",
    }, process.cwd());

    // Should call client.updateAtomic for the new memory with scope tag
    expect(mockUpdateAtomic).toHaveBeenCalledWith({
      id: "shared-memory-new-key",
      content: expect.stringContaining("new-key: new-val")
    });

    // Should call client.deleteAtomic for the pruned memory
    expect(mockDeleteAtomic).toHaveBeenCalledWith({
      ids: ["shared-memory-to-prune"]
    });
  });
});

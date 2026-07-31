import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { grepTool, ripgrepSearchTool } from "../src/core/tools/systemTools.js";
import { workspaceChainManager } from "../src/core/workspace/WorkspaceChainManager.js";
import { WorkspaceChain } from "../src/core/workspace/WorkspaceChainTypes.js";

describe("Workspace Chain Search Integration", () => {
  let wsDir1: string;
  let wsDir2: string;
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sa-chain-search-"));
    wsDir1 = path.join(tempDir, "workspace-1");
    wsDir2 = path.join(tempDir, "workspace-2");
    fs.mkdirSync(wsDir1);
    fs.mkdirSync(wsDir2);

    // Setup files
    fs.writeFileSync(path.join(wsDir1, "app.ts"), "const queryKey = 'hello from workspace 1';", "utf-8");
    fs.writeFileSync(path.join(wsDir2, "utils.ts"), "const queryKey = 'hello from workspace 2';", "utf-8");

    vi.restoreAllMocks();
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it("should search single workspace when no chain is active", async () => {
    vi.spyOn(workspaceChainManager, "isChainActive").mockReturnValue(false);
    vi.spyOn(workspaceChainManager, "getActiveChain").mockReturnValue(null);

    const result = await grepTool.execute(
      { pattern: "queryKey", include: "*.ts" },
      wsDir1,
      new AbortController().signal
    );

    expect(result).toContain("app.ts:1: const queryKey = 'hello from workspace 1';");
    expect(result).not.toContain("utils.ts");
    expect(result).not.toContain("[workspace-2]");
  });

  it("should search both local workspaces and prefix results when chain is active", async () => {
    const mockChain: WorkspaceChain = {
      id: "test-chain",
      name: "Test Chain",
      nodes: [
        { id: "node-1", label: "Node 1", type: "local", role: "main", path: wsDir1 },
        { id: "node-2", label: "Node 2", type: "local", role: "module", path: wsDir2 },
      ],
      primaryNodeId: "node-1",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    vi.spyOn(workspaceChainManager, "isChainActive").mockReturnValue(true);
    vi.spyOn(workspaceChainManager, "getActiveChain").mockReturnValue(mockChain);

    const result = await grepTool.execute(
      { pattern: "queryKey", include: "*.ts" },
      wsDir1,
      new AbortController().signal
    );

    expect(result).toContain("[node-1] app.ts:1: const queryKey = 'hello from workspace 1';");
    expect(result).toContain("[node-2] utils.ts:1: const queryKey = 'hello from workspace 2';");
  });

  it("should search both local workspaces via ripgrep_search when chain is active", async () => {
    const mockChain: WorkspaceChain = {
      id: "test-chain",
      name: "Test Chain",
      nodes: [
        { id: "node-1", label: "Node 1", type: "local", role: "main", path: wsDir1 },
        { id: "node-2", label: "Node 2", type: "local", role: "module", path: wsDir2 },
      ],
      primaryNodeId: "node-1",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    vi.spyOn(workspaceChainManager, "isChainActive").mockReturnValue(true);
    vi.spyOn(workspaceChainManager, "getActiveChain").mockReturnValue(mockChain);

    const result = await ripgrepSearchTool.execute(
      { pattern: "queryKey" },
      wsDir1,
      new AbortController().signal
    );

    expect(result).toContain("[node-1] app.ts:1:");
    expect(result).toContain("hello from workspace 1");
    expect(result).toContain("[node-2] utils.ts:1:");
    expect(result).toContain("hello from workspace 2");
  });
});

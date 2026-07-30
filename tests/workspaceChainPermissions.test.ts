import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import { isToolCallOutOfBounds } from "../src/core/permissions.js";
import { workspaceChainManager } from "../src/core/workspace/WorkspaceChainManager.js";

describe("Workspace Chain Permission Bypass", () => {
  const primaryWorkspace = path.resolve("/projects/node-a");
  const secondaryWorkspace = path.resolve("/projects/node-b");

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("should allow access to secondary chain node without permission prompt when chain is active", () => {
    vi.spyOn(workspaceChainManager, "getActiveChain").mockReturnValue({
      id: "chain-1",
      name: "Test Chain",
      primaryNodeId: "node-a",
      nodes: [
        { id: "node-a", label: "Node A", type: "local", path: primaryWorkspace },
        { id: "node-b", label: "Node B", type: "local", path: secondaryWorkspace },
      ],
    } as any);

    const toolCallNodeB = {
      name: "read",
      args: { filePath: path.join(secondaryWorkspace, "src/server.ts") },
    };

    expect(isToolCallOutOfBounds(toolCallNodeB, primaryWorkspace)).toBe(false);
  });

  test("should allow cross_workspace_exec when chain is active", () => {
    vi.spyOn(workspaceChainManager, "isChainActive").mockReturnValue(true);

    const toolCallExec = {
      name: "cross_workspace_exec",
      args: { operation: "exec", nodeId: "node-b", command: "ls -la" },
    };

    expect(isToolCallOutOfBounds(toolCallExec, primaryWorkspace)).toBe(false);
  });

  test("should block access to unregistered external path even if chain is active", () => {
    vi.spyOn(workspaceChainManager, "getActiveChain").mockReturnValue({
      id: "chain-1",
      name: "Test Chain",
      primaryNodeId: "node-a",
      nodes: [
        { id: "node-a", label: "Node A", type: "local", path: primaryWorkspace },
        { id: "node-b", label: "Node B", type: "local", path: secondaryWorkspace },
      ],
    } as any);

    const externalPath = path.resolve("/unauthorized/secret/file.txt");
    const toolCallExternal = {
      name: "read",
      args: { filePath: externalPath },
    };

    expect(isToolCallOutOfBounds(toolCallExternal, primaryWorkspace)).toBe(true);
  });
});

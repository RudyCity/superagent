import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import { isToolCallOutOfBounds, getToolDescription } from "../src/core/permissions.js";
import { workspaceChainManager } from "../src/core/workspace/WorkspaceChainManager.js";
import { resolveFilePathFromArgs } from "../src/core/tools/pathHelpers.js";

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

  test("resolveFilePathFromArgs should allow local chain node paths when chain is active", () => {
    vi.spyOn(workspaceChainManager, "getActiveChain").mockReturnValue({
      id: "chain-1",
      name: "Test Chain",
      primaryNodeId: "node-a",
      nodes: [
        { id: "node-a", label: "Node A", type: "local", path: primaryWorkspace },
        { id: "node-b", label: "Node B", type: "local", path: secondaryWorkspace },
      ],
    } as any);

    const targetFile = path.join(secondaryWorkspace, "src/server.ts");
    const resolved = resolveFilePathFromArgs({ filePath: targetFile }, primaryWorkspace);
    expect(resolved).toBeDefined();
  });

  test("getToolDescription should return humanized descriptions for cross_workspace_exec and manage_workspace_chain", () => {
    const execToolCall = {
      name: "cross_workspace_exec",
      args: { operation: "exec", nodeId: "node-b", command: "npm test" },
    };
    const descExec = getToolDescription(execToolCall as any);
    expect(descExec).toBe('Running command "npm test" on chain node "node-b"');

    const switchToolCall = {
      name: "cross_workspace_exec",
      args: { operation: "switch-node", nodeId: "node-a" },
    };
    const descSwitch = getToolDescription(switchToolCall as any);
    expect(descSwitch).toBe('Switching active chain node to "node-a"');

    const manageToolCall = {
      name: "manage_workspace_chain",
      args: { action: "activate", chainId: "chain-1" },
    };
    const descManage = getToolDescription(manageToolCall as any);
    expect(descManage).toBe('Activating workspace chain: chain-1');
  });
});

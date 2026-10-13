import { describe, expect, it } from "vitest";
import { workspaceChainManager } from "../src/core/workspace/WorkspaceChainManager.js";
import type { WorkspaceChain } from "../src/core/workspace/WorkspaceChainTypes.js";

function chain(id: string, nodeId: string): WorkspaceChain {
  return {
    id,
    name: id,
    nodes: [{ id: nodeId, label: nodeId, type: "local", role: "main", path: `/tmp/${id}` }],
    primaryNodeId: nodeId,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("WorkspaceChainManager request context", () => {
  it("isolates active chain and node selections between concurrent requests", async () => {
    const [resultA, resultB] = await Promise.all([
      workspaceChainManager.runWithRequestContext(async () => {
        (workspaceChainManager as any).activeChain = chain("chain-a", "node-a");
        (workspaceChainManager as any).activeNodeId = "node-a";
        await new Promise((resolve) => setTimeout(resolve, 15));
        return {
          chainId: workspaceChainManager.getActiveChain()?.id,
          nodeId: workspaceChainManager.getActiveNodeId(),
        };
      }),
      workspaceChainManager.runWithRequestContext(async () => {
        (workspaceChainManager as any).activeChain = chain("chain-b", "node-b");
        (workspaceChainManager as any).activeNodeId = "node-b";
        await new Promise((resolve) => setTimeout(resolve, 5));
        return {
          chainId: workspaceChainManager.getActiveChain()?.id,
          nodeId: workspaceChainManager.getActiveNodeId(),
        };
      }),
    ]);

    expect(resultA).toEqual({ chainId: "chain-a", nodeId: "node-a" });
    expect(resultB).toEqual({ chainId: "chain-b", nodeId: "node-b" });
    expect(workspaceChainManager.getActiveChain()).toBeNull();
  });

  it("namespaces SSH connection keys by chain and node", async () => {
    const keys = await Promise.all([
      workspaceChainManager.runWithRequestContext(() => {
        (workspaceChainManager as any).activeChain = chain("chain-a", "shared-node");
        return (workspaceChainManager as any).connectionKey("shared-node");
      }),
      workspaceChainManager.runWithRequestContext(() => {
        (workspaceChainManager as any).activeChain = chain("chain-b", "shared-node");
        return (workspaceChainManager as any).connectionKey("shared-node");
      }),
    ]);

    expect(keys[0]).not.toBe(keys[1]);
    expect(keys).toEqual(["chain-a::shared-node", "chain-b::shared-node"]);
  });
});

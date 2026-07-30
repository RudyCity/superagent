import { describe, it, expect } from "vitest";
import {
  getWorkspaceChains,
  getWorkspaceChain,
  createWorkspaceChain,
  updateWorkspaceChain,
  addNodeToChain,
  removeNodeFromChain,
  deleteWorkspaceChain,
  setActiveChainId,
} from "../src/core/workspace/WorkspaceChainConfig.js";
import { buildWorkspaceStateBlock } from "../src/core/context/WorkspaceStateTracker.js";

describe("Workspace Wizard Chain Flow", () => {
  it("should perform full CRUD operations on workspace chains", () => {
    const initialCount = getWorkspaceChains().length;

    // 1. Create
    const chain = createWorkspaceChain(
      "CRUD Test Chain",
      "Initial Description",
      [{ id: "main-node", label: "Main Node", type: "local", role: "main", path: process.cwd() }],
      "main-node"
    );
    expect(chain.id).toBe("crud-test-chain");
    expect(getWorkspaceChains().length).toBe(initialCount + 1);

    // 2. Edit Name
    const updated = updateWorkspaceChain("crud-test-chain", { name: "Renamed Chain" });
    expect(updated.name).toBe("Renamed Chain");
    expect(getWorkspaceChain("crud-test-chain")?.name).toBe("Renamed Chain");

    // 3. Add Node
    const withNode = addNodeToChain("crud-test-chain", {
      id: "backend-node",
      label: "Backend",
      type: "local",
      role: "backend",
      path: "/tmp/backend",
    });
    expect(withNode.nodes).toHaveLength(2);

    // 4. Remove Node
    const removed = removeNodeFromChain("crud-test-chain", "backend-node");
    expect(removed.nodes).toHaveLength(1);

    // 5. Delete
    deleteWorkspaceChain("crud-test-chain");
    expect(getWorkspaceChains().length).toBe(initialCount);
    expect(getWorkspaceChain("crud-test-chain")).toBeFalsy();
  });

  it("should inject active workspace chain details into workspace state block", () => {
    const originalActiveChain = getWorkspaceChains().find(c => c.id === "test-wizard-chain");
    
    // Create a temporary chain
    const chain = createWorkspaceChain(
      "State Inject Chain",
      "State Inject Desc",
      [{ id: "main-node", label: "Main Node", type: "local", role: "main", path: process.cwd() }],
      "main-node"
    );

    setActiveChainId(chain.id);

    const block = buildWorkspaceStateBlock({
      taskFilePath: "",
      cwd: process.cwd(),
      tier: "master",
    });

    expect(block.text).toContain("ACTIVE WORKSPACE CHAIN: State Inject Chain (state-inject-chain)");
    expect(block.text).toContain("Primary Node: Main Node (role: main, type: local, target:");

    // Cleanup
    setActiveChainId(null);
    deleteWorkspaceChain(chain.id);
  });
});

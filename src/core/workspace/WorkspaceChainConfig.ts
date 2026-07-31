/**
 * WorkspaceChainConfig.ts — Persistence for workspace chains in model-config.json.
 *
 * Chains are stored under `workspaceChains` in the global config, following
 * the JSON-only config rule (no process.env).
 */

import path from "path";
import { mutateModelConfig, loadModelConfig } from "../config/jsonConfig.js";
import { workspaceMode } from "../ssh/workspaceMode.js";
import {
  WorkspaceChain,
  WorkspaceNode,
  generateChainId,
  generateNodeId,
  validateChain,
} from "./WorkspaceChainTypes.js";

/** Get all stored workspace chains */
export function getWorkspaceChains(currentWorkspacePath?: string, filterByWorkspace = true): WorkspaceChain[] {
  const config = loadModelConfig();
  const chains = (config as any).workspaceChains;
  if (!Array.isArray(chains)) return [];
  if (!filterByWorkspace) {
    return chains as WorkspaceChain[];
  }

  const targetWorkspace = currentWorkspacePath || process.cwd();
  const isSshActive = workspaceMode.isSsh() || targetWorkspace.startsWith("ssh:");
  const sshCfg = workspaceMode.getConfig();

  return (chains as WorkspaceChain[]).filter((chain) => {
    return chain.nodes.some((node) => {
      if (node.type === "local" && !isSshActive && node.path) {
        const resolvedNode = path.resolve(node.path).toLowerCase();
        const resolvedTarget = path.resolve(targetWorkspace).toLowerCase();
        const relative = path.relative(resolvedNode, resolvedTarget);
        return relative === "" || (!relative.startsWith('..') && !path.isAbsolute(relative));
      }
      if (node.type === "ssh" && isSshActive && node.sshConfig && sshCfg) {
        const hostMatches = (node.sshConfig.host || "").toLowerCase() === (sshCfg.host || "").toLowerCase();
        const portMatches = node.sshConfig.port === sshCfg.port;
        const userMatches = (node.sshConfig.username || "").toLowerCase() === (sshCfg.username || "").toLowerCase();
        const resolvedNodeCwd = (node.sshConfig.remoteCwd || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() || "/";
        const resolvedTargetCwd = (sshCfg.remoteCwd || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() || "/";
        const relative = path.posix.relative(resolvedNodeCwd, resolvedTargetCwd);
        const isSameOrSubdirSsh = relative === "" || (!relative.startsWith('..') && !relative.startsWith('/'));
        return hostMatches && portMatches && userMatches && isSameOrSubdirSsh;
      }
      return false;
    });
  });
}

/** Get a specific chain by ID */
export function getWorkspaceChain(chainId: string, currentWorkspacePath?: string, filterByWorkspace = true): WorkspaceChain | null {
  return getWorkspaceChains(currentWorkspacePath, filterByWorkspace).find(c => c.id === chainId) || null;
}

/** Get the active chain ID from config */
export function getActiveChainId(currentWorkspacePath?: string): string | null {
  const config = loadModelConfig();
  const chainId = (config as any).activeWorkspaceChainId || null;
  if (!chainId) return null;

  // Validate that the active chain belongs to the current workspace
  const matchingChains = getWorkspaceChains(currentWorkspacePath, true);
  const chainExists = matchingChains.some(c => c.id === chainId);
  return chainExists ? chainId : null;
}

/** Set the active chain ID in config */
export function setActiveChainId(chainId: string | null): void {
  mutateModelConfig((config: any) => {
    if (chainId === null) {
      delete config.activeWorkspaceChainId;
    } else {
      config.activeWorkspaceChainId = chainId;
    }
  });
}

/** Create a new workspace chain and persist it */
export function createWorkspaceChain(
  name: string,
  description: string | undefined,
  nodes: WorkspaceNode[],
  primaryNodeId: string
): WorkspaceChain {
  const chainId = generateChainId(name);
  const now = Date.now();
  const chain: WorkspaceChain = {
    id: chainId,
    name,
    description,
    nodes,
    primaryNodeId,
    createdAt: now,
    updatedAt: now,
  };
  const errors = validateChain(chain);
  if (errors.length > 0) {
    throw new Error(`Invalid workspace chain: ${errors.join("; ")}`);
  }
  mutateModelConfig((config: any) => {
    if (!Array.isArray(config.workspaceChains)) {
      config.workspaceChains = [];
    }
    // Prevent duplicate IDs
    config.workspaceChains = config.workspaceChains.filter(
      (c: WorkspaceChain) => c.id !== chainId
    );
    config.workspaceChains.push(chain);
  });
  return chain;
}

/** Update an existing workspace chain */
export function updateWorkspaceChain(chainId: string, updates: Partial<WorkspaceChain>): WorkspaceChain {
  const existing = getWorkspaceChain(chainId, undefined, false);
  if (!existing) {
    throw new Error(`Workspace chain not found: ${chainId}`);
  }
  const updated: WorkspaceChain = {
    ...existing,
    ...updates,
    id: chainId, // Prevent ID change
    updatedAt: Date.now(),
  };
  const errors = validateChain(updated);
  if (errors.length > 0) {
    throw new Error(`Invalid workspace chain: ${errors.join("; ")}`);
  }
  mutateModelConfig((config: any) => {
    if (!Array.isArray(config.workspaceChains)) return;
    const idx = config.workspaceChains.findIndex((c: WorkspaceChain) => c.id === chainId);
    if (idx !== -1) {
      config.workspaceChains[idx] = updated;
    }
  });
  return updated;
}

/** Delete a workspace chain */
export function deleteWorkspaceChain(chainId: string): void {
  mutateModelConfig((config: any) => {
    if (Array.isArray(config.workspaceChains)) {
      config.workspaceChains = config.workspaceChains.filter(
        (c: WorkspaceChain) => c.id !== chainId
      );
    }
    if (config.activeWorkspaceChainId === chainId) {
      delete config.activeWorkspaceChainId;
    }
  });
}

/** Add a node to an existing chain */
export function addNodeToChain(chainId: string, node: WorkspaceNode): WorkspaceChain {
  const chain = getWorkspaceChain(chainId, undefined, false);
  if (!chain) {
    throw new Error(`Workspace chain not found: ${chainId}`);
  }
  if (chain.nodes.some(n => n.id === node.id)) {
    throw new Error(`Node ID already exists in chain: ${node.id}`);
  }
  chain.nodes.push(node);
  return updateWorkspaceChain(chainId, { nodes: chain.nodes });
}

/** Remove a node from a chain */
export function removeNodeFromChain(chainId: string, nodeId: string): WorkspaceChain {
  const chain = getWorkspaceChain(chainId, undefined, false);
  if (!chain) {
    throw new Error(`Workspace chain not found: ${chainId}`);
  }
  if (nodeId === chain.primaryNodeId) {
    throw new Error("Cannot remove the primary node");
  }
  chain.nodes = chain.nodes.filter(n => n.id !== nodeId);
  // Clean up dependsOn references
  for (const node of chain.nodes) {
    if (node.dependsOn) {
      node.dependsOn = node.dependsOn.filter(id => id !== nodeId);
    }
  }
  return updateWorkspaceChain(chainId, { nodes: chain.nodes });
}

/** Create a quick chain from a list of workspace paths/SSH targets */
export function createQuickChain(
  name: string,
  entries: Array<{
    label: string;
    type: "local" | "ssh";
    path?: string;
    sshTarget?: string;
    role?: WorkspaceNode["role"];
    description?: string;
  }>,
  primaryIndex: number = 0
): WorkspaceChain {
  const nodes: WorkspaceNode[] = entries.map((entry, idx) => {
    const nodeId = generateNodeId(entry.label);
    if (entry.type === "ssh" && entry.sshTarget) {
      const sshConfig = workspaceMode.parseSshTarget(entry.sshTarget);
      if (!sshConfig) {
        throw new Error(`Invalid SSH target for node "${entry.label}": ${entry.sshTarget}`);
      }
      return {
        id: nodeId,
        label: entry.label,
        type: "ssh" as const,
        role: entry.role || (idx === primaryIndex ? "main" : "module"),
        sshConfig: {
          host: sshConfig.host,
          port: sshConfig.port,
          username: sshConfig.username,
          password: sshConfig.password,
          privateKeyPath: sshConfig.privateKeyPath,
          remoteCwd: sshConfig.remoteCwd,
          readyTimeout: sshConfig.readyTimeout,
          compression: sshConfig.compression,
          agentForward: sshConfig.agentForward,
          proxyJump: sshConfig.proxyJump,
          bandwidthLimit: sshConfig.bandwidthLimit,
        },
        description: entry.description,
      };
    }
    return {
      id: nodeId,
      label: entry.label,
      type: "local" as const,
      role: entry.role || (idx === primaryIndex ? "main" : "module"),
      path: entry.path,
      description: entry.description,
    };
  });
  const primaryNodeId = nodes[primaryIndex]?.id || nodes[0]?.id;
  if (!primaryNodeId) {
    throw new Error("Cannot create chain: no nodes provided");
  }
  return createWorkspaceChain(name, undefined, nodes, primaryNodeId);
}
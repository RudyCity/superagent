/**
 * workspaceChainTools.ts — AI tools for managing and operating on workspace chains.
 *
 * Provides two tools:
 * 1. manage_workspace_chain — Create, list, activate, deactivate, delete chains
 * 2. cross_workspace_exec — Execute commands/read/write files on specific chain nodes
 */

import { Tool } from "../tools/types.js";
import { formatUnknownActionError } from "../tools/helpers.js";
import {
  getWorkspaceChains,
  getWorkspaceChain,
  createWorkspaceChain,
  updateWorkspaceChain,
  deleteWorkspaceChain,
  addNodeToChain,
  removeNodeFromChain,
  getActiveChainId,
} from "./WorkspaceChainConfig.js";
import { workspaceChainManager } from "./WorkspaceChainManager.js";
import {
  WorkspaceNode,
  formatChainTopology,
  generateNodeId,
} from "./WorkspaceChainTypes.js";

// ─── manage_workspace_chain Tool ──────────────────────────────────────────────

export const manageWorkspaceChainTool: Tool = {
  name: "manage_workspace_chain",
  description:
    "Manage workspace chains: create, list, activate, deactivate, delete, add-node, remove-node, status, topology. " +
    "A workspace chain links multiple workspaces (local or SSH) so you can work across them. " +
    "Use 'topology' to view the chain graph. Use 'activate' to switch the active chain.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["create", "list", "activate", "deactivate", "delete", "add-node", "remove-node", "status", "topology", "update", "health"],
        description:
          "Action: 'create' (new chain), 'list' (all chains), 'activate' (set active), 'deactivate' (clear active), " +
          "'delete' (remove chain), 'add-node' (add workspace to chain), 'remove-node' (remove workspace from chain), " +
          "'status' (connection status), 'topology' (view chain graph), 'update' (modify chain metadata), 'health' (resource & latency dashboard)",
      },
      chainId: {
        type: "string",
        description: "Chain ID (required for activate, delete, add-node, remove-node, topology, update)",
      },
      name: {
        type: "string",
        description: "Chain name (for create, update)",
      },
      description: {
        type: "string",
        description: "Chain description (for create, update)",
      },
      nodes: {
        type: "array",
        description: "Array of node definitions (for create). Each: {id, label, type:'local'|'ssh', role, path?, sshConfig?, dependsOn?, description?}",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "Unique node ID (short, alphanumeric, hyphens)" },
            label: { type: "string", description: "Human-readable label" },
            type: { type: "string", enum: ["local", "ssh"] },
            role: { type: "string", enum: ["main", "module", "deploy", "dependency", "test", "staging", "custom"] },
            path: { type: "string", description: "Local filesystem path (for type=local)" },
            sshConfig: {
              type: "object",
              description: "SSH config (for type=ssh)",
              properties: {
                host: { type: "string" },
                port: { type: "number" },
                username: { type: "string" },
                password: { type: "string" },
                privateKeyPath: { type: "string" },
                remoteCwd: { type: "string" },
              },
            },
            dependsOn: {
              type: "array",
              items: { type: "string" },
              description: "IDs of nodes this node depends on",
            },
            nodeDescription: { type: "string" },
          },
        },
      },
      primaryNodeId: {
        type: "string",
        description: "ID of the primary node (for create)",
      },
      node: {
        type: "object",
        description: "Single node definition (for add-node)",
        properties: {
          id: { type: "string" },
          label: { type: "string" },
          type: { type: "string", enum: ["local", "ssh"] },
          role: { type: "string", enum: ["main", "module", "deploy", "dependency", "test", "staging", "custom"] },
          path: { type: "string" },
          sshConfig: { type: "object" },
          dependsOn: { type: "array", items: { type: "string" } },
          nodeDescription: { type: "string" },
        },
      },
      nodeId: {
        type: "string",
        description: "Node ID (for remove-node)",
      },
    },
    required: ["action"],
  },
  async execute(args, _cwd, _signal) {
    const action = args.action as string;
    const validActions = ["create", "list", "activate", "deactivate", "delete", "add-node", "remove-node", "status", "topology", "update", "health"];
    if (!validActions.includes(action)) {
      return formatUnknownActionError(action, validActions);
    }

    try {
      if (action === "health") {
        return await workspaceChainManager.getChainHealth();
      }
      if (action === "list") {
        const chains = getWorkspaceChains();
        if (chains.length === 0) {
          return "No workspace chains found. Use action 'create' to create one.";
        }
        const activeId = getActiveChainId();
        const lines = chains.map(c => {
          const isActive = c.id === activeId ? " [ACTIVE]" : "";
          const nodeCount = c.nodes.length;
          const nodeSummary = c.nodes.map(n => `${n.id}(${n.type}:${n.role})`).join(", ");
          return `- ${c.id}: ${c.name}${isActive} — ${nodeCount} nodes [${nodeSummary}]`;
        });
        return `Workspace Chains:\n${lines.join("\n")}`;
      }

      if (action === "create") {
        const name = args.name as string;
        if (!name) return "Error: 'name' parameter is required for create.";
        const nodesRaw = args.nodes as any[];
        if (!nodesRaw || nodesRaw.length === 0) {
          return "Error: 'nodes' array is required for create.";
        }
        const primaryNodeId = args.primaryNodeId as string;
        if (!primaryNodeId) {
          return "Error: 'primaryNodeId' is required for create.";
        }
        const nodes: WorkspaceNode[] = nodesRaw.map(n => ({
          id: n.id || generateNodeId(n.label || "node"),
          label: n.label,
          type: n.type,
          role: n.role || "module",
          path: n.path,
          sshConfig: n.sshConfig,
          dependsOn: n.dependsOn,
          description: n.nodeDescription || n.description,
        }));
        const chain = createWorkspaceChain(
          name,
          args.description as string | undefined,
          nodes,
          primaryNodeId
        );
        return `Workspace chain created: ${chain.id} (${chain.name})\nNodes: ${chain.nodes.map(n => n.id).join(", ")}\nUse action 'activate' with chainId '${chain.id}' to activate it.`;
      }

      if (action === "activate") {
        const chainId = args.chainId as string;
        if (!chainId) return "Error: 'chainId' is required for activate.";
        const chain = await workspaceChainManager.activateChain(chainId);
        const topology = formatChainTopology(chain, chain.primaryNodeId);
        return `Workspace chain activated: ${chain.name} (${chain.id})\n\n${topology}`;
      }

      if (action === "deactivate") {
        await workspaceChainManager.deactivateChain();
        return "Workspace chain deactivated. All SSH connections closed.";
      }

      if (action === "delete") {
        const chainId = args.chainId as string;
        if (!chainId) return "Error: 'chainId' is required for delete.";
        const chain = getWorkspaceChain(chainId);
        if (!chain) return `Error: Chain not found: ${chainId}`;
        if (getActiveChainId() === chainId) {
          await workspaceChainManager.deactivateChain();
        }
        deleteWorkspaceChain(chainId);
        return `Workspace chain deleted: ${chainId}`;
      }

      if (action === "add-node") {
        const chainId = args.chainId as string;
        if (!chainId) return "Error: 'chainId' is required for add-node.";
        const nodeRaw = args.node as any;
        if (!nodeRaw) return "Error: 'node' is required for add-node.";
        const node: WorkspaceNode = {
          id: nodeRaw.id || generateNodeId(nodeRaw.label || "node"),
          label: nodeRaw.label,
          type: nodeRaw.type,
          role: nodeRaw.role || "module",
          path: nodeRaw.path,
          sshConfig: nodeRaw.sshConfig,
          dependsOn: nodeRaw.dependsOn,
          description: nodeRaw.nodeDescription || nodeRaw.description,
        };
        const chain = addNodeToChain(chainId, node);
        return `Node added to chain: ${node.id} (${node.label}) → ${chain.name}\nChain now has ${chain.nodes.length} nodes.`;
      }

      if (action === "remove-node") {
        const chainId = args.chainId as string;
        if (!chainId) return "Error: 'chainId' is required for remove-node.";
        const nodeId = args.nodeId as string;
        if (!nodeId) return "Error: 'nodeId' is required for remove-node.";
        const chain = removeNodeFromChain(chainId, nodeId);
        return `Node removed from chain: ${nodeId} → ${chain.name}\nChain now has ${chain.nodes.length} nodes.`;
      }

      if (action === "status") {
        if (!workspaceChainManager.isChainActive()) {
          return "No active workspace chain. Use 'activate' to activate one.";
        }
        const status = workspaceChainManager.getConnectionStatus();
        const activeNodeId = workspaceChainManager.getActiveNodeId();
        const lines = status.map(s => {
          const marker = s.nodeId === activeNodeId ? " [ACTIVE]" : "";
          return `- ${s.nodeId}: type=${s.type}, connected=${s.connected}${marker}`;
        });
        return `Chain Connection Status:\n${lines.join("\n")}`;
      }

      if (action === "topology") {
        const chainId = args.chainId as string;
        let chain;
        if (chainId) {
          chain = getWorkspaceChain(chainId);
        } else {
          chain = workspaceChainManager.getActiveChain();
        }
        if (!chain) {
          return chainId
            ? `Chain not found: ${chainId}`
            : "No active workspace chain. Use 'activate' or provide 'chainId'.";
        }
        const activeNodeId = workspaceChainManager.getActiveNodeId();
        return formatChainTopology(chain, activeNodeId || undefined);
      }

      if (action === "update") {
        const chainId = args.chainId as string;
        if (!chainId) return "Error: 'chainId' is required for update.";
        const updates: any = {};
        if (args.name) updates.name = args.name;
        if (args.description !== undefined) updates.description = args.description;
        if (args.primaryNodeId) updates.primaryNodeId = args.primaryNodeId;
        const chain = updateWorkspaceChain(chainId, updates);
        return `Workspace chain updated: ${chain.id} (${chain.name})`;
      }

      return `Unknown action: ${action}`;
    } catch (err: any) {
      return `Error: ${err.message || err}`;
    }
  },
};

// ─── cross_workspace_exec Tool ────────────────────────────────────────────────

export const crossWorkspaceExecTool: Tool = {
  name: "cross_workspace_exec",
  description:
    "Execute operations on specific workspace chain nodes. " +
    "Supports: exec (command), read (file), write (file), exec-all (all nodes), exec-deps (dependency nodes). " +
    "Requires an active workspace chain. Use manage_workspace_chain to activate first.",
  parameters: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        enum: ["exec", "read", "write", "exec-all", "exec-deps", "connect", "disconnect", "switch-node", "health", "diff", "sync"],
        description:
          "Operation: 'exec' (run command on node), 'read' (read file from node), 'write' (write file to node), " +
          "'exec-all' (run command on all nodes), 'exec-deps' (run on dependency nodes), " +
          "'connect' (connect SSH node), 'disconnect' (disconnect SSH node), 'switch-node' (change active node), " +
          "'health' (monitoring dashboard), 'diff' (compare file between nodes), 'sync' (copy file from source node to target node)",
      },
      nodeId: {
        type: "string",
        description: "Target node ID (for exec, read, write, connect, disconnect, switch-node)",
      },
      sourceNodeId: {
        type: "string",
        description: "Source node ID (for diff, sync)",
      },
      targetNodeId: {
        type: "string",
        description: "Target node ID (for diff, sync)",
      },
      targetPath: {
        type: "string",
        description: "Destination file path on target node (optional for sync, defaults to filePath)",
      },
      command: {
        type: "string",
        description: "Shell command to execute (for exec, exec-all, exec-deps)",
      },
      filePath: {
        type: "string",
        description: "File path (for read, write)",
      },
      content: {
        type: "string",
        description: "File content (for write)",
      },
      cwd: {
        type: "string",
        description: "Working directory (optional, defaults to node's path/remoteCwd)",
      },
      timeoutMs: {
        type: "number",
        description: "Timeout in ms (optional, default 600000)",
      },
    },
    required: ["operation"],
  },
  async execute(args, _cwd, _signal) {
    const operation = args.operation as string;
    const validOps = ["exec", "read", "write", "exec-all", "exec-deps", "connect", "disconnect", "switch-node", "health", "diff", "sync"];
    if (!validOps.includes(operation)) {
      return formatUnknownActionError(operation, validOps);
    }

    try {
      if (!workspaceChainManager.isChainActive()) {
        workspaceChainManager.loadActiveChain();
      }
      if (!workspaceChainManager.isChainActive()) {
        return "Error: No active workspace chain. Use 'manage_workspace_chain' with action 'activate' first.";
      }

      if (operation === "health") {
        return await workspaceChainManager.getChainHealth();
      }

      if (operation === "diff") {
        const sourceNodeId = (args.sourceNodeId || args.nodeId) as string;
        const targetNodeId = args.targetNodeId as string;
        const filePath = args.filePath as string;
        if (!sourceNodeId) return "Error: 'sourceNodeId' (or 'nodeId') is required for diff.";
        if (!targetNodeId) return "Error: 'targetNodeId' is required for diff.";
        if (!filePath) return "Error: 'filePath' is required for diff.";
        return await workspaceChainManager.diffNodes(sourceNodeId, targetNodeId, filePath);
      }

      if (operation === "sync") {
        const sourceNodeId = (args.sourceNodeId || args.nodeId) as string;
        const targetNodeId = args.targetNodeId as string;
        const filePath = args.filePath as string;
        if (!sourceNodeId) return "Error: 'sourceNodeId' (or 'nodeId') is required for sync.";
        if (!targetNodeId) return "Error: 'targetNodeId' is required for sync.";
        if (!filePath) return "Error: 'filePath' is required for sync.";
        return await workspaceChainManager.syncNodes(
          sourceNodeId,
          targetNodeId,
          filePath,
          args.targetPath as string | undefined
        );
      }

      if (operation === "exec") {
        const nodeId = args.nodeId as string;
        if (!nodeId) return "Error: 'nodeId' is required for exec.";
        const command = args.command as string;
        if (!command) return "Error: 'command' is required for exec.";
        const res = await workspaceChainManager.execOnNode(
          nodeId,
          command,
          args.cwd as string | undefined,
          (args.timeoutMs as number) || 600000
        );
        const node = workspaceChainManager.getNode(nodeId);
        const header = `[Node: ${node?.label || nodeId} (${node?.type})]`;
        let output = res.stdout;
        if (res.stderr) output += (output ? "\n--- STDERR ---\n" : "") + res.stderr;
        if (res.exitCode !== 0) output += `\n[Exit code: ${res.exitCode}]`;
        return `${header}\n${output || "(no output)"}`;
      }

      if (operation === "read") {
        const nodeId = args.nodeId as string;
        if (!nodeId) return "Error: 'nodeId' is required for read.";
        const filePath = args.filePath as string;
        if (!filePath) return "Error: 'filePath' is required for read.";
        const content = await workspaceChainManager.readFileFromNode(nodeId, filePath);
        const node = workspaceChainManager.getNode(nodeId);
        const header = `[Node: ${node?.label || nodeId} | File: ${filePath}]`;
        return `${header}\n${content}`;
      }

      if (operation === "write") {
        const nodeId = args.nodeId as string;
        if (!nodeId) return "Error: 'nodeId' is required for write.";
        const filePath = args.filePath as string;
        if (!filePath) return "Error: 'filePath' is required for write.";
        const content = args.content as string;
        if (content === undefined) return "Error: 'content' is required for write.";
        await workspaceChainManager.writeFileToNode(nodeId, filePath, content);
        const node = workspaceChainManager.getNode(nodeId);
        return `File written: ${filePath} on node ${node?.label || nodeId}`;
      }

      if (operation === "exec-all") {
        const command = args.command as string;
        if (!command) return "Error: 'command' is required for exec-all.";
        const results = await workspaceChainManager.execOnAllNodes(
          command,
          args.cwd as string | undefined,
          args.timeoutMs as number | undefined
        );
        const sections = results.map(r => {
          const status = r.success ? "OK" : "FAILED";
          const errLine = r.error ? `\n  Error: ${r.error}` : "";
          return `[${r.nodeLabel} (${r.nodeId})] — ${status}\n  ${r.output}${errLine}`;
        });
        return `Cross-Workspace Results (exec-all: "${command}"):\n\n${sections.join("\n\n")}`;
      }

      if (operation === "exec-deps") {
        const command = args.command as string;
        if (!command) return "Error: 'command' is required for exec-deps.";
        const results = await workspaceChainManager.execOnDependencyNodes(
          command,
          args.cwd as string | undefined,
          args.timeoutMs as number | undefined
        );
        if (results.length === 0) {
          return "No dependency nodes found for the active node.";
        }
        const sections = results.map(r => {
          const status = r.success ? "OK" : "FAILED";
          const errLine = r.error ? `\n  Error: ${r.error}` : "";
          return `[${r.nodeLabel} (${r.nodeId})] — ${status}\n  ${r.output}${errLine}`;
        });
        return `Cross-Workspace Results (exec-deps: "${command}"):\n\n${sections.join("\n\n")}`;
      }

      if (operation === "connect") {
        const nodeId = args.nodeId as string;
        if (!nodeId) return "Error: 'nodeId' is required for connect.";
        const node = workspaceChainManager.getNode(nodeId);
        if (!node) return `Error: Node not found: ${nodeId}`;
        if (node.type !== "ssh") return `Error: Node ${nodeId} is not an SSH node.`;
        await workspaceChainManager.connectSshNode(nodeId);
        return `SSH node connected: ${node.label} (${nodeId})`;
      }

      if (operation === "disconnect") {
        const nodeId = args.nodeId as string;
        if (!nodeId) return "Error: 'nodeId' is required for disconnect.";
        await workspaceChainManager.disconnectNode(nodeId);
        return `SSH node disconnected: ${nodeId}`;
      }

      if (operation === "switch-node") {
        const nodeId = args.nodeId as string;
        if (!nodeId) return "Error: 'nodeId' is required for switch-node.";
        const success = workspaceChainManager.setActiveNode(nodeId);
        if (!success) return `Error: Node not found in active chain: ${nodeId}`;
        const node = workspaceChainManager.getNode(nodeId);
        return `Active node switched to: ${node?.label} (${nodeId})`;
      }

      return `Unknown operation: ${operation}`;
    } catch (err: any) {
      return `Error: ${err.message || err}`;
    }
  },
};
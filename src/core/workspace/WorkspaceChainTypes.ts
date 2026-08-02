/**
 * WorkspaceChainTypes.ts — Type definitions for workspace chaining.
 *
 * A workspace chain links multiple workspaces (local or SSH) into a directed
 * graph so the AI agent understands cross-workspace relationships and can
 * operate on any node in the chain.
 */

/** Type of workspace node */
export type WorkspaceNodeType = "local" | "ssh";

/** Role of a workspace node within the chain */
export type WorkspaceNodeRole =
  | "main"        // Primary project workspace
  | "module"      // Submodule / dependency of another workspace
  | "deploy"      // Deployment target
  | "dependency"  // External dependency
  | "test"        // Test environment
  | "staging"     // Staging environment
  | "custom";     // User-defined role

/** SSH connection config for a workspace node */
export interface WorkspaceNodeSshConfig {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKeyPath?: string;
  remoteCwd: string;
  readyTimeout?: number;
  compression?: boolean;
  agentForward?: boolean;
  proxyJump?: string;
  bandwidthLimit?: number;
  /** Extra absolute paths allowed in addition to remoteCwd */
  additionalAllowedPaths?: string[];
}

/** A single workspace node in a chain */
export interface WorkspaceNode {
  /** Unique identifier within the chain (short, alphanumeric, hyphens) */
  id: string;
  /** Human-readable label */
  label: string;
  /** Node type: local or SSH */
  type: WorkspaceNodeType;
  /** Role within the chain */
  role: WorkspaceNodeRole;
  /** Local filesystem path (for type="local") */
  path?: string;
  /** SSH config (for type="ssh") */
  sshConfig?: WorkspaceNodeSshConfig;
  /** IDs of nodes this node depends on */
  dependsOn?: string[];
  /** Free-form description of this node's purpose */
  description?: string;
}

/** A workspace chain linking multiple workspace nodes */
export interface WorkspaceChain {
  /** Unique chain identifier (short, alphanumeric, hyphens) */
  id: string;
  /** Human-readable chain name */
  name: string;
  /** Chain description */
  description?: string;
  /** Ordered list of workspace nodes */
  nodes: WorkspaceNode[];
  /** ID of the primary/default node */
  primaryNodeId: string;
  /** Timestamp (ms) of creation */
  createdAt: number;
  /** Timestamp (ms) of last update */
  updatedAt: number;
}

/** Active chain state tracked at runtime */
export interface ActiveChainState {
  chainId: string;
  /** Currently focused node ID */
  activeNodeId: string;
  /** Connected SSH node IDs */
  connectedSshNodes: Set<string>;
}

/** Result of a cross-workspace operation */
export interface CrossWorkspaceResult {
  nodeId: string;
  nodeLabel: string;
  success: boolean;
  output: string;
  error?: string;
}

/** Helper: generate a unique node ID from a label */
export function generateNodeId(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || `node-${Date.now()}`;
}

/** Helper: generate a unique chain ID from a name */
export function generateChainId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || `chain-${Date.now()}`;
}

/** Helper: validate a workspace chain structure */
export function validateChain(chain: WorkspaceChain): string[] {
  const errors: string[] = [];
  if (!chain.id) errors.push("Chain ID is required");
  if (!chain.name) errors.push("Chain name is required");
  if (!chain.nodes || chain.nodes.length === 0) {
    errors.push("Chain must have at least one node");
    return errors;
  }
  const nodeIds = new Set<string>();
  for (const node of chain.nodes) {
    if (!node.id) errors.push(`Node missing ID`);
    if (nodeIds.has(node.id)) errors.push(`Duplicate node ID: ${node.id}`);
    nodeIds.add(node.id);
    if (!node.label) errors.push(`Node ${node.id} missing label`);
    if (node.type === "local" && !node.path) {
      errors.push(`Node ${node.id} (local) missing path`);
    }
    if (node.type === "ssh" && !node.sshConfig) {
      errors.push(`Node ${node.id} (ssh) missing sshConfig`);
    }
    if (node.dependsOn) {
      for (const depId of node.dependsOn) {
        if (!nodeIds.has(depId) && !chain.nodes.some(n => n.id === depId)) {
          errors.push(`Node ${node.id} depends on non-existent node: ${depId}`);
        }
      }
    }
  }
  if (!nodeIds.has(chain.primaryNodeId)) {
    errors.push(`Primary node ID "${chain.primaryNodeId}" not found in nodes`);
  }
  return errors;
}

/** Helper: format a chain as a human-readable topology string */
export function formatChainTopology(chain: WorkspaceChain, activeNodeId?: string): string {
  const lines: string[] = [];
  lines.push(`Chain: ${chain.name} (${chain.id})`);
  if (chain.description) lines.push(`Description: ${chain.description}`);
  lines.push("");
  lines.push("Nodes:");
  for (const node of chain.nodes) {
    const isActive = node.id === activeNodeId;
    const isPrimary = node.id === chain.primaryNodeId;
    const markers = [
      isActive ? "[ACTIVE]" : "",
      isPrimary ? "[PRIMARY]" : "",
    ].filter(Boolean).join(" ");
    const location = node.type === "ssh"
      ? `${node.sshConfig?.username}@${node.sshConfig?.host}:${node.sshConfig?.port}${node.sshConfig?.remoteCwd}`
      : node.path || "(no path)";
    const deps = node.dependsOn?.length ? ` → depends: [${node.dependsOn.join(", ")}]` : "";
    lines.push(`  - ${node.id}: ${node.label} (${node.role}) ${markers}`);
    lines.push(`    Type: ${node.type} | Location: ${location}${deps}`);
    if (node.description) lines.push(`    Description: ${node.description}`);
  }
  return lines.join("\n");
}
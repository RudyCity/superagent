import path from "node:path";
import { getWorkspaceChains } from "../../workspace/WorkspaceChainConfig.js";
import { manageWorkspaceChainTool, crossWorkspaceExecTool } from "../../workspace/workspaceChainTools.js";
import { isFullYoloMode } from "../../permissions.js";
import { listProjects } from "../../project/projectRegistry.js";
import { workspaceMode } from "../../ssh/workspaceMode.js";

export const WORKSPACE_CHAIN_MCP_TOOL_CLASSIFICATIONS: Record<string, "safe" | "dangerous"> = {
  superagent_list_workspace_chains: "safe",
  superagent_manage_workspace_chain: "dangerous",
  superagent_cross_workspace_exec: "dangerous",
};

const sshConfigSchema = {
  type: "object",
  description: "SSH connection target using a key path or SSH config. Passwords and inline secrets are not accepted by the MCP interface.",
  properties: {
    host: { type: "string", minLength: 1 },
    port: { type: "integer", minimum: 1, maximum: 65535 },
    username: { type: "string", minLength: 1 },
    privateKeyPath: { type: "string" },
    remoteCwd: { type: "string", minLength: 1 },
    readyTimeout: { type: "integer", minimum: 1000, maximum: 120000 },
    compression: { type: "boolean" },
    agentForward: { type: "boolean" },
    proxyJump: { type: "string" },
    bandwidthLimit: { type: "integer", minimum: 0 },
    additionalAllowedPaths: { type: "array", items: { type: "string" }, maxItems: 20 },
  },
  required: ["host", "port", "username", "remoteCwd"],
} as const;

const nodeSchema = {
  type: "object",
  properties: {
    id: { type: "string", maxLength: 63 },
    label: { type: "string", minLength: 1, maxLength: 120 },
    type: { type: "string", enum: ["local", "ssh"] },
    role: { type: "string", enum: ["main", "module", "deploy", "dependency", "test", "staging", "custom"] },
    path: { type: "string" },
    sshConfig: sshConfigSchema,
    dependsOn: { type: "array", items: { type: "string" }, maxItems: 50 },
    nodeDescription: { type: "string", maxLength: 500 },
  },
  required: ["label", "type"],
} as const;

export const WORKSPACE_CHAIN_MCP_TOOL_DEFS = [
  {
    name: "superagent_list_workspace_chains",
    description: "Read-only list of Workspace Chains visible from the current MCP workspace. Shows chain IDs, node labels/types, and active selection; does not connect to SSH or change config.",
    inputSchema: { type: "object", properties: { workspace: { type: "string" }, projectId: { type: "string" } } },
  },
  {
    name: "superagent_manage_workspace_chain",
    description: "Manage Workspace Chains across local/SSH projects (create/list/activate/deactivate/delete/add-node/remove-node/status/topology/update/health). Mutating or connection actions require SuperAgent Full YOLO mode. SSH passwords or inline secrets are rejected; use SSH keys/config.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["create", "list", "activate", "deactivate", "delete", "add-node", "remove-node", "status", "topology", "update", "health"] },
        chainId: { type: "string", maxLength: 63 },
        name: { type: "string", maxLength: 120 },
        description: { type: "string", maxLength: 500 },
        nodes: { type: "array", items: nodeSchema, maxItems: 50 },
        primaryNodeId: { type: "string", maxLength: 63 },
        node: nodeSchema,
        nodeId: { type: "string", maxLength: 63 },
        workspace: { type: "string" },
        projectId: { type: "string" },
      },
      required: ["action"],
    },
  },
  {
    name: "superagent_cross_workspace_exec",
    description: "Run/read/write/diff/sync across nodes of an active Workspace Chain. This can execute commands or mutate remote files; requires SuperAgent Full YOLO mode and an explicit registered chain project context.",
    inputSchema: {
      type: "object",
      properties: {
        operation: { type: "string", enum: ["exec", "read", "write", "exec-all", "exec-deps", "connect", "disconnect", "switch-node", "health", "diff", "sync"] },
        nodeId: { type: "string", maxLength: 63 },
        sourceNodeId: { type: "string", maxLength: 63 },
        targetNodeId: { type: "string", maxLength: 63 },
        targetPath: { type: "string" },
        command: { type: "string", maxLength: 20000 },
        filePath: { type: "string" },
        content: { type: "string", maxLength: 2000000 },
        cwd: { type: "string" },
        timeoutMs: { type: "integer", minimum: 1000, maximum: 600000 },
        dryRun: { type: "boolean" },
        checksumCheck: { type: "boolean" },
        direction: { type: "string", enum: ["push", "pull"] },
        workspace: { type: "string" },
        projectId: { type: "string" },
      },
      required: ["operation"],
    },
  },
] as const;

function getChainsForWorkspace(workspace: string) {
  const allChains = () => getWorkspaceChains(undefined, false);
  if (workspace.startsWith("chain:")) {
    return allChains().filter((chain) => chain.id === workspace.slice("chain:".length));
  }
  if (/^ssh:/i.test(workspace)) {
    let target: URL;
    try { target = new URL(workspace); } catch { return []; }
    if (target.protocol !== "ssh:") return [];
    const username = decodeURIComponent(target.username || "").toLowerCase();
    const host = target.hostname.toLowerCase();
    const port = target.port ? Number(target.port) : 22;
    let remotePath = decodeURIComponent(target.pathname || "/");
    while (remotePath.length > 1 && remotePath.endsWith("/")) remotePath = remotePath.slice(0, -1);
    return allChains().filter((chain) => chain.nodes.some((node) => {
      if (node.type !== "ssh" || !node.sshConfig) return false;
      const config = node.sshConfig;
      if (config.host.toLowerCase() !== host || config.username.toLowerCase() !== username || config.port !== port) return false;
      let root = (config.remoteCwd || "/").replaceAll(String.fromCharCode(92), "/");
      while (root.length > 1 && root.endsWith("/")) root = root.slice(0, -1);
      const relative = path.posix.relative(root, remotePath);
      return relative === "" || (relative !== ".." && !relative.startsWith("../") && !path.posix.isAbsolute(relative));
    }));
  }
  // Run in an isolated local-mode scope; another session's SSH state must not
  // influence a read-only chain listing for a local project.
  return workspaceMode.runWithWorkspaceConfig(undefined, () => getWorkspaceChains(workspace, true));
}

function resultText(value: unknown, isError = false) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

function rejectInlineSshSecrets(args: Record<string, unknown>): void {
  const nodes = [
    ...(Array.isArray(args.nodes) ? args.nodes : []),
    ...(args.node && typeof args.node === "object" ? [args.node] : []),
  ] as Array<Record<string, unknown>>;
  for (const node of nodes) {
    if (!node || typeof node !== "object" || !node.sshConfig || typeof node.sshConfig !== "object") continue;
    const sshConfig = node.sshConfig as Record<string, unknown>;
    const inlineSecretKeys = Object.keys(sshConfig).filter((key) => /(?:password|passphrase|token|secret|privatekey(?!path)|access.?key|bearer)/i.test(key));
    if (inlineSecretKeys.length > 0) {
      throw new Error("Inline SSH passwords/private-key contents/tokens are not accepted over MCP. Use privateKeyPath or the user's SSH config.");
    }
  }
}

function requireFullYolo(toolName: string): void {
  if (!isFullYoloMode()) {
    throw new Error(`${toolName} can change chain configuration, open SSH sessions, execute commands, or modify remote files. Enable SuperAgent Full YOLO mode locally before using this MCP tool.`);
  }
}

export async function dispatchWorkspaceChainMcpTool(
  name: string,
  args: Record<string, unknown>,
  workspace: string,
): Promise<any | null> {
  if (!Object.prototype.hasOwnProperty.call(WORKSPACE_CHAIN_MCP_TOOL_CLASSIFICATIONS, name)) return null;
  try {
    if (name === "superagent_list_workspace_chains") {
      const chainsInScope = getChainsForWorkspace(workspace);
      const chains = chainsInScope.map((chain) => ({
        id: chain.id,
        name: chain.name,
        description: chain.description,
        primaryNodeId: chain.primaryNodeId,
        nodes: chain.nodes.map((node) => ({ id: node.id, label: node.label, type: node.type, role: node.role, path: node.path, sshTarget: node.type === "ssh" && node.sshConfig ? `${node.sshConfig.username}@${node.sshConfig.host}:${node.sshConfig.port}${node.sshConfig.remoteCwd}` : undefined })),
      }));
      return resultText({ count: chains.length, chains });
    }

    requireFullYolo(name);
    if (name === "superagent_manage_workspace_chain") {
      rejectInlineSshSecrets(args);
      const clonedArgs = { ...args } as Record<string, unknown>;
      if (typeof clonedArgs.chainId !== "string" && workspace.startsWith("chain:")) {
        clonedArgs.chainId = workspace.slice("chain:".length);
      }
      const result = await manageWorkspaceChainTool.execute(clonedArgs as any, workspace);
      const isError = typeof result === "string" && /^Error:/i.test(result);
      return resultText(result, isError);
    }

    if (!/^chain:[a-z0-9][a-z0-9-]*$/i.test(workspace)) {
      throw new Error("Select a registered Workspace Chain project first using projectId (type=chain) or a validated chain:<id> workspace target.");
    }
    const chainId = workspace.slice("chain:".length).toLowerCase();
    const registeredChain = listProjects().some((project) => project.enabled && project.type === "chain" && project.target?.toLowerCase() === `chain:${chainId}`);
    if (!registeredChain) throw new Error(`Workspace Chain ${chainId} is not registered as an enabled MCP project.`);
    const result = await crossWorkspaceExecTool.execute(args as any, workspace);
    const isError = typeof result === "string" && /^Error:/i.test(result);
    return resultText(result, isError);
  } catch (error) {
    return resultText(error instanceof Error ? error.message : String(error), true);
  }
}

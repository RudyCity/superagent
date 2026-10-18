import { CHROME_MCP_TOOL_CLASSIFICATIONS } from "./tools/chromeMcpTools.js";
import { DIAGNOSTICS_MCP_TOOL_CLASSIFICATIONS } from "./tools/diagnosticsMcpTools.js";
import { PLAN_SKILLS_MCP_TOOL_CLASSIFICATIONS } from "./tools/planSkillsMcpTools.js";
import { NETWORK_CONTENT_MCP_TOOL_CLASSIFICATIONS } from "./tools/networkContentMcpTools.js";
import { REMOTE_AGENT_MCP_TOOL_CLASSIFICATIONS } from "./tools/remoteAgentMcpTools.js";
import { PROJECT_MCP_TOOL_CLASSIFICATIONS } from "./tools/projectTools.js";
import { WORKSPACE_CHAIN_MCP_TOOL_CLASSIFICATIONS } from "./tools/workspaceChainMcpTools.js";

/**
 * Tool classification for behavior annotations and the tunnel allowlist.
 * "safe"      = read-only observability; exposed by default.
 * "dangerous" = can execute commands, mutate files/state, control agents;
 *               requires explicit opt-in.
 */
export const MCP_TOOL_CLASSIFICATION: Record<string, "safe" | "dangerous"> = {
  // ---- safe: read-only ----
  superagent_list_active: "safe",
  superagent_get_process_status: "safe",
  superagent_get_status: "safe",
  superagent_get_logs: "safe",
  superagent_read_file: "safe",
  superagent_read_files: "safe",
  superagent_list_projects: "safe",
  superagent_get_project: "safe",
  superagent_list_project_access: "safe",
  superagent_list_files: "safe",
  superagent_grep_search: "safe",
  superagent_find_files: "safe",
  superagent_get_config: "safe",
  superagent_get_workspace: "safe",
  superagent_get_current_task: "safe",
  superagent_get_instance_task: "safe",
  superagent_get_plan_and_tasks: "safe",
  superagent_memory_search: "safe",
  superagent_query_history: "safe",
  superagent_get_token_usage: "safe",
  superagent_server_health: "safe",
  superagent_get_remote_status: "safe",
  superagent_export_session: "safe",
  // ---- dangerous: mutation / execution / control ----
  superagent_exec_command: "dangerous",
  superagent_write_file: "dangerous",
  superagent_write_files: "dangerous",
  superagent_unlock_file: "dangerous",
  superagent_interrupt: "dangerous",
  superagent_pause: "dangerous",
  superagent_resume: "dangerous",
  superagent_send_message: "dangerous",
  superagent_run_task: "dangerous",
  superagent_invoke: "dangerous",
  superagent_cli_bridge: "dangerous",
  superagent_await: "dangerous",
  superagent_merge: "dangerous",
  superagent_manage: "dangerous",
  superagent_manage_worktrees: "dangerous",
  superagent_update_tasks: "dangerous",
  superagent_memory_save: "dangerous",
  superagent_switch_preset: "dangerous",
  superagent_switch_provider: "dangerous",
  superagent_switch_workspace: "dangerous",
  superagent_compact_context: "dangerous",
  superagent_remote_chrome: "dangerous",
  ...CHROME_MCP_TOOL_CLASSIFICATIONS,
  ...DIAGNOSTICS_MCP_TOOL_CLASSIFICATIONS,
  ...PLAN_SKILLS_MCP_TOOL_CLASSIFICATIONS,
  ...NETWORK_CONTENT_MCP_TOOL_CLASSIFICATIONS,
  ...REMOTE_AGENT_MCP_TOOL_CLASSIFICATIONS,
  ...PROJECT_MCP_TOOL_CLASSIFICATIONS,
  ...WORKSPACE_CHAIN_MCP_TOOL_CLASSIFICATIONS,
};

/** Tools that must never be discoverable or callable over the MCP interface. */
export const DISABLED_MCP_TOOLS: ReadonlySet<string> = new Set([
  // Agent execution/control is disabled from MCP exposure.
  // These actions must only be performed through local SuperAgent runtime.
  "superagent_run_task",
  "superagent_send_message",
  "superagent_interrupt",
  "superagent_pause",
  "superagent_resume",
  "superagent_cli_bridge",
  "superagent_invoke",
  "superagent_await",
  "superagent_merge",
  "superagent_manage",
  // Prefer Chrome DevTools Protocol automation; do not expose the legacy
  // extension bridge directly through the remote MCP interface.
  "superagent_remote_chrome",
  // Legacy single-file MCP endpoints are retained in code but disabled in discovery and dispatch.
  "superagent_read_file",
  "superagent_write_file",
]);

export interface McpToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** Behavior annotations derived from the safe/dangerous classification. */
export function getToolAnnotations(toolName: string): McpToolAnnotations | undefined {
  const level = MCP_TOOL_CLASSIFICATION[toolName];
  if (level === "safe") {
    return { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  }
  if (level === "dangerous") {
    return { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
  }
  return undefined;
}

export interface McpToolSecurityScheme {
  type: string;
  scheme?: string;
  scopes?: string[];
  note?: string;
}

/**
 * Per-tool security metadata for MCP clients (e.g. ChatGPT approvals).
 * Safe tools need read scope; dangerous tools need write scope in OAuth mode.
 */
export function getToolSecuritySchemes(
  toolName: string,
  authMode: "static-bearer" | "oauth" = "static-bearer"
): McpToolSecurityScheme[] {
  const level = MCP_TOOL_CLASSIFICATION[toolName];
  if (authMode === "oauth") {
    return level === "dangerous"
      ? [{ type: "oauth2", scopes: ["mcp:tools", "mcp:tools:write"] }]
      : [{ type: "oauth2", scopes: ["mcp:tools"] }];
  }
  return [
    {
      type: "http",
      scheme: "bearer",
      note:
        level === "dangerous"
          ? "dangerous tool: requires --allow-dangerous opt-in"
          : undefined,
    },
  ];
}

export interface McpServerOptions {
  /** If set, only these tool names are listed and callable (HTTP tunnel allowlist). When omitted, all tools are available (existing stdio behavior). */
  allowedTools?: string[];
  /** Audit hook invoked for every tool invocation attempt, including blocked-by-allowlist attempts. Must never throw. */
  onToolCall?: (info: {
    tool: string;
    args: unknown;
    ok: boolean;
    error?: string;
    durationMs?: number;
    correlationId?: string;
    principalHash?: string;
    projectId?: string | null;
    providerKind?: string | null;
    requiredCapability?: string;
    authorizationDecision?: "allowed" | "denied" | "not_applicable";
    errorCode?: string;
  }) => void;
  /** Auth mode for per-tool security metadata. Default "static-bearer". */
  authMode?: "static-bearer" | "oauth";
  /** If true, explicitly allow dangerous tools regardless of YOLO mode (e.g. CLI flag --allow-dangerous). */
  allowDangerous?: boolean;
  /** Optional getter for active client identity (OAuth scopes / subject). */
  getIdentity?: () => { mode: "static-bearer" | "oauth"; subject: string; scopes?: string[]; credentialHash?: string } | null;
  /** Optional workspace root for YOLO scope validation. Defaults to process.cwd(). */
  workspace?: string;
}


import { CHROME_MCP_TOOL_CLASSIFICATIONS } from "./tools/chromeMcpTools.js";
import { MOTION_MCP_TOOL_CLASSIFICATIONS } from "./tools/motionMcpTools.js";
import { DIAGNOSTICS_MCP_TOOL_CLASSIFICATIONS } from "./tools/diagnosticsMcpTools.js";
import { PLAN_SKILLS_MCP_TOOL_CLASSIFICATIONS } from "./tools/planSkillsMcpTools.js";
import { NETWORK_CONTENT_MCP_TOOL_CLASSIFICATIONS } from "./tools/networkContentMcpTools.js";
import { REMOTE_AGENT_MCP_TOOL_CLASSIFICATIONS } from "./tools/remoteAgentMcpTools.js";
import { PROJECT_MCP_TOOL_CLASSIFICATIONS } from "./tools/projectTools.js";
import { WORKSPACE_CHAIN_MCP_TOOL_CLASSIFICATIONS } from "./tools/workspaceChainMcpTools.js";
import { BRAIN_MCP_TOOL_CLASSIFICATIONS } from "./tools/brainMcpTools.js";

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
  superagent_tool_search: "safe",
  superagent_tool_describe: "safe",
  superagent_tool_status: "safe",
  // The gateway router is safe to invoke: it re-authorizes the selected
  // target and cannot elevate scopes or bypass the HTTP tool allowlist.
  superagent_tool_execute: "safe",
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
  ...MOTION_MCP_TOOL_CLASSIFICATIONS,
  ...DIAGNOSTICS_MCP_TOOL_CLASSIFICATIONS,
  ...PLAN_SKILLS_MCP_TOOL_CLASSIFICATIONS,
  ...NETWORK_CONTENT_MCP_TOOL_CLASSIFICATIONS,
  ...REMOTE_AGENT_MCP_TOOL_CLASSIFICATIONS,
  ...PROJECT_MCP_TOOL_CLASSIFICATIONS,
  ...WORKSPACE_CHAIN_MCP_TOOL_CLASSIFICATIONS,
  ...BRAIN_MCP_TOOL_CLASSIFICATIONS,
};

/**
 * Registry and access-grant mutation requires a separately consented OAuth
 * admin scope. Ordinary write grants cannot elevate project permissions.
 * Static-bearer / stdio retain their local policy enforcement.
 */
export const PRIVILEGED_MCP_TOOLS: ReadonlySet<string> = new Set([
  "superagent_register_project",
  "superagent_update_project",
  "superagent_remove_project",
  "superagent_grant_project_access",
  "superagent_revoke_project_access",
]);

/** Tools that must never be discoverable or callable over the MCP interface. */
export const DISABLED_MCP_TOOLS: ReadonlySet<string> = new Set([
  // Agent lifecycle/control stays local-only. External CLI delegation is
  // exposed separately as a dangerous, workspace-scoped tool.
  "superagent_run_task",
  "superagent_send_message",
  "superagent_interrupt",
  "superagent_pause",
  "superagent_resume",
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

const annotationsCache = new Map<string, McpToolAnnotations | undefined>();

/** Behavior annotations derived from the safe/dangerous classification (memoized). */
export function getToolAnnotations(toolName: string): McpToolAnnotations | undefined {
  if (annotationsCache.has(toolName)) {
    return annotationsCache.get(toolName);
  }
  // The router can delegate to a mutating tool. Do not misrepresent it as
  // read-only in client approval UIs even though its entrypoint only needs
  // read scope; the target call enforces write/admin permissions as needed.
  let result: McpToolAnnotations | undefined;
  if (toolName === "superagent_tool_execute") {
    result = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
  } else {
    const level = MCP_TOOL_CLASSIFICATION[toolName];
    if (level === "safe") {
      result = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
    } else if (level === "dangerous") {
      result = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
    }
  }
  annotationsCache.set(toolName, result);
  return result;
}

export interface McpToolSecurityScheme {
  type: string;
  scheme?: string;
  scopes?: string[];
  note?: string;
}

const securitySchemesCache = new Map<string, McpToolSecurityScheme[]>();

/**
 * Per-tool security metadata for MCP clients (e.g. ChatGPT approvals) (memoized).
 * Safe tools need read scope; dangerous tools need write scope in OAuth mode.
 */
export function getToolSecuritySchemes(
  toolName: string,
  authMode: "static-bearer" | "oauth" = "static-bearer"
): McpToolSecurityScheme[] {
  const cacheKey = `${toolName}:${authMode}`;
  if (securitySchemesCache.has(cacheKey)) {
    return securitySchemesCache.get(cacheKey)!;
  }
  const level = MCP_TOOL_CLASSIFICATION[toolName];
  let result: McpToolSecurityScheme[];
  if (authMode === "oauth") {
    result = PRIVILEGED_MCP_TOOLS.has(toolName)
      ? [{ type: "oauth2", scopes: ["mcp:tools", "mcp:tools:write", "mcp:tools:admin"] }]
      : level === "dangerous"
        ? [{ type: "oauth2", scopes: ["mcp:tools", "mcp:tools:write"] }]
        : [{ type: "oauth2", scopes: ["mcp:tools"] }];
  } else {
    result = [
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
  securitySchemesCache.set(cacheKey, result);
  return result;
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
  /** Hard cap: this MCP instance NEVER unlocks dangerous tools via ambient YOLO, including gateway recursion. */
  lockSafeTools?: boolean;
  /** Optional getter for active client identity (OAuth scopes / subject). */
  getIdentity?: () => { mode: "static-bearer" | "oauth"; subject: string; scopes?: string[]; credentialHash?: string } | null;
  /** Optional workspace root for YOLO scope validation. Defaults to process.cwd(). */
  workspace?: string;
  /** Gateway (default): compact discovery and authorized execution; full: standalone tools. */
  toolExposure?: "full" | "gateway";
  /** If true, skip registering MCP resources and prompts for tool-only execution paths. */
  skipResourcesAndPrompts?: boolean;
}

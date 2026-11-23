import { fuzzyScore, rankToolsForIntent } from "../tools/toolDiscoveryTools.js";
import { getToolActionCapabilities } from "./mcpCapabilityMatrix.js";

export const MCP_GATEWAY_TOOL_NAMES = {
  search: "superagent_tool_search",
  describe: "superagent_tool_describe",
  execute: "superagent_tool_execute",
  status: "superagent_tool_status",
  preflight: "superagent_tool_preflight",
  doctor: "superagent_tool_doctor",
} as const;

/**
 * Core project/workspace lifecycle tools are eagerly advertised in Gateway mode.
 * They still pass through the normal authorized catalog first, so read-only
 * identities only see safe tools while mutation/admin tools remain hidden until
 * their original OAuth and MCP Security Approval policy allows them.
 */
export const MCP_GATEWAY_EAGER_PROJECT_WORKSPACE_TOOL_NAMES = Object.freeze([
  "superagent_get_workspace",
  "superagent_switch_workspace",
  "superagent_list_projects",
  "superagent_discover_projects",
  "superagent_get_project",
  "superagent_check_project_health",
  "superagent_import_discovered_project",
  "superagent_sync_projects",
  "superagent_register_project",
  "superagent_update_project",
  "superagent_remove_project",
  "superagent_list_project_access",
  "superagent_request_project_access",
  "superagent_grant_project_access",
  "superagent_revoke_project_access",
] as const);

// Stable, explicit MCP entrypoints for a connected Chrome Delegate profile.
// All operations stay dynamic via tool_search/tool_describe/tool_execute.
// Delegate tools are kept in discovery only (not eagerly advertised in the main
// catalog) to keep the initial tool list lean and prevent context window bloat.
export const MCP_GATEWAY_DELEGATE_TOOL_NAMES = Object.freeze([
  "superagent_delegate_read_chat",
  "superagent_delegate_list_chats",
  "superagent_delegate_read_chat_full",
  "superagent_delegate_search_history",
  "superagent_delegate_sync_history",
  "superagent_delegate_search_index",
  "superagent_delegate_doctor",
  "superagent_delegate_run_until_done",
  "superagent_delegate_inspect_chat_config",
  "superagent_delegate_configure_chat",
  "superagent_delegate_create_chat",
  "superagent_delegate_send_message",
  "superagent_delegate_stop_generation",
] as const);

export const MCP_GATEWAY_EAGER_DELEGATE_TOOL_NAMES = Object.freeze([] as readonly string[]);

export const MCP_GATEWAY_TOOL_DEFS = [
  {
    name: MCP_GATEWAY_TOOL_NAMES.search,
    description: "Find authorized SuperAgent MCP tools by task intent or keyword (e.g. 'delegate', 'chat history', 'browser', 'cdp', 'media', 'projects'). Returns short capability summaries. Use to discover specialized on-demand tools not pre-advertised in the main list.",
    inputSchema: {
      type: "object",
      properties: {
        intent: { type: "string", description: "Natural-language task description or intent." },
        query: { type: "string", description: "Short keyword or tool name (e.g. 'delegate', 'chat', 'history')." },
        limit: { type: "number", minimum: 1, maximum: 20, description: "Maximum matching tools to return. Default 8." },
      },
    },
  },
  {
    name: MCP_GATEWAY_TOOL_NAMES.describe,
    description: "Read the input schema and layered permission requirements for an authorized tool. Optional checkArguments is a non-executing preflight for superagent_desktop_ui or bounded read-only superagent_services_status only. Never requests approvals or grants and never inspects file paths. Runtime rechecks all layers.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Exact target tool name from superagent_tool_search." },
        checkArguments: { type: "object", additionalProperties: true,
          description: "Optional non-executing argument preflight for Desktop UI or read-only service metadata only; no host file/content or grant mutations." },
      },
      required: ["name"],
    },
  },
  {
    name: MCP_GATEWAY_TOOL_NAMES.execute,
    description: "Invoke any authorized SuperAgent MCP tool (including dynamic tools discovered via search like Delegate Chat & History, CDP, or media) using its exact name and arguments. Gateway recursion is blocked; all OAuth, Security Approval, and host file-policy checks are strictly enforced.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Exact target MCP tool name. Gateway recursion is blocked." },
        arguments: { type: "object", description: "Arguments matching the described target schema.", additionalProperties: true },
      },
      required: ["name"],
    },
  },
  {
    name: MCP_GATEWAY_TOOL_NAMES.status,
    description: "Report current MCP gateway catalog status: mode (gateway/full), visible tool count, initially advertised tools, and dynamic catalog visibility.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: MCP_GATEWAY_TOOL_NAMES.preflight,
    description: "Perform non-executing capability preflight for any SuperAgent MCP tool and action. Validates schema, OAuth, project grants, permanent host file-policy, native approval, runtime dependencies, service availability, target session leases, and boundary scopes before execution.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Target tool name." },
        action: { type: "string", description: "Optional specific action/subcommand (e.g. 'upload_file', 'navigate', 'commit')." },
        arguments: { type: "object", description: "Arguments planned for tool execution.", additionalProperties: true },
        projectId: { type: "string", description: "Active project ID if applicable." },
        identityHandle: { type: "string", description: "Caller identity handle if applicable." },
      },
      required: ["name"],
    },
  },
  {
    name: MCP_GATEWAY_TOOL_NAMES.doctor,
    description: "Run comprehensive diagnostic audit of the SuperAgent MCP catalog and action subcommands. Classifies discovery, schema validity, policy classification, authorization, dependency readiness, runtime reachability, smoke test execution, and end-to-end verification without executing unsafe mutations.",
    inputSchema: {
      type: "object",
      properties: {
        filter: { type: "string", description: "Optional tool name filter or category ('chrome', 'git', 'media', 'services', or 'all')." },
        runSmokeTests: { type: "boolean", description: "Whether to execute non-mutating read-only smoke tests. Default true." },
      },
    },
  },
] as const;

export type GatewayToolDef = { name: string; description?: string; inputSchema?: Record<string, unknown> };
const gatewayNames = new Set<string>(Object.values(MCP_GATEWAY_TOOL_NAMES));
const eagerProjectWorkspaceNames = new Set<string>(MCP_GATEWAY_EAGER_PROJECT_WORKSPACE_TOOL_NAMES);
const eagerDelegateNames = new Set<string>(MCP_GATEWAY_EAGER_DELEGATE_TOOL_NAMES);
export const MCP_GATEWAY_EAGER_CORE_TOOL_NAMES = Object.freeze([
  // Eager CDP and browser automation tools included in initial discovery
  "superagent_chrome_cdp_observe",
  "superagent_chrome_cdp_web",
  "superagent_chrome_cdp",
  "superagent_chrome_vision",
  "superagent_browser_gateway",
  "superagent_core_status", "superagent_core_plan", "superagent_core_restart",
  "superagent_core_rollback", "superagent_core_drain",
  "superagent_services_status", "superagent_manage_services",
] as const);
const eagerCoreNames = new Set<string>(MCP_GATEWAY_EAGER_CORE_TOOL_NAMES);

export function isCdpGatewayOnly(): boolean {
  return process.env.SUPERAGENT_CDP_GATEWAY_ONLY === "1" || process.env.SUPERAGENT_CDP_GATEWAY_ONLY === "true";
}

export function isGatewayInitiallyAdvertisedTool(name: string): boolean {
  if (isCdpGatewayOnly() && (name === "superagent_chrome_cdp" || name === "superagent_chrome_vision")) {
    return false;
  }
  return gatewayNames.has(name) || eagerProjectWorkspaceNames.has(name) || eagerDelegateNames.has(name) || eagerCoreNames.has(name);
}

export function getGatewayInitiallyAdvertisedTools<T extends GatewayToolDef>(allAuthorized: T[]): T[] {
  return allAuthorized.filter((tool) => isGatewayInitiallyAdvertisedTool(tool.name));
}

export function getGatewayVisibleCatalog<T extends GatewayToolDef>(allAuthorized: T[]): T[] {
  return allAuthorized.filter((tool) => !gatewayNames.has(tool.name));
}

export function searchGatewayTools<T extends GatewayToolDef>(
  allAuthorized: T[],
  args: Record<string, unknown>,
): Array<{ name: string; description: string }> {
  const catalog = getGatewayVisibleCatalog(allAuthorized);
  const intent = typeof args.intent === "string" ? args.intent.trim().slice(0, 400) : "";
  const query = typeof args.query === "string" ? args.query.trim().slice(0, 100).toLowerCase() : "";
  const requestedLimit = typeof args.limit === "number" && Number.isFinite(args.limit) ? args.limit : 8;
  const limit = Math.max(1, Math.min(20, Math.floor(requestedLimit)));
  const ranked = intent
    ? rankToolsForIntent(catalog.map((tool) => ({
      name: tool.name, description: tool.description || "",
    })), intent, limit).map((tool) => catalog.find((candidate) => candidate.name === tool.name)!)
    : query
      ? catalog.map((tool) => ({
          tool,
          score: Math.max(fuzzyScore(query, tool.name), tool.description?.toLowerCase().includes(query) ? 5 : 0),
        })).filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
        .map(({ tool }) => tool)
      : catalog;
  return ranked.slice(0, limit).map((tool) => {
    const actions = getToolActionCapabilities(tool.name);
    let desc = (tool.description || "").split("\n")[0].slice(0, 240);
    if (actions.length > 1) {
      const summary = actions.slice(0, 3).map((a) => `${a.action}:${a.readiness}`).join(", ");
      desc = `${desc} [actions: ${summary}]`;
    }
    return {
      name: tool.name,
      description: desc,
    };
  });
}

export function describeGatewayTool<T extends GatewayToolDef>(
  allAuthorized: T[],
  name: unknown,
): { name: string; description: string; inputSchema: Record<string, unknown>; actions?: any[] } | null {
  if (typeof name !== "string" || !name.trim()) return null;
  const found = getGatewayVisibleCatalog(allAuthorized).find((tool) => tool.name === name.trim());
  if (!found) return null;
  const actions = getToolActionCapabilities(found.name);
  return {
    name: found.name,
    description: found.description || "",
    inputSchema: found.inputSchema || { type: "object", properties: {} },
    actions: actions.length > 0 ? actions : undefined,
  };
}

export function validateGatewayExecuteTarget<T extends GatewayToolDef>(
  allAuthorized: T[],
  args: Record<string, unknown>,
): { name: string; arguments: Record<string, unknown> } | null {
  const target = describeGatewayTool(allAuthorized, args.name);
  if (!target) return null;
  if (args.arguments !== undefined && (typeof args.arguments !== "object" || args.arguments === null || Array.isArray(args.arguments))) return null;
  return { name: target.name, arguments: (args.arguments || {}) as Record<string, unknown> };
}

export function gatewayTextResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

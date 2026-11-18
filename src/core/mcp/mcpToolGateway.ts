import { fuzzyScore, rankToolsForIntent } from "../tools/toolDiscoveryTools.js";

export const MCP_GATEWAY_TOOL_NAMES = {
  search: "superagent_tool_search",
  describe: "superagent_tool_describe",
  execute: "superagent_tool_execute",
  status: "superagent_tool_status",
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
// Most operations stay dynamic via tool_search/tool_describe/tool_execute.
// A small set of common read-only calls is advertised eagerly; all mutations
// (including sync_history, which updates app-owned SQLite) remain discoverable
// on demand and always use the normal MCP authorization and host policy checks.
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

export const MCP_GATEWAY_EAGER_DELEGATE_TOOL_NAMES = Object.freeze([
  "superagent_delegate_read_chat",
  "superagent_delegate_list_chats",
  "superagent_delegate_read_chat_full",
  "superagent_delegate_search_history",
  "superagent_delegate_search_index",
  "superagent_delegate_doctor",
  "superagent_delegate_inspect_chat_config",
] as const);

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
    description: "Read the input schema and parameter requirements for one authorized SuperAgent MCP tool discovered via search (e.g. 'superagent_delegate_list_chats', 'superagent_delegate_send_message'). Call before executing an unadvertised tool.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "Exact target tool name from superagent_tool_search." } },
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
] as const;

export type GatewayToolDef = { name: string; description?: string; inputSchema?: Record<string, unknown> };
const gatewayNames = new Set<string>(Object.values(MCP_GATEWAY_TOOL_NAMES));
const eagerProjectWorkspaceNames = new Set<string>(MCP_GATEWAY_EAGER_PROJECT_WORKSPACE_TOOL_NAMES);
const eagerDelegateNames = new Set<string>(MCP_GATEWAY_EAGER_DELEGATE_TOOL_NAMES);
export const MCP_GATEWAY_EAGER_CORE_TOOL_NAMES = Object.freeze([
  // Eager, narrowly certified CDP metadata. Full browser automation remains dynamic.
  "superagent_chrome_cdp_observe",
  "superagent_core_status", "superagent_core_plan", "superagent_core_restart",
  "superagent_core_rollback", "superagent_core_drain",
  "superagent_services_status", "superagent_manage_services",
] as const);
const eagerCoreNames = new Set<string>(MCP_GATEWAY_EAGER_CORE_TOOL_NAMES);

export function isGatewayInitiallyAdvertisedTool(name: string): boolean {
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
  return ranked.slice(0, limit).map((tool) => ({
    name: tool.name,
    description: (tool.description || "").split("\n")[0].slice(0, 240),
  }));
}

export function describeGatewayTool<T extends GatewayToolDef>(
  allAuthorized: T[],
  name: unknown,
): { name: string; description: string; inputSchema: Record<string, unknown> } | null {
  if (typeof name !== "string" || !name.trim()) return null;
  const found = getGatewayVisibleCatalog(allAuthorized).find((tool) => tool.name === name.trim());
  if (!found) return null;
  return { name: found.name, description: found.description || "", inputSchema: found.inputSchema || { type: "object", properties: {} } };
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

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
 * their original OAuth/YOLO policy allows them.
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
  "superagent_grant_project_access",
  "superagent_revoke_project_access",
] as const);

export const MCP_GATEWAY_TOOL_DEFS = [
  {
    name: MCP_GATEWAY_TOOL_NAMES.search,
    description: "Find authorized SuperAgent MCP tools by task intent or keyword. Returns short capability summaries, not tool schemas.",
    inputSchema: {
      type: "object",
      properties: {
        intent: { type: "string", description: "Natural-language task description." },
        query: { type: "string", description: "Short keyword or tool name." },
        limit: { type: "number", minimum: 1, maximum: 20, description: "Maximum matching tools. Default 8." },
      },
    },
  },
  {
    name: MCP_GATEWAY_TOOL_NAMES.describe,
    description: "Read the input schema for one currently authorized SuperAgent MCP tool.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "Exact target tool name from search." } },
      required: ["name"],
    },
  },
  {
    name: MCP_GATEWAY_TOOL_NAMES.execute,
    description: "Invoke one authorized MCP tool using its exact name and arguments. Every call is rechecked against the original tool's permission, OAuth, and workspace policy. Safe/read-only targets work with read credentials; mutation targets still require write permission and an authorized tool allowance.",
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
    description: "Report current MCP gateway catalog size and authorization visibility without exposing hidden tools.",
    inputSchema: { type: "object", properties: {} },
  },
] as const;

export type GatewayToolDef = { name: string; description?: string; inputSchema?: Record<string, unknown> };
const gatewayNames = new Set<string>(Object.values(MCP_GATEWAY_TOOL_NAMES));
const eagerProjectWorkspaceNames = new Set<string>(MCP_GATEWAY_EAGER_PROJECT_WORKSPACE_TOOL_NAMES);

export function isGatewayInitiallyAdvertisedTool(name: string): boolean {
  return gatewayNames.has(name) || eagerProjectWorkspaceNames.has(name);
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

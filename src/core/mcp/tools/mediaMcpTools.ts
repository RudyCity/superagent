/** MCP bridge for canonical Agent media tools. Write actions are never safe-scoped. */
import type { McpToolResult } from "../types.js";
import { MEDIA_TOOLS } from "../../tools/mediaTools.js";
import { mediaError } from "../../media/mediaEngine.js";

const map = new Map(MEDIA_TOOLS.map(tool => ["superagent_" + tool.name, tool]));
export const MEDIA_MCP_MUTATING_NAMES = new Set(["superagent_media_transform", "superagent_media_convert", "superagent_media_batch"]);
export const MEDIA_MCP_TOOL_DEFS = MEDIA_TOOLS.map(tool => ({
  name: "superagent_" + tool.name, description: tool.description,
  inputSchema: {
    ...tool.parameters, properties: {
      ...tool.parameters.properties as Record<string, unknown>,
      projectId: { type: "string", description: "Optional authorized registered local project." },
      workspace: { type: "string", description: "Optional authorized local workspace." },
    },
  },
}));
export const MEDIA_MCP_TOOL_NAMES = new Set(MEDIA_MCP_TOOL_DEFS.map(item => item.name));
export const MEDIA_MCP_TOOL_CLASSIFICATIONS = Object.fromEntries(MEDIA_MCP_TOOL_DEFS.map(item => [
  item.name, MEDIA_MCP_MUTATING_NAMES.has(item.name) ? "dangerous" : "safe",
])) as Record<string, "dangerous" | "safe">;

export async function dispatchMediaMcpTool(name: string, args: Record<string, unknown>, workspace: string, opts: { allowWrite: boolean; signal?: AbortSignal }): Promise<McpToolResult> {
  const tool = map.get(name);
  if (!tool) return { content: [{ type: "text", text: JSON.stringify(mediaError(new Error("Unknown media tool"))) }], isError: true };
  if (MEDIA_MCP_MUTATING_NAMES.has(name) && !opts.allowWrite) {
    return { content: [{ type: "text", text: JSON.stringify({ status: "failed", code: "write_permission_required" }) }], isError: true };
  }
  try {
    const raw = await tool.execute(args, workspace, opts.signal);
    const decoded = JSON.parse(raw);
    return { content: [{ type: "text", text: raw }], ...(decoded.status === "failed" ? { isError: true } : {}) };
  } catch (error) {
    return { content: [{ type: "text", text: JSON.stringify(mediaError(error)) }], isError: true };
  }
}

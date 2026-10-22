import type { McpToolResult } from "../types.js";
import { createBrainSession, inspectBrainSession, listBrainSessions, listBrainFiles, readBrainFile, writeBrainFile, cleanBrainScratch } from "../../brain/brainWorkspace.js";

export const BRAIN_MCP_TOOL_DEFS = [{
  name: "superagent_brain",
  description: "Session-scoped Brain: isolated scratch, artifacts and evidence outside all repositories. No shell execution or project authorization is granted.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["create", "inspect", "list", "files", "read", "write", "cleanup"] },
      sessionId: { type: "string" },
      filePath: { type: "string", description: "Relative file path under scratch/, artifacts/, or evidence/." },
      content: { type: "string" },
      overwrite: { type: "boolean" },
      confirmSessionId: { type: "string" },
    },
    required: ["action"],
  },
}];
export const BRAIN_MCP_TOOL_CLASSIFICATIONS = { superagent_brain: "dangerous" as const };
export const BRAIN_READ_ACTIONS = new Set(["list", "inspect", "files", "read"]);

export function dispatchBrainMcpTool(name: string, args: Record<string, unknown>, principal: string): McpToolResult | null {
  if (name !== "superagent_brain") return null;
  try {
    const action = String(args.action || "");
    const id = String(args.sessionId || "");
    let result: unknown;
    switch (action) {
      case "create": result = createBrainSession(principal, id || undefined); break;
      case "list": result = listBrainSessions(principal); break;
      case "inspect": result = inspectBrainSession(principal, id); break;
      case "files": result = listBrainFiles(principal, id); break;
      case "read": result = { sessionId: id, filePath: args.filePath, content: readBrainFile(principal, id, String(args.filePath || "")) }; break;
      case "write": result = writeBrainFile(principal, id, String(args.filePath || ""), args.content as string, args.overwrite === true); break;
      case "cleanup": result = cleanBrainScratch(principal, id, String(args.confirmSessionId || "")); break;
      default: throw new Error("Unsupported brain action.");
    }
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (error: any) {
    return { content: [{ type: "text", text: error?.message || String(error) }], isError: true };
  }
}

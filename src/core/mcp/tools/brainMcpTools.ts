import type { McpToolResult } from "../types.js";
import {
  createBrainSession, inspectBrainSession, listBrainSessions, listBrainFiles,
  readBrainFile, writeBrainFile, cleanBrainScratch, getBrainScratchPath, publishBrainArtifact,
} from "../../brain/brainWorkspace.js";
import { cliBridgeTool } from "../../tools/cliBridgeTool.js";

export const BRAIN_MCP_TOOL_DEFS = [
  {
    name: "superagent_brain",
    description: "Manage session-scoped scratch, artifacts, and AGY/Claude delegation entirely within ~/.superagent-r/brain; never changes the current project root.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: [
          "create", "current", "inspect", "list", "files", "read", "write", "cleanup",
          "delegate.start", "delegate.get", "delegate.tail", "delegate.cancel", "delegate.jobs",
        ] },
        sessionId: { type: "string", description: "Optional Brain session ID. Without one, use the current MCP connection's persistent Brain. Not a CLI bridge job ID." },
        filePath: { type: "string", description: "Relative file path under scratch/, artifacts/ or evidence/." },
        content: { type: "string" },
        overwrite: { type: "boolean" },
        confirmSessionId: { type: "string" },
        cli: { type: "string", enum: ["agy", "claude", "codex"] },
        prompt: { type: "string", maxLength: 15000 },
        jobId: { type: "string" },
        expectedArtifacts: { type: "array", maxItems: 12, items: { type: "string" } },
        timeoutMs: { type: "number", minimum: 1000, maximum: 7200000 },
      },
      required: ["action"],
    },
  },
  {
    name: "superagent_brain_publish",
    description: "Publish a verified Brain artifacts/ file into an explicitly authorized registered LOCAL project. Never overwrites files. Requires project write capability and standard MCP workspace authorization.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        sessionId: { type: "string" },
        filePath: { type: "string", description: "Source relative path inside artifacts/." },
        destinationPath: { type: "string", description: "New relative destination inside the selected project (no overwrite)." },
      },
      required: ["projectId", "sessionId", "filePath", "destinationPath"],
    },
  },
];
export const BRAIN_MCP_TOOL_CLASSIFICATIONS: Record<string, "dangerous"> = {
  superagent_brain: "dangerous",
  superagent_brain_publish: "dangerous",
};

const delegateActions: Record<string, string> = {
  "delegate.start": "delegate.start",
  "delegate.get": "delegate.get",
  "delegate.tail": "delegate.tail",
  "delegate.cancel": "delegate.cancel",
  "delegate.jobs": "delegate.jobs",
};

function result(value: unknown, isError = false): McpToolResult {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }], ...(isError ? { isError: true } : {}) };
}

export async function dispatchBrainMcpTool(
  name: string, args: Record<string, unknown>, principal: string, connectionSessionId?: string,
): Promise<McpToolResult | null> {
  if (name !== "superagent_brain") return null;
  try {
    const action = String(args.action || "");
    const id = String(args.sessionId || connectionSessionId || "");
    // One durable Brain per MCP server/transport session by default, without
    // guessing a ChatGPT conversation ID. Explicit session IDs remain supported.
    if (!args.sessionId && connectionSessionId && action !== "list") {
      createBrainSession(principal, connectionSessionId);
    }
    if (action in delegateActions) {
      if (!id) throw new Error("brain sessionId required for delegation.");
      const scratch = getBrainScratchPath(principal, id);
      if (action === "delegate.start") {
        const cli = args.cli;
        const prompt = args.prompt;
        if (!["agy", "claude", "codex"].includes(String(cli))) throw new Error("CLI must be agy, claude, or codex.");
        if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 15000) throw new Error("Delegate prompt required (max 15000 characters).");
        const safeArgs: Record<string, unknown> = {
          action: "delegate.start", cli, prompt,
          skillAutoDetect: false, injectArtifacts: false, permissionMode: "accept-edits",
        };
        if (Array.isArray(args.expectedArtifacts)) safeArgs.expectedArtifacts = args.expectedArtifacts;
        if (args.timeoutMs !== undefined) safeArgs.timeoutMs = args.timeoutMs;
        return result(await cliBridgeTool.execute(safeArgs, scratch));
      }
      if (action !== "delegate.jobs" && (!args.jobId || typeof args.jobId !== "string")) throw new Error("jobId required.");
      return result(await cliBridgeTool.execute({ action: delegateActions[action], ...(action !== "delegate.jobs" ? { jobId: args.jobId } : {}) }, scratch));
    }
    switch (action) {
      case "create":
      case "current": return result(createBrainSession(principal, id || undefined));
      case "list": return result(listBrainSessions(principal));
      case "inspect": return result(inspectBrainSession(principal, id));
      case "files": return result(listBrainFiles(principal, id));
      case "read": return result({ sessionId: id, filePath: args.filePath, content: readBrainFile(principal, id, String(args.filePath || "")) });
      case "write": return result(writeBrainFile(principal, id, String(args.filePath || ""), args.content as string, args.overwrite === true));
      case "cleanup": return result(cleanBrainScratch(principal, id, String(args.confirmSessionId || "")));
      default: throw new Error("Unsupported brain action.");
    }
  } catch (error: any) {
    return result(error?.message || String(error), true);
  }
}

export function dispatchBrainPublishMcpTool(
  name: string, args: Record<string, unknown>, principal: string, projectRoot?: string,
): McpToolResult | null {
  if (name !== "superagent_brain_publish") return null;
  try {
    if (!projectRoot) throw new Error("An authorized registered local project is required.");
    return result(publishBrainArtifact(
      principal, String(args.sessionId || ""), String(args.filePath || ""),
      projectRoot, String(args.destinationPath || ""),
    ));
  } catch (error: any) {
    return result(error?.message || String(error), true);
  }
}

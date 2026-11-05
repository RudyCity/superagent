import type { McpToolResult } from "../types.js";
import path from "node:path";
import { loadRemoteAgentConfig } from "../../remoteAgent/config.js";
import { MuseClient } from "../../remoteAgent/museClient.js";
import { resolveTransferSource } from "../../remoteAgent/museFileTransfer.js";
import { getMuseWatcherStrict } from "../../remoteAgent/museWatcherRegistry.js";
import { getMuseChatReadiness } from "./remoteAgentChatMcpTools.js";
import { asResult, errorResult, resolveMusePort, safeErrorMessage } from "./remoteAgentMcpShared.js";

async function validatedSource(args: Record<string, unknown>, workspaceRoot?: string): Promise<string> {
  if (typeof args.filePath !== "string" || !args.filePath.trim()) {
    throw new Error("'filePath' is required");
  }
  // Workspace must come from MCP's authorized routing, never from caller-controlled arguments.
  if (!workspaceRoot || !path.isAbsolute(workspaceRoot) || /^(?:ssh|chain):/i.test(workspaceRoot)) {
    throw new Error("An authorized local MCP workspace is required to send files");
  }
  return resolveTransferSource(args.filePath, workspaceRoot);
}

export async function handleTelegramSendFile(args: Record<string, unknown> = {}, workspaceRoot?: string): Promise<McpToolResult> {
  const config = loadRemoteAgentConfig();
  if (!config.botToken || !config.groupId) {
    return errorResult("Telegram botToken and groupId must be configured");
  }
  try {
    const source = await validatedSource(args, workspaceRoot);
    const caption = args.caption;
    if (caption !== undefined && typeof caption !== "string") {
      return errorResult("'caption' must be a string");
    }
    const receipt = await new MuseClient(config).sendDocument(config.groupId, source, caption as string | undefined);
    return asResult({
      ...receipt, transport: "telegram", state: "accepted_by_telegram",
      note: "File attached to Telegram group; this does not confirm Muse downloaded it.",
    });
  } catch (error) {
    return errorResult(safeErrorMessage(error, config));
  }
}

export async function handleMuseSendFile(args: Record<string, unknown> = {}, workspaceRoot?: string): Promise<McpToolResult> {
  const config = loadRemoteAgentConfig();
  try {
    const source = await validatedSource(args, workspaceRoot);
    const readiness = getMuseChatReadiness(args.port);
    if (!readiness.ok) return errorResult(readiness.reason || "Muse WebSocket is not ready");
    const watcher = getMuseWatcherStrict(readiness.port);
    if (!watcher) return errorResult("No registered Muse watcher on requested port");
    const receipt = await watcher.sendFile(source, workspaceRoot!);
    return asResult({
      ok: true, transport: "muse-websocket", state: "file_acknowledged_by_muse",
      ...receipt,
      note: "Muse acknowledged complete payload and SHA-256; receiver must persist it securely.",
    });
  } catch (error) {
    return errorResult(safeErrorMessage(error, config));
  }
}

export async function handleMuseFileStatus(args: Record<string, unknown> = {}): Promise<McpToolResult> {
  const config = loadRemoteAgentConfig();
  try {
    const port = resolveMusePort(args.port, config);
    const watcher = getMuseWatcherStrict(port);
    return asResult({
      port, watcherActive: Boolean(watcher),
      ...(watcher ? watcher.getFileTransferStatus() : { state: "unavailable" }),
    });
  } catch (error) {
    return errorResult(safeErrorMessage(error, config));
  }
}

export async function handleMuseFileCancel(args: Record<string, unknown> = {}): Promise<McpToolResult> {
  const config = loadRemoteAgentConfig();
  try {
    const port = resolveMusePort(args.port, config);
    const watcher = getMuseWatcherStrict(port);
    if (!watcher) return errorResult("Muse watcher is not active on requested port");
    return asResult({ port, cancelled: watcher.cancelFileTransfer(), ...watcher.getFileTransferStatus() });
  } catch (error) {
    return errorResult(safeErrorMessage(error, config));
  }
}

export const REMOTE_AGENT_FILE_MCP_TOOL_CLASSIFICATIONS: Record<string, "safe" | "dangerous"> = {
  superagent_telegram_send_file: "dangerous",
  superagent_muse_send_file: "dangerous",
  superagent_muse_file_status: "safe",
  superagent_muse_file_cancel: "dangerous",
};

export const REMOTE_AGENT_FILE_MCP_TOOL_DEFS = [
  {
    name: "superagent_muse_file_status",
    description: "Read active Muse file-transfer state, percent progress, bytes and resume status without exposing file contents.",
    inputSchema: { type: "object", properties: {
      port: { type: "number", description: "Muse WebSocket watcher port" },
    } },
  },
  {
    name: "superagent_muse_file_cancel",
    description: "Explicitly cancel the active Muse file transfer, retaining checkpoint for authorized resume.",
    inputSchema: { type: "object", properties: {
      port: { type: "number", description: "Muse WebSocket watcher port" },
    } },
  },
  {
    name: "superagent_telegram_send_file",
    description: "Send a real document attachment to the configured Telegram group, not as text. Only a regular file inside the MCP host's active workspace; maximum 8 MiB. Telegram acceptance is not Muse receipt.",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Local path to a regular source file in the active workspace" },
        caption: { type: "string", description: "Optional Telegram caption (maximum 1024 characters)" },
        projectId: { type: "string", description: "Optional registered local project ID, requires write capability" },
      },
      required: ["filePath"],
    },
  },
  {
    name: "superagent_muse_send_file",
    description: "Stream a local workspace file to the connected Muse over an authenticated WebSocket using SHA-256 verified chunk ACKs. Requires a Muse receiver implementing the file protocol. Maximum 8 MiB.",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Local file inside the MCP host's active workspace" },
        port: { type: "number", description: "Optional connected Muse WebSocket port (default configured port or 9225)" },
        projectId: { type: "string", description: "Optional registered local project ID, requires write capability" },
      },
      required: ["filePath"],
    },
  },
];

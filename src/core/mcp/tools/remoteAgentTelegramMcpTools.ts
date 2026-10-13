import { randomUUID } from "node:crypto";
import type { McpToolResult } from "../types.js";
import { loadRemoteAgentConfig } from "../../remoteAgent/config.js";
import { MuseClient } from "../../remoteAgent/museClient.js";
import type { ChatEnvelope } from "../../remoteAgent/protocol.js";
import { asResult, errorResult, MAX_TELEGRAM_TEXT_LENGTH, safeErrorMessage } from "./remoteAgentMcpShared.js";

export async function handleTelegramSendToMuse(args: Record<string, unknown> = {}): Promise<McpToolResult> {
  const config = loadRemoteAgentConfig();
  const rawText = args.text ?? args.message;
  if (typeof rawText !== "string" || !rawText.trim()) {
    return errorResult("'text' is required and must contain a non-empty message.");
  }

  const text = rawText.trim();
  if (text.length > MAX_TELEGRAM_TEXT_LENGTH) {
    return errorResult(`Message exceeds the ${MAX_TELEGRAM_TEXT_LENGTH}-character limit.`);
  }

  if (!config.botToken || !config.groupId || !config.museBotId) {
    return errorResult(
      "Muse Telegram is not configured. Configure botToken, groupId, and museBotId with the existing Muse configuration before sending a message."
    );
  }

  try {
    const client = new MuseClient(config);
    const envelope: ChatEnvelope = {
      v: 1,
      kind: "chat",
      id: `mcp-chat-${randomUUID()}`,
      text,
    };
    const accepted = await client.sendEnvelope(envelope, config.groupId);
    if (!accepted) {
      return errorResult("Telegram did not confirm delivery of the Muse chat envelope. Check the bot token, group permissions, and Telegram API status.");
    }

    return asResult({
      ok: true,
      transport: "telegram",
      state: "accepted_by_telegram",
      groupId: config.groupId,
      museBotId: config.museBotId,
      messageLength: text.length,
      note: "Telegram accepted the message envelope. This does not confirm that Muse processed it.",
    });
  } catch (error) {
    return errorResult(safeErrorMessage(error, config));
  }
}

export const REMOTE_AGENT_TELEGRAM_MCP_TOOL_CLASSIFICATIONS: Record<string, "safe" | "dangerous"> = {
  superagent_telegram_send_to_muse: "dangerous",
};

export const REMOTE_AGENT_TELEGRAM_MCP_TOOL_DEFS = [
  {
    name: "superagent_telegram_send_to_muse",
    description: "Send an explicit chat message to Muse through the Telegram bot/group configured in Muse settings. Requires botToken, groupId, and museBotId; reports Telegram acceptance without claiming Muse processed it.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Message to send to Muse. Maximum 12000 characters." },
      },
      required: ["text"],
    },
  },
];

import type { McpToolResult } from "../types.js";
import type { RemoteAgentConfig } from "../../remoteAgent/config.js";

export const DEFAULT_MUSE_WS_PORT = 9225;
export const MAX_TELEGRAM_TEXT_LENGTH = 12_000;
export const DEFAULT_MUSE_CHAT_TIMEOUT_MS = 30_000;
export const MAX_MUSE_CHAT_TIMEOUT_MS = 120_000;

export function asResult(value: unknown, isError = false): McpToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

export function errorResult(message: string): McpToolResult {
  return asResult({ ok: false, error: message }, true);
}

export function resolveMusePort(raw: unknown, config: RemoteAgentConfig): number {
  const configured = config.wsPort || DEFAULT_MUSE_WS_PORT;
  if (raw === undefined || raw === null) {
    if (!Number.isInteger(configured) || configured < 1024 || configured > 65535) {
      throw new Error("The configured Muse WebSocket port is invalid. Set wsPort to an integer between 1024 and 65535.");
    }
    return configured;
  }
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1024 || raw > 65535) {
    throw new Error("'port' must be an integer between 1024 and 65535.");
  }
  return raw;
}

export function safeErrorMessage(error: unknown, config: RemoteAgentConfig): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of [config.botToken, config.wsToken, config.cfAccessClientSecret]) {
    if (secret && secret.length >= 4) message = message.split(secret).join("[REDACTED]");
  }
  message = message.replace(/bot\d+:[A-Za-z0-9_-]{20,}/g, "[REDACTED_TELEGRAM_TOKEN]");
  return message.slice(0, 1200);
}

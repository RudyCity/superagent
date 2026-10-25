/**
 * Standalone Muse channel-host alert config commands. Never print the
 * Telegram token (including partial masking), URLs with query secrets, or
 * encrypted ciphertext. Telegram token accepted only through piped stdin.
 */
import { describeMuseAlertConfig, storeMuseAlertConfig } from "../remoteAgent/museAlertConfig.js";

export function museAlertConfigHelp(): string {
  return [
    "superagent channel-host config status --port 7892",
    "superagent channel-host config set-webhook https://alerts.example.com/receiver --port 7892",
    "superagent channel-host config set-telegram --chat-id -123456789 --token-stdin --port 7892",
    "superagent channel-host config disable --port 7892",
    "Telegram secret: pipe only the bot token to --token-stdin. Do NOT put it in arguments or interactive chat history.",
    "Changes take effect for the next alert delivery without restarting channel-host/watchdog.",
    "Provider configuration is stored encrypted in a private per-port file, with a separate owner-only local key.",
  ].join("\n");
}

export async function handleMuseAlertConfigCommand(args: string[],
  options: { root?: string; readStdin?: () => Promise<string> } = {}): Promise<string> {
  const action = args[0]?.toLowerCase() || "help";
  if (action === "help" || action === "--help") return museAlertConfigHelp();
  const p = args.indexOf("--port");
  const port = p < 0 ? 7892 : Number(args[p + 1]);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("Invalid --port");
  const root = options.root;
  if (action === "status") {
    const status = describeMuseAlertConfig(port, root);
    return "Muse alert configuration: " + JSON.stringify(status) +
      "\nNo token, destination URL, or chat ID is shown.";
  }
  if (action === "disable") {
    storeMuseAlertConfig(port, { mode: "disabled" }, root);
    return "Muse alert delivery disabled for port " + port + " (no restart required).";
  }
  if (action === "set-webhook" || action === "webhook") {
    if (typeof args[1] !== "string" || args[1].startsWith("--")) {
      throw new Error("Expected config set-webhook HTTPS_URL --port PORT");
    }
    storeMuseAlertConfig(port, { mode: "webhook", url: args[1] }, root);
    return "Muse alert provider set to webhook on port " + port +
      ". Destination hidden; no restart required.";
  }
  if (action === "set-telegram" || action === "telegram") {
    const chatAt = args.indexOf("--chat-id");
    if (chatAt < 0 || !args[chatAt + 1] || !args.includes("--token-stdin")) {
      throw new Error("Use config set-telegram --chat-id ID --token-stdin --port PORT");
    }
    const read = options.readStdin || (async () => {
      if (process.stdin.isTTY) {
        throw new Error("Piped stdin required; do not enter a token in terminal command history");
      }
      let chunks = "";
      for await (const chunk of process.stdin) {
        chunks += String(chunk);
        if (chunks.length > 512) throw new Error("Telegram token input too long");
      }
      return chunks;
    });
    const token = (await read()).trim();
    storeMuseAlertConfig(port, { mode: "telegram", token, chatId: args[chatAt + 1] }, root);
    return "Muse alert provider set to Telegram on port " + port +
      ". Token and destination hidden; no restart required.";
  }
  throw new Error("Expected channel-host config status, set-webhook, set-telegram or disable");
}

import { registry } from "./registry.js";
import type { SlashCommand, SlashCommandContext } from "./types.js";
import {
  loadRemoteAgentConfig,
  updateRemoteAgentConfig,
  maskToken,
  getWatchedWorkspaces,
} from "../remoteAgent/config.js";

const TELEGRAM_CONFIG_KEYS = new Map<string, "botToken" | "groupId" | "museBotId">([
  ["bottoken", "botToken"],
  ["bot_token", "botToken"],
  ["token", "botToken"],
  ["groupid", "groupId"],
  ["group_id", "groupId"],
  ["chatid", "groupId"],
  ["chat_id", "groupId"],
  ["musebotid", "museBotId"],
  ["muse_bot_id", "museBotId"],
]);

function emit(ctx: SlashCommandContext, type: "system" | "error", content: string, timestamp = Date.now()): void {
  ctx.addLine({ type, content, timestamp });
}

export async function handleTelegramCommand(args: string, ctx: SlashCommandContext): Promise<void> {
  const now = Date.now();
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const action = (parts[0] || "help").toLowerCase();

  if (action === "help" || action === "-h" || action === "--help") {
    emit(ctx, "system", [
      "Telegram integration — direct bot/group operations only",
      "",
      "  /telegram status                  Show Telegram configuration and API status",
      "  /telegram doctor                  Diagnose Telegram token, group, and bot access",
      "  /telegram send <message>          Send only to the configured Telegram group",
      "  /telegram config                 View Telegram settings (secrets masked)",
      "  /telegram config <key> <value>    Set botToken, groupId, or museBotId",
      "  /telegram fallback status|start|stop",
      "",
      "This command does not steer an active Muse task or manage tunnel providers.",
      "Tunnel ownership: /muse tunnel for Muse, /mcp tunnel for MCP, /server tunnel for REST/SSE.",
    ].join("\n"), now);
    return;
  }

  if (action === "config") {
    const keyArg = parts[1]?.toLowerCase();
    const mappedKey = keyArg ? TELEGRAM_CONFIG_KEYS.get(keyArg) : undefined;
    const value = parts.slice(2).join(" ").trim();

    if (!keyArg) {
      const cfg = loadRemoteAgentConfig();
      emit(ctx, "system", [
        "Telegram configuration:",
        `- botToken  : ${maskToken(cfg.botToken)}`,
        `- groupId   : ${cfg.groupId || "(not set)"}`,
        `- museBotId : ${cfg.museBotId || "(not set)"}`,
        "",
        "Keys: botToken, groupId, museBotId",
        "Example: /telegram config botToken <token>",
      ].join("\n"), now);
      return;
    }

    if (!mappedKey) {
      emit(ctx, "error", `Unknown Telegram config key "${parts[1]}". Supported: botToken, groupId, museBotId.`, now);
      return;
    }
    if (!value) {
      emit(ctx, "error", `Usage: /telegram config ${mappedKey} <value>`, now);
      return;
    }

    updateRemoteAgentConfig({ [mappedKey]: value } as any);
    const display = mappedKey === "botToken" ? maskToken(value) : value;
    emit(ctx, "system", `Telegram configuration updated: ${mappedKey} = ${display}`, now);
    return;
  }

  if (action === "status" || action === "doctor" || action === "test") {
    const cfg = loadRemoteAgentConfig();
    const checks: string[] = [
      "Telegram Integration Status",
      `- Bot token : ${cfg.botToken ? `configured (${maskToken(cfg.botToken)})` : "MISSING"}`,
      `- Group ID  : ${cfg.groupId || "MISSING"}`,
      `- Muse bot  : ${cfg.museBotId || "MISSING"}`,
    ];
    let failed = !cfg.botToken || !cfg.groupId || !cfg.museBotId;

    if (cfg.botToken) {
      try {
        const { MuseClient } = await import("../remoteAgent/museClient.js");
        const client = new MuseClient(cfg);
        const me = await client.getMeInfo();
        if (me.ok) {
          checks.push(`- Bot API   : ONLINE (@${me.username || me.firstName})`);
          if (me.canReadGroupMessages === false) {
            checks.push("- Group privacy: WARNING — bot cannot read non-reply group messages; disable privacy in BotFather if required.");
          } else {
            checks.push("- Group privacy: OK");
          }
        } else {
          checks.push(`- Bot API   : FAILED (${me.error || "invalid bot token"})`);
          failed = true;
        }
      } catch (err: any) {
        checks.push(`- Bot API   : ERROR (${err?.message || String(err)})`);
        failed = true;
      }
    } else {
      checks.push("- Bot API   : NOT CHECKED (configure botToken first)");
    }

    if (action === "doctor") {
      const { isMuseWatcherActive, TELEGRAM_FALLBACK_KEY } = await import("../remoteAgent/museWatcher.js");
      checks.push(`- Fallback watcher: ${isMuseWatcherActive(TELEGRAM_FALLBACK_KEY) ? "ACTIVE" : "INACTIVE"}`);
    }

    checks.push("", failed ? "Result: Telegram setup needs attention." : "Result: required Telegram settings are present; review the API checks above.");
    emit(ctx, failed ? "error" : "system", checks.join("\n"), now);
    return;
  }

  if (action === "send" || action === "msg") {
    const message = parts.slice(1).join(" ").trim();
    if (!message) {
      emit(ctx, "error", "Usage: /telegram send <message>", now);
      return;
    }

    const cfg = loadRemoteAgentConfig();
    if (!cfg.botToken || !cfg.groupId) {
      emit(ctx, "error", "Telegram is not configured. Run /telegram config botToken <token> and /telegram config groupId <chat-id>.", now);
      return;
    }

    try {
      const { MuseClient } = await import("../remoteAgent/museClient.js");
      const client = new MuseClient(cfg);
      const sent = await client.sendMessage(cfg.groupId, message);
      if (!sent) {
        emit(ctx, "error", `Telegram could not deliver the message to group ${cfg.groupId}. Check the bot's group permissions.`, now);
        return;
      }
      emit(ctx, "system", `[Telegram] Sent message to configured group ${cfg.groupId}. This action does not steer Muse.`, now);
    } catch (err: any) {
      emit(ctx, "error", `Telegram send failed: ${err?.message || String(err)}`, now);
    }
    return;
  }

  if (action === "fallback") {
    const fallbackAction = (parts[1] || "status").toLowerCase();
    const { isMuseWatcherActive, TELEGRAM_FALLBACK_KEY, startMuseWatcher, stopMuseWatcher } =
      await import("../remoteAgent/museWatcher.js");
    const active = isMuseWatcherActive(TELEGRAM_FALLBACK_KEY);

    if (fallbackAction === "status") {
      emit(ctx, "system", `Telegram fallback watcher: ${active ? "ACTIVE" : "INACTIVE"}`, now);
      return;
    }
    if (fallbackAction === "stop") {
      if (!active) {
        emit(ctx, "system", "Telegram fallback watcher is not running.", now);
        return;
      }
      await stopMuseWatcher(TELEGRAM_FALLBACK_KEY);
      emit(ctx, "system", "Telegram fallback watcher stopped. Muse's primary watcher/tunnel was not changed.", now);
      return;
    }
    if (fallbackAction === "start") {
      if (active) {
        emit(ctx, "system", "Telegram fallback watcher is already active.", now);
        return;
      }
      const cfg = loadRemoteAgentConfig();
      if (!cfg.botToken || !cfg.groupId) {
        emit(ctx, "error", "Configure Telegram first with /telegram config botToken and /telegram config groupId.", now);
        return;
      }
      const workspaces = getWatchedWorkspaces(cfg, ctx.agent?.workingDirectory);
      try {
        await startMuseWatcher({
          workspace: workspaces[0] || ctx.agent?.workingDirectory || process.cwd(),
          workspaces,
          transportType: "telegram",
          fallback: true,
          tunnel: false,
          isHttps: false,
          wsPort: undefined,
          agent: ctx.agent,
          onProgress: (msg: string) => emit(ctx, "system", `[Telegram fallback] ${msg}`),
          onLine: (line: { type: string; content: string; timestamp?: number }) =>
            emit(ctx, (line.type as any) || "system", line.content, line.timestamp || Date.now()),
        });
        emit(ctx, "system", "Telegram fallback watcher started independently. Muse primary tunnel was not changed.", now);
      } catch (err: any) {
        emit(ctx, "error", `Failed to start Telegram fallback watcher: ${err?.message || String(err)}`, now);
      }
      return;
    }
    emit(ctx, "error", `Unknown Telegram fallback action "${fallbackAction}". Use status, start, or stop.`, now);
    return;
  }

  emit(ctx, "error", `Unknown Telegram action "${action}". Use /telegram help.`, now);
}

export const telegramCommand: SlashCommand = {
  name: "telegram",
  aliases: ["tg"],
  description: "Manage direct Telegram bot/group integration without steering Muse or managing tunnels",
  execute: handleTelegramCommand,
};

registry.register(telegramCommand);

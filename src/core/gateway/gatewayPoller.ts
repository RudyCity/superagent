import { gatewayManager } from "./gatewayManager.js";
import { startTelegramPolling } from "./telegramPoller.js";
import { startDiscordGateway } from "./discordPoller.js";
import { startSlackSocketMode } from "./slackPoller.js";

export interface GatewayPollerOptions {
  channels?: string[] | string;
  workspace?: string;
  signal?: AbortSignal;
  silent?: boolean;
}

export async function startGatewayPolling(options: GatewayPollerOptions = {}): Promise<void> {
  const cfg = gatewayManager.getConfig();
  const workspace = options.workspace || cfg.defaultWorkspace || process.cwd();

  let requested: string[] = [];
  if (Array.isArray(options.channels)) {
    requested = options.channels.map((c) => c.toLowerCase().trim()).filter(Boolean);
  } else if (typeof options.channels === "string" && options.channels.trim()) {
    requested = options.channels
      .split(/[,\s]+/)
      .map((c) => c.toLowerCase().trim())
      .filter(Boolean);
  }

  const isAll = requested.length === 0 || requested.includes("all");

  const hasTelegram = !!(cfg.channels.telegram?.botToken);
  const hasDiscord = !!(cfg.channels.discord?.botToken);
  const hasSlack = !!(cfg.channels.slack?.botToken && cfg.channels.slack?.appToken);

  const shouldPollTelegram = isAll ? hasTelegram : requested.includes("telegram");
  const shouldPollDiscord = isAll ? hasDiscord : requested.includes("discord");
  const shouldPollSlack = isAll ? hasSlack : requested.includes("slack");

  if (!shouldPollTelegram && !shouldPollDiscord && !shouldPollSlack) {
    if (isAll) {
      throw new Error(
        "No gateway polling channels configured with credentials. Configure Telegram, Discord, or Slack Socket Mode (botToken & appToken)."
      );
    } else {
      throw new Error(
        `Requested polling channel(s) [${requested.join(", ")}] not recognized or missing required credentials.`
      );
    }
  }

  const activeChannels: string[] = [];
  if (shouldPollTelegram) activeChannels.push("Telegram");
  if (shouldPollDiscord) activeChannels.push("Discord");
  if (shouldPollSlack) activeChannels.push("Slack");

  if (!options.silent) {
    console.log("Starting Unified Superagent Gateway Poller...");
    console.log(`- Workspace: ${workspace}`);
    console.log(`- Active polling channels: ${activeChannels.join(", ")}`);
    console.log("- Mode: Headless daemon polling (no incoming HTTP port needed)");
    console.log("- Press Ctrl+C to terminate polling\n");
  }

  const pollers: Promise<void>[] = [];

  if (shouldPollTelegram) {
    pollers.push(
      startTelegramPolling({
        workspace,
        signal: options.signal,
        silent: options.silent,
      })
    );
  }

  if (shouldPollDiscord) {
    pollers.push(
      startDiscordGateway({
        workspace,
        signal: options.signal,
        silent: options.silent,
      })
    );
  }

  if (shouldPollSlack) {
    pollers.push(
      startSlackSocketMode({
        workspace,
        signal: options.signal,
        silent: options.silent,
      })
    );
  }

  await Promise.all(pollers);
}

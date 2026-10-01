import { registry } from "./registry.js";
import type { SlashCommand, SlashCommandContext } from "./types.js";
import {
  loadRemoteAgentConfig,
  updateRemoteAgentConfig,
  maskToken,
  RemoteAgentConfig,
} from "../remoteAgent/config.js";

export const museCommand: SlashCommand = {
  name: "muse",
  description: "Coordinate with remote AI agent (Muse) over Telegram bot bus",
  async execute(args, ctx) {
    const rawTrimmed = args.trim();
    const parts = rawTrimmed.split(/\s+/).filter(Boolean);
    const subcommand = (parts[0] || "").toLowerCase();
    const now = Date.now();

    // /muse status
    if (subcommand === "status") {
      const cfg = loadRemoteAgentConfig();
      const workspace = cfg.defaultWorkspace || ctx.agent?.workingDirectory || process.cwd();
      const isConfigured = Boolean(cfg.botToken && cfg.groupId && cfg.museBotId);

      const lines = [
        "Remote Agent (Muse) Status:",
        `- Configured      : ${isConfigured ? "Yes" : "No (run /muse config)"}`,
        `- Bot Token       : ${maskToken(cfg.botToken)}`,
        `- Telegram Group  : ${cfg.groupId || "(not set)"}`,
        `- Muse Bot ID     : ${cfg.museBotId || "(not set)"}`,
        `- Workspace       : ${workspace}`,
        "",
        "Architecture:",
        "- Muse acts as the remote brain over a private Telegram group bus.",
        "- Superagent acts as the local hands, executing batches of file/read/edit tools.",
        "",
        "Usage:",
        "  /muse <task>                 - Run a task with remote Muse brain",
        "  /muse status                 - View remote agent status",
        "  /muse config <key> <val>     - Set config key (botToken, groupId, museBotId, defaultWorkspace)",
      ];

      ctx.addLine({ type: "system", content: lines.join("\n"), timestamp: now });
      return;
    }

    // /muse config [key] [val]
    if (subcommand === "config") {
      const key = parts[1]?.toLowerCase();
      const val = parts.slice(2).join(" ").trim();

      if (!key) {
        const cfg = loadRemoteAgentConfig();
        const lines = [
          "Remote Agent Configuration:",
          `- botToken         : ${maskToken(cfg.botToken)}`,
          `- groupId          : ${cfg.groupId || "(not set)"}`,
          `- museBotId        : ${cfg.museBotId || "(not set)"}`,
          `- defaultWorkspace : ${cfg.defaultWorkspace || "(default to current workspace)"}`,
          "",
          "Usage: /muse config <key> <value>",
          "Keys:",
          "  botToken         - Bot B (superagent's Telegram bot token)",
          "  groupId          - Numeric private group chat ID (e.g. -100xxxxxxxxxx)",
          "  museBotId        - Numeric Telegram user ID of Muse bot (Bot A)",
          "  defaultWorkspace - Default project workspace path",
          "",
          "Example:",
          "  /muse config botToken 123456789:ABCdef...",
          "  /muse config groupId -1001234567890",
          "  /muse config museBotId 987654321",
        ];
        ctx.addLine({ type: "system", content: lines.join("\n"), timestamp: now });
        return;
      }

      const validKeys: Record<string, keyof RemoteAgentConfig> = {
        bottoken: "botToken",
        bot_token: "botToken",
        groupid: "groupId",
        group_id: "groupId",
        musebotid: "museBotId",
        muse_bot_id: "museBotId",
        defaultworkspace: "defaultWorkspace",
        default_workspace: "defaultWorkspace",
        workspace: "defaultWorkspace",
      };

      const mappedKey = validKeys[key];
      if (!mappedKey) {
        ctx.addLine({
          type: "error",
          content: `Unknown config key: "${key}". Valid keys: botToken, groupId, museBotId, defaultWorkspace`,
          timestamp: now,
        });
        return;
      }

      if (!val) {
        ctx.addLine({
          type: "error",
          content: `Usage: /muse config ${key} <value>`,
          timestamp: now,
        });
        return;
      }

      const patch: Partial<RemoteAgentConfig> = {};
      if (mappedKey === "botToken") {
        patch.botToken = val;
      } else if (mappedKey === "groupId") {
        patch.groupId = val;
      } else if (mappedKey === "museBotId") {
        patch.museBotId = val;
      } else if (mappedKey === "defaultWorkspace") {
        patch.defaultWorkspace = val;
      }

      updateRemoteAgentConfig(patch);
      const maskedConfirmation =
        mappedKey === "botToken" ? maskToken(val) : val;

      ctx.addLine({
        type: "system",
        content: `Remote agent configuration updated: ${mappedKey} = ${maskedConfirmation}`,
        timestamp: now,
      });
      return;
    }

    // Default: /muse <task>
    if (!rawTrimmed) {
      ctx.addLine({
        type: "system",
        content: [
          "Usage: /muse <task description>",
          "Example: /muse cari semua TODO di src",
          "Subcommands:",
          "  /muse status",
          "  /muse config <key> <value>",
        ].join("\n"),
        timestamp: now,
      });
      return;
    }

    const { runRemoteTask } = await import("../remoteAgent/taskRunner.js");
    const workspace = ctx.agent?.workingDirectory || process.cwd();

    ctx.addLine({
      type: "system",
      content: `[Muse] Initiating remote task in workspace: ${workspace}\nTask: "${rawTrimmed}"`,
      timestamp: now,
    });

    try {
      const result = await runRemoteTask({
        task: rawTrimmed,
        workspace,
        agent: ctx.agent,
        onProgress: (msg) => {
          ctx.addLine({
            type: "system",
            content: `[Muse] ${msg}`,
            timestamp: Date.now(),
          });
        },
        onChat: (msg) => {
          ctx.addLine({
            type: "assistant",
            content: `[Muse Note]: ${msg}`,
            timestamp: Date.now(),
          });
        },
      });

      if (result.success) {
        ctx.addLine({
          type: "assistant",
          content: result.summary,
          timestamp: Date.now(),
        });
      } else {
        ctx.addLine({
          type: "error",
          content: `Remote task failed: ${result.error || "Unknown error"}`,
          timestamp: Date.now(),
        });
      }
    } catch (err: any) {
      ctx.addLine({
        type: "error",
        content: `Failed to execute remote task: ${err.message}`,
        timestamp: Date.now(),
      });
    }
  },
};

registry.register(museCommand);

import { registry } from "./registry.js";
import { SlashCommand } from "./types.js";

// /gateway command
export const gatewayCommand: SlashCommand = {
  name: "gateway",
  description: "Manage the omnichannel messaging gateway (Telegram, Discord, Slack, Webhooks)",
  async execute(args, ctx) {
    const parts = args.trim().split(/\s+/).filter(Boolean);
    const subcommand = (parts[0] || "status").toLowerCase();
    const now = Date.now();

    const { gatewayManager } = await import("../gateway/gatewayManager.js");

    switch (subcommand) {
      case "status": {
        const status = gatewayManager.getStatus();
        const cfg = gatewayManager.getConfig();
        const lines = [
          "Gateway Status:",
          `- Enabled       : ${status.enabled ? "Yes" : "No"}`,
          `- Default mode  : ${cfg.defaultMode}`,
          `- Default ws    : ${cfg.defaultWorkspace}`,
          "",
          "Channel Status:",
        ];
        for (const [ch, st] of Object.entries(status.channels)) {
          const configured = (st as any).configured ? "configured" : "not configured";
          lines.push(
            `  ${ch.padEnd(10)}: ${(st as any).enabled ? "enabled" : "disabled"} | ${configured}`,
            `             recv=${(st as any).messagesReceived}  sent=${(st as any).messagesSent}  err=${(st as any).errors}`
          );
        }
        lines.push(
          "",
          `Total received: ${status.totalMessagesReceived}  sent: ${status.totalMessagesSent}  errors: ${status.totalErrors}`,
          "",
          "Tip: Webhooks are routed via /api/gateway/* when running in server mode (superagent --server) or standalone listener (superagent gateway listen [port]).",
          "Configure channel credentials via /gateway config <channel> <key> <value> or edit ~/.superagent-r/gateway-config.json."
        );
        ctx.addLine({ type: "system", content: lines.join("\n"), timestamp: now });
        break;
      }

      case "enable": {
        gatewayManager.updateConfig({ enabled: true });
        ctx.addLine({ type: "system", content: "Gateway enabled.", timestamp: now });
        break;
      }

      case "disable": {
        gatewayManager.updateConfig({ enabled: false });
        ctx.addLine({ type: "system", content: "Gateway disabled.", timestamp: now });
        break;
      }

      case "config": {
        // /gateway config <channel> [key] [value]
        const channel = parts[1]?.toLowerCase();
        const key = parts[2]?.toLowerCase();
        const value = parts.slice(3).join(" ");

        if (!channel) {
          const cfg = gatewayManager.getConfig();
          ctx.addLine({
            type: "system",
            content: [
              "Current Gateway Config:",
              JSON.stringify(cfg, null, 2),
              "",
              "Usage: /gateway config <channel> <key> <value>",
              "Channels: telegram, discord, slack, webhook",
              "Keys:",
              "  telegram : botToken, allowedUserIds (comma-separated), defaultWorkspace",
              "  discord  : botToken, webhookUrl, allowedUserIds, defaultWorkspace",
              "  slack    : botToken, appToken (for Socket Mode), signingSecret, allowedUserIds, defaultWorkspace",
              "  webhook  : secretToken, defaultWorkspace",
              "Examples:",
              "  /gateway config telegram botToken 123:TOKEN",
              "  /gateway config slack appToken xapp-1-...",
              "  /gateway config discord webhookUrl https://discord.com/api/webhooks/...",
            ].join("\n"),
            timestamp: now,
          });
          break;
        }

        if (!["telegram", "discord", "slack", "webhook"].includes(channel)) {
          ctx.addLine({
            type: "error",
            content: `Unknown channel: ${channel}. Valid channels: telegram, discord, slack, webhook`,
            timestamp: now,
          });
          break;
        }

        if (!key || !value) {
          ctx.addLine({
            type: "error",
            content: `Usage: /gateway config ${channel} <key> <value>`,
            timestamp: now,
          });
          break;
        }

        const existingCfg = gatewayManager.getConfig();
        const channelCfg = { ...(existingCfg.channels as any)[channel] };

        if (key === "alloweduserids" || key === "allowedUserIds") {
          channelCfg.allowedUserIds = value.split(",").map((s) => s.trim()).filter(Boolean);
        } else if (key === "enabled") {
          channelCfg.enabled = value.toLowerCase() === "true" || value === "1";
        } else {
          // Map camelCase or lowercase to actual field names
          const keyMap: Record<string, string> = {
            bottoken: "botToken",
            botToken: "botToken",
            apptoken: "appToken",
            appToken: "appToken",
            webhookurl: "webhookUrl",
            webhookUrl: "webhookUrl",
            signingsecret: "signingSecret",
            signingSecret: "signingSecret",
            secrettoken: "secretToken",
            secretToken: "secretToken",
            defaultworkspace: "defaultWorkspace",
            defaultWorkspace: "defaultWorkspace",
            webhooksecret: "webhookSecret",
            webhookSecret: "webhookSecret",
          };
          const mappedKey = keyMap[key] || key;
          channelCfg[mappedKey] = value;
        }

        gatewayManager.updateConfig({
          channels: {
            ...existingCfg.channels,
            [channel]: channelCfg,
          } as any,
        });

        // Mask secret values in confirmation output
        const maskedValue = (key.toLowerCase().includes("token") || key.toLowerCase().includes("secret"))
          ? value.slice(0, 4) + "****"
          : value;
        ctx.addLine({
          type: "system",
          content: `Gateway ${channel}.${key} updated to: ${maskedValue}`,
          timestamp: now,
        });
        break;
      }

      case "sessions": {
        const cfg = gatewayManager.getConfig();
        ctx.addLine({
          type: "system",
          content: [
            "Gateway session info is stored in ~/.superagent-r/gateway-sessions.json.",
            "Sessions are keyed by channel:senderId and auto-created on first message.",
            `Default workspace: ${cfg.defaultWorkspace}`,
          ].join("\n"),
          timestamp: now,
        });
        break;
      }

      case "poll": {
        const channel = parts[1] || "all";
        ctx.addLine({
          type: "system",
          content: [
            `Gateway Polling Runner (${channel}):`,
            "To run continuous bot polling in the background without opening HTTP ports:",
            `  superagent gateway poll ${channel}`,
            "",
            "Supported channels:",
            "  - telegram : Long-polling loop using getUpdates",
            "  - discord  : Real-time Gateway WebSocket (v10)",
            "  - slack    : Real-time Socket Mode WebSocket (connections:write)",
            "  - all      : Concurrently poll all configured channels",
          ].join("\n"),
          timestamp: now,
        });
        break;
      }

      default: {
        ctx.addLine({
          type: "system",
          content: [
            "Usage: /gateway <subcommand> [options]",
            "",
            "Subcommands:",
            "  status                        - Show gateway status and channel stats",
            "  enable                        - Enable the gateway globally",
            "  disable                       - Disable the gateway globally",
            "  config                        - Show full gateway config",
            "  config <channel> <key> <val>  - Set a channel configuration value",
            "  sessions                      - Show gateway sessions info",
            "  poll [channel]                - Show background polling instructions",
            "",
            "Channels: telegram, discord, slack, webhook",
            "Note: Gateway HTTP routes are active when running superagent --server.",
            "      Direct polling daemon runs via: superagent gateway poll [channel]",
          ].join("\n"),
          timestamp: now,
        });
      }
    }
  },
};

registry.register(gatewayCommand);

import fs from "fs";
import path from "path";
import os from "os";
import {
  GatewayChannel,
  GatewayConfig,
  GatewayInboundMessage,
  GatewayOutboundMessage,
  GatewaySessionMapping,
  GatewayStatus
} from "./gatewayTypes.js";
import { WebhookAdapter } from "./adapters/webhookAdapter.js";
import { TelegramAdapter } from "./adapters/telegramAdapter.js";
import { DiscordAdapter } from "./adapters/discordAdapter.js";
import { SlackAdapter } from "./adapters/slackAdapter.js";
import { generateSessionId } from "../config.js";

const DEFAULT_CONFIG: GatewayConfig = {
  enabled: true,
  defaultMode: "single",
  defaultWorkspace: process.cwd(),
  channels: {
    webhook: { enabled: true },
    telegram: { enabled: false },
    discord: { enabled: false },
    slack: { enabled: false }
  }
};

export class GatewayManager {
  private configPath: string;
  private sessionsPath: string;
  private config: GatewayConfig;
  private sessions: Map<string, GatewaySessionMapping> = new Map();
  private stats: Record<GatewayChannel, { messagesReceived: number; messagesSent: number; errors: number }> = {
    webhook: { messagesReceived: 0, messagesSent: 0, errors: 0 },
    telegram: { messagesReceived: 0, messagesSent: 0, errors: 0 },
    discord: { messagesReceived: 0, messagesSent: 0, errors: 0 },
    slack: { messagesReceived: 0, messagesSent: 0, errors: 0 }
  };

  private webhookAdapter: WebhookAdapter;
  private telegramAdapter: TelegramAdapter;
  private discordAdapter: DiscordAdapter;
  private slackAdapter: SlackAdapter;

  constructor(customConfigDir?: string) {
    const baseDir = customConfigDir || path.join(os.homedir(), ".superagent-r");
    this.configPath = path.join(baseDir, "gateway-config.json");
    this.sessionsPath = path.join(baseDir, "gateway-sessions.json");
    this.config = this.loadConfig();
    this.loadSessions();

    this.webhookAdapter = new WebhookAdapter(this.config.channels.webhook);
    this.telegramAdapter = new TelegramAdapter(this.config.channels.telegram);
    this.discordAdapter = new DiscordAdapter(this.config.channels.discord);
    this.slackAdapter = new SlackAdapter(this.config.channels.slack);
  }

  public getConfig(): GatewayConfig {
    return JSON.parse(JSON.stringify(this.config));
  }

  public updateConfig(newConfig: Partial<GatewayConfig>): GatewayConfig {
    this.config = {
      ...this.config,
      ...newConfig,
      channels: {
        ...this.config.channels,
        ...(newConfig.channels || {})
      }
    };
    this.saveConfig();

    this.webhookAdapter = new WebhookAdapter(this.config.channels.webhook);
    this.telegramAdapter = new TelegramAdapter(this.config.channels.telegram);
    this.discordAdapter = new DiscordAdapter(this.config.channels.discord);
    this.slackAdapter = new SlackAdapter(this.config.channels.slack);

    return this.getConfig();
  }

  public getStatus(): GatewayStatus {
    return {
      enabled: this.config.enabled,
      channels: {
        webhook: {
          ...this.stats.webhook,
          enabled: this.config.channels.webhook.enabled,
          configured: true
        },
        telegram: {
          ...this.stats.telegram,
          enabled: this.config.channels.telegram.enabled,
          configured: Boolean(this.config.channels.telegram.botToken)
        },
        discord: {
          ...this.stats.discord,
          enabled: this.config.channels.discord.enabled,
          configured: Boolean(this.config.channels.discord.botToken || this.config.channels.discord.webhookUrl)
        },
        slack: {
          ...this.stats.slack,
          enabled: this.config.channels.slack.enabled,
          configured: Boolean(this.config.channels.slack.botToken)
        }
      },
      totalMessagesReceived: Object.values(this.stats).reduce((acc, s) => acc + s.messagesReceived, 0),
      totalMessagesSent: Object.values(this.stats).reduce((acc, s) => acc + s.messagesSent, 0),
      totalErrors: Object.values(this.stats).reduce((acc, s) => acc + s.errors, 0)
    };
  }

  public getAdapter(channel: "webhook"): WebhookAdapter;
  public getAdapter(channel: "telegram"): TelegramAdapter;
  public getAdapter(channel: "discord"): DiscordAdapter;
  public getAdapter(channel: "slack"): SlackAdapter;
  public getAdapter(channel: GatewayChannel): any {
    switch (channel) {
      case "webhook": return this.webhookAdapter;
      case "telegram": return this.telegramAdapter;
      case "discord": return this.discordAdapter;
      case "slack": return this.slackAdapter;
    }
  }

  public getOrCreateSession(channel: GatewayChannel, senderId: string, workspaceOverride?: string): GatewaySessionMapping {
    const key = `${channel}:${senderId}`;
    let mapping = this.sessions.get(key);
    const targetWorkspace = workspaceOverride || this.config.channels[channel]?.defaultWorkspace || this.config.defaultWorkspace;

    if (!mapping) {
      mapping = {
        channel,
        senderId,
        sessionId: generateSessionId(),
        workspace: targetWorkspace,
        lastActive: Date.now()
      };
      this.sessions.set(key, mapping);
      this.saveSessions();
    } else {
      mapping.lastActive = Date.now();
      if (workspaceOverride && mapping.workspace !== workspaceOverride) {
        mapping.workspace = workspaceOverride;
        this.saveSessions();
      }
    }
    return mapping;
  }

  public async processInbound(
    inbound: GatewayInboundMessage,
    runner: (inbound: GatewayInboundMessage, session: GatewaySessionMapping) => Promise<string>
  ): Promise<GatewayOutboundMessage> {
    const channel = inbound.channel;
    this.stats[channel].messagesReceived++;

    if (!this.config.enabled) {
      this.stats[channel].errors++;
      return {
        channel,
        recipientId: inbound.senderId,
        sessionId: inbound.sessionId || "unknown",
        text: "Gateway is currently disabled by administrator.",
        status: "error"
      };
    }

    const channelConfig = this.config.channels[channel];
    if (!channelConfig || !channelConfig.enabled) {
      this.stats[channel].errors++;
      return {
        channel,
        recipientId: inbound.senderId,
        sessionId: inbound.sessionId || "unknown",
        text: `Gateway channel "${channel}" is currently disabled.`,
        status: "error"
      };
    }

    // Check user permissions per adapter
    if (channel === "telegram" && !this.telegramAdapter.isUserAllowed(inbound.senderId)) {
      this.stats[channel].errors++;
      return {
        channel,
        recipientId: inbound.senderId,
        sessionId: inbound.sessionId || "unauthorized",
        text: "Access denied: your Telegram user ID is not authorized.",
        status: "error"
      };
    }

    if (channel === "discord" && !this.discordAdapter.isUserAllowed(inbound.senderId)) {
      this.stats[channel].errors++;
      return {
        channel,
        recipientId: inbound.senderId,
        sessionId: inbound.sessionId || "unauthorized",
        text: "Access denied: your Discord user ID is not authorized.",
        status: "error"
      };
    }

    if (channel === "slack" && !this.slackAdapter.isUserAllowed(inbound.senderName || inbound.senderId)) {
      this.stats[channel].errors++;
      return {
        channel,
        recipientId: inbound.senderId,
        sessionId: inbound.sessionId || "unauthorized",
        text: "Access denied: your Slack user ID is not authorized.",
        status: "error"
      };
    }

    const session = this.getOrCreateSession(channel, inbound.senderId, inbound.workspace);
    inbound.sessionId = session.sessionId;

    try {
      const responseText = await runner(inbound, session);
      const outbound: GatewayOutboundMessage = {
        channel,
        recipientId: inbound.senderId,
        sessionId: session.sessionId,
        text: responseText,
        status: "success"
      };

      // Send reply asynchronously via the adapter if applicable
      await this.dispatchOutboundReply(inbound, outbound);

      this.stats[channel].messagesSent++;
      return outbound;
    } catch (err: any) {
      this.stats[channel].errors++;
      const errorMessage = err.message || String(err);
      const errorOutbound: GatewayOutboundMessage = {
        channel,
        recipientId: inbound.senderId,
        sessionId: session.sessionId,
        text: `Error processing request: ${errorMessage}`,
        status: "error"
      };
      await this.dispatchOutboundReply(inbound, errorOutbound);
      return errorOutbound;
    }
  }

  private async dispatchOutboundReply(inbound: GatewayInboundMessage, outbound: GatewayOutboundMessage): Promise<void> {
    try {
      if (outbound.channel === "webhook" && inbound.replyCallbackUrl) {
        await this.webhookAdapter.sendReply(inbound.replyCallbackUrl, outbound);
      } else if (outbound.channel === "telegram" && this.config.channels.telegram.botToken) {
        await this.telegramAdapter.sendReply(outbound.recipientId, outbound.text);
      } else if (outbound.channel === "discord" && (this.config.channels.discord.botToken || this.config.channels.discord.webhookUrl)) {
        await this.discordAdapter.sendReply(outbound.recipientId, outbound.text);
      } else if (outbound.channel === "slack" && this.config.channels.slack.botToken) {
        await this.slackAdapter.sendReply(outbound.recipientId, outbound.text);
      }
    } catch {
      // Ignore background outbound dispatch failure
    }
  }

  private loadConfig(): GatewayConfig {
    try {
      if (fs.existsSync(this.configPath)) {
        const raw = fs.readFileSync(this.configPath, "utf-8");
        const parsed = JSON.parse(raw);
        return {
          ...DEFAULT_CONFIG,
          ...parsed,
          channels: {
            ...DEFAULT_CONFIG.channels,
            ...(parsed.channels || {})
          }
        };
      }
    } catch {}
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }

  private saveConfig(): void {
    try {
      const dir = path.dirname(this.configPath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), "utf-8");
    } catch {}
  }

  private loadSessions(): void {
    try {
      if (fs.existsSync(this.sessionsPath)) {
        const raw = fs.readFileSync(this.sessionsPath, "utf-8");
        const data: GatewaySessionMapping[] = JSON.parse(raw);
        if (Array.isArray(data)) {
          for (const item of data) {
            this.sessions.set(`${item.channel}:${item.senderId}`, item);
          }
        }
      }
    } catch {}
  }

  private saveSessions(): void {
    try {
      const dir = path.dirname(this.sessionsPath);
      fs.mkdirSync(dir, { recursive: true });
      const list = Array.from(this.sessions.values());
      fs.writeFileSync(this.sessionsPath, JSON.stringify(list, null, 2), "utf-8");
    } catch {}
  }
}

export const gatewayManager = new GatewayManager();

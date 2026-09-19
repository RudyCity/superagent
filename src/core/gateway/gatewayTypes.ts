export type GatewayChannel = "webhook" | "telegram" | "discord" | "slack";

export interface GatewayInboundMessage {
  channel: GatewayChannel;
  channelMessageId: string;
  senderId: string;
  senderName?: string;
  sessionId?: string;
  text: string;
  workspace?: string;
  replyCallbackUrl?: string;
  rawPayload?: any;
}

export interface GatewayOutboundMessage {
  channel: GatewayChannel;
  recipientId: string;
  sessionId: string;
  text: string;
  status: "success" | "error" | "in_progress";
  metadata?: Record<string, any>;
}

export interface WebhookChannelConfig {
  enabled: boolean;
  secretToken?: string;
  defaultWorkspace?: string;
}

export interface TelegramChannelConfig {
  enabled: boolean;
  botToken?: string;
  allowedUserIds?: string[];
  webhookSecret?: string;
  defaultWorkspace?: string;
}

export interface DiscordChannelConfig {
  enabled: boolean;
  botToken?: string;
  webhookUrl?: string;
  allowedUserIds?: string[];
  defaultWorkspace?: string;
}

export interface SlackChannelConfig {
  enabled: boolean;
  botToken?: string;
  appToken?: string;
  signingSecret?: string;
  allowedUserIds?: string[];
  defaultWorkspace?: string;
}

export interface GatewayConfig {
  enabled: boolean;
  defaultMode: "single" | "multi";
  defaultWorkspace: string;
  channels: {
    webhook: WebhookChannelConfig;
    telegram: TelegramChannelConfig;
    discord: DiscordChannelConfig;
    slack: SlackChannelConfig;
  };
}

export interface GatewayChannelStats {
  enabled: boolean;
  configured: boolean;
  messagesReceived: number;
  messagesSent: number;
  errors: number;
}

export interface GatewayStatus {
  enabled: boolean;
  channels: Record<GatewayChannel, GatewayChannelStats>;
  totalMessagesReceived: number;
  totalMessagesSent: number;
  totalErrors: number;
}

export interface GatewaySessionMapping {
  channel: GatewayChannel;
  senderId: string;
  sessionId: string;
  workspace: string;
  lastActive: number;
}

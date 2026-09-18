import { GatewayInboundMessage, GatewayOutboundMessage, SlackChannelConfig } from "../gatewayTypes.js";

export class SlackAdapter {
  constructor(private config: SlackChannelConfig) {}

  public isUserAllowed(userId: string): boolean {
    if (!this.config.allowedUserIds || this.config.allowedUserIds.length === 0) {
      return true;
    }
    return this.config.allowedUserIds.includes(String(userId));
  }

  public handleUrlVerification(payload: any): { challenge: string } | null {
    if (payload?.type === "url_verification" && payload?.challenge) {
      return { challenge: payload.challenge };
    }
    return null;
  }

  public parseInbound(payload: any): GatewayInboundMessage | null {
    if (payload?.type !== "event_callback" || !payload.event) {
      return null;
    }

    const event = payload.event;
    // Prevent bot self-reply loops
    if (event.bot_id || event.subtype === "bot_message") {
      return null;
    }

    const text = String(event.text || "").trim();
    if (!text) {
      return null;
    }

    const channelId = String(event.channel || "");
    const userId = String(event.user || channelId);
    const messageId = String(event.client_msg_id || event.ts || `slack_${Date.now()}`);

    return {
      channel: "slack",
      channelMessageId: messageId,
      senderId: channelId,
      senderName: userId,
      text,
      workspace: this.config.defaultWorkspace,
      rawPayload: payload
    };
  }

  public async sendReply(channelId: string, text: string): Promise<boolean> {
    if (!this.config.botToken) {
      return false;
    }

    try {
      const res = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.config.botToken}`
        },
        body: JSON.stringify({
          channel: channelId,
          text
        })
      });

      const data = await res.json().catch(() => ({}));
      return res.ok && (data as any)?.ok === true;
    } catch {
      return false;
    }
  }
}

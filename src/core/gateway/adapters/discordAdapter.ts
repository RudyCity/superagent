import { GatewayInboundMessage, GatewayOutboundMessage, DiscordChannelConfig } from "../gatewayTypes.js";

export class DiscordAdapter {
  constructor(private config: DiscordChannelConfig) {}

  public isUserAllowed(userId: string): boolean {
    if (!this.config.allowedUserIds || this.config.allowedUserIds.length === 0) {
      return true;
    }
    return this.config.allowedUserIds.includes(String(userId));
  }

  public parseInbound(payload: any): GatewayInboundMessage | null {
    // Discord Interaction Ping (Type 1)
    if (payload?.type === 1) {
      return null;
    }

    // Direct message / channel message or interaction
    const user = payload?.member?.user || payload?.author || payload?.user;
    const userId = String(user?.id || "");
    const username = user?.username || "DiscordUser";
    const channelId = String(payload?.channel_id || payload?.channelId || userId);

    let text = "";
    if (payload?.data?.options && Array.isArray(payload.data.options)) {
      const option = payload.data.options.find((o: any) => o.name === "message" || o.name === "prompt") || payload.data.options[0];
      text = String(option?.value || "").trim();
    } else {
      text = String(payload?.content || payload?.text || "").trim();
    }

    if (!text) {
      return null;
    }

    const messageId = String(payload?.id || `disc_${Date.now()}`);

    return {
      channel: "discord",
      channelMessageId: messageId,
      senderId: channelId,
      senderName: username,
      text,
      workspace: this.config.defaultWorkspace,
      rawPayload: payload
    };
  }

  public chunkMessage(text: string, maxChunkLength: number = 1900): string[] {
    if (text.length <= maxChunkLength) {
      return [text];
    }
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= maxChunkLength) {
        chunks.push(remaining);
        break;
      }
      let splitPos = remaining.lastIndexOf("\n", maxChunkLength);
      if (splitPos === -1 || splitPos < maxChunkLength / 2) {
        splitPos = remaining.lastIndexOf(" ", maxChunkLength);
      }
      if (splitPos === -1 || splitPos < maxChunkLength / 2) {
        splitPos = maxChunkLength;
      }
      chunks.push(remaining.substring(0, splitPos).trim());
      remaining = remaining.substring(splitPos).trim();
    }
    return chunks;
  }

  public async sendReply(targetId: string, text: string): Promise<boolean> {
    const chunks = this.chunkMessage(text);
    let allOk = true;

    for (const chunk of chunks) {
      try {
        let res: Response;
        if (this.config.webhookUrl) {
          res = await fetch(this.config.webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: chunk })
          });
        } else if (this.config.botToken) {
          const url = `https://discord.com/api/v10/channels/${targetId}/messages`;
          res = await fetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bot ${this.config.botToken}`
            },
            body: JSON.stringify({ content: chunk })
          });
        } else {
          return false;
        }

        if (!res.ok) {
          allOk = false;
        }
      } catch {
        allOk = false;
      }
    }

    return allOk;
  }
}

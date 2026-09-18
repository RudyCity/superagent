import { GatewayInboundMessage, GatewayOutboundMessage, TelegramChannelConfig } from "../gatewayTypes.js";

export class TelegramAdapter {
  constructor(private config: TelegramChannelConfig) {}

  public isAuthorized(headers: Record<string, string | string[] | undefined>): boolean {
    if (!this.config.webhookSecret) {
      return true;
    }
    const headerSecret = headers["x-telegram-bot-api-secret-token"];
    return headerSecret === this.config.webhookSecret;
  }

  public isUserAllowed(userId: string | number): boolean {
    if (!this.config.allowedUserIds || this.config.allowedUserIds.length === 0) {
      return true;
    }
    const idStr = String(userId);
    return this.config.allowedUserIds.includes(idStr);
  }

  public parseInbound(payload: any): GatewayInboundMessage | null {
    const message = payload?.message || payload?.edited_message || payload?.channel_post;
    if (!message || !message.text) {
      return null;
    }

    const chatId = String(message.chat?.id || "");
    const fromId = String(message.from?.id || chatId);
    const username = message.from?.username || message.from?.first_name || "TelegramUser";
    const text = message.text.trim();
    const messageId = String(message.message_id);

    return {
      channel: "telegram",
      channelMessageId: messageId,
      senderId: chatId,
      senderName: username,
      text,
      workspace: this.config.defaultWorkspace,
      rawPayload: payload
    };
  }

  public chunkMessage(text: string, maxChunkLength: number = 4000): string[] {
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

  public async sendReply(chatId: string, text: string): Promise<boolean> {
    if (!this.config.botToken) {
      return false;
    }
    const chunks = this.chunkMessage(text);
    let allOk = true;

    for (const chunk of chunks) {
      try {
        const url = `https://api.telegram.org/bot${this.config.botToken}/sendMessage`;
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: chunk
          })
        });
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

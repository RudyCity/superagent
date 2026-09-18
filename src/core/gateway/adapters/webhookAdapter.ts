import { GatewayInboundMessage, GatewayOutboundMessage, WebhookChannelConfig } from "../gatewayTypes.js";

export class WebhookAdapter {
  constructor(private config: WebhookChannelConfig) {}

  public isAuthorized(headers: Record<string, string | string[] | undefined>): boolean {
    if (!this.config.secretToken) {
      return true;
    }
    const headerSecret = headers["x-webhook-secret"] || headers["x-api-key"];
    const authHeader = headers["authorization"];
    const bearer = typeof authHeader === "string" && authHeader.startsWith("Bearer ")
      ? authHeader.substring(7).trim()
      : undefined;

    const provided = (typeof headerSecret === "string" ? headerSecret : undefined) || bearer;
    return provided === this.config.secretToken;
  }

  public parseInbound(body: any, headers?: Record<string, any>): GatewayInboundMessage {
    const text = String(body.message || body.text || body.prompt || "").trim();
    const senderId = String(body.senderId || body.sender || body.userId || "anonymous-webhook-user");
    const senderName = body.senderName ? String(body.senderName) : undefined;
    const sessionId = body.sessionId ? String(body.sessionId) : undefined;
    const workspace = body.workspace ? String(body.workspace) : undefined;
    const replyCallbackUrl = body.replyCallbackUrl || body.replyUrl;

    const channelMessageId = body.id || `wh_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

    return {
      channel: "webhook",
      channelMessageId,
      senderId,
      senderName,
      sessionId,
      text,
      workspace,
      replyCallbackUrl,
      rawPayload: body
    };
  }

  public formatOutbound(message: GatewayOutboundMessage): any {
    return {
      channel: message.channel,
      recipientId: message.recipientId,
      sessionId: message.sessionId,
      text: message.text,
      status: message.status,
      timestamp: Date.now(),
      metadata: message.metadata || {}
    };
  }

  public async sendReply(replyUrl: string, outbound: GatewayOutboundMessage): Promise<boolean> {
    try {
      const payload = this.formatOutbound(outbound);
      const res = await fetch(replyUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}

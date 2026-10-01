import { RemoteAgentConfig, maskToken } from "./config.js";
import {
  RemoteAgentEnvelope,
  encodeEnvelope,
  EnvelopeReassembler,
  validateEnvelope,
} from "./protocol.js";

/**
 * Note on Telegram Bot API File Limits (for future file transfer work):
 * Bot API allows bots to send files up to 50 MB and download files up to 20 MB.
 * For v1, transport is restricted to text JSON envelopes only.
 */

export interface MuseClientOptions {
  config: RemoteAgentConfig;
  signal?: AbortSignal;
}

export class MuseClient {
  private config: RemoteAgentConfig;
  private reassembler = new EnvelopeReassembler();
  private isPolling = false;
  private seenUpdateIds = new Set<number>();
  private readonly maxSeenUpdateIds = 2000;

  constructor(config: RemoteAgentConfig) {
    this.config = { ...config };
  }

  public updateConfig(config: RemoteAgentConfig): void {
    this.config = { ...config };
  }

  public getConfig(): RemoteAgentConfig {
    return { ...this.config };
  }

  public isPollerActive(): boolean {
    return this.isPolling;
  }

  /**
   * Sanitizes string to prevent leaking the bot token in error traces or logs.
   */
  private sanitizeError(str: string): string {
    if (!this.config.botToken) return str;
    const token = this.config.botToken;
    const escaped = token.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
    return str.replace(new RegExp(escaped, "g"), "[REDACTED_BOT_TOKEN]");
  }

  /**
   * Telegram Bot API deleteWebhook. Must be called before getUpdates long polling.
   */
  public async deleteWebhook(): Promise<boolean> {
    const token = this.config.botToken;
    if (!token) {
      throw new Error("Bot token is not configured.");
    }

    try {
      const url = `https://api.telegram.org/bot${token}/deleteWebhook`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ drop_pending_updates: false }),
      });
      const data = (await res.json()) as any;
      return Boolean(data && data.ok);
    } catch (err: any) {
      const sanitized = this.sanitizeError(err.message || String(err));
      console.warn(`[MuseClient] deleteWebhook warning: ${sanitized}`);
      return false;
    }
  }

  /**
   * Sends a single raw text message to a Telegram chat, handling 429 rate limits.
   */
  public async sendMessage(
    chatId: string | number,
    text: string,
    retryCount = 0
  ): Promise<boolean> {
    const token = this.config.botToken;
    if (!token) {
      throw new Error("Bot token is not configured.");
    }

    const maxRetries = 3;
    const url = `https://api.telegram.org/bot${token}/sendMessage`;

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
        }),
      });

      if (res.status === 429) {
        // Respect Telegram parameters.retry_after
        const body = (await res.json().catch(() => ({}))) as any;
        const retryAfterSec = body?.parameters?.retry_after ?? 2;
        if (retryCount < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, retryAfterSec * 1000 + 500));
          return this.sendMessage(chatId, text, retryCount + 1);
        }
        return false;
      }

      if (!res.ok) {
        const bodyText = await res.text().catch(() => "");
        const sanitized = this.sanitizeError(`HTTP ${res.status}: ${bodyText}`);
        console.warn(`[MuseClient] sendMessage failed: ${sanitized}`);
        return false;
      }

      const data = (await res.json()) as any;
      return Boolean(data && data.ok);
    } catch (err: any) {
      const sanitized = this.sanitizeError(err.message || String(err));
      console.warn(`[MuseClient] sendMessage network error: ${sanitized}`);
      return false;
    }
  }

  /**
   * Sends an envelope to the configured private group, splitting into chunks if needed.
   * Respects chat rate limits with brief delays between multi-part chunks.
   */
  public async sendEnvelope(
    envelope: RemoteAgentEnvelope,
    targetGroupId?: string | number
  ): Promise<boolean> {
    const groupId = targetGroupId || this.config.groupId;
    if (!groupId) {
      throw new Error("Group ID is not configured.");
    }

    const chunks = encodeEnvelope(envelope);
    let allOk = true;

    for (let i = 0; i < chunks.length; i++) {
      const ok = await this.sendMessage(groupId, chunks[i]);
      if (!ok) {
        allOk = false;
      }
      // If multiple chunks, insert a 1000ms delay to respect 1 msg/sec rate limit per chat
      if (chunks.length > 1 && i < chunks.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    return allOk;
  }

  /**
   * Starts the long-polling loop.
   * Only one poller loop is permitted per MuseClient instance.
   * Yields validated envelopes received from Muse bot in the configured group.
   */
  public async pollEnvelopes(
    onEnvelope: (envelope: RemoteAgentEnvelope) => Promise<void> | void,
    signal?: AbortSignal
  ): Promise<void> {
    if (this.isPolling) {
      throw new Error("A poller is already running for this bot token.");
    }

    const token = this.config.botToken;
    if (!token) {
      throw new Error("Bot token is not configured.");
    }

    this.isPolling = true;
    let offset = 0;
    let consecutiveErrors = 0;

    try {
      // Step 1: Ensure webhooks are deleted before polling
      await this.deleteWebhook();

      // Step 2: Main polling loop
      while (!signal?.aborted) {
        try {
          const url = `https://api.telegram.org/bot${token}/getUpdates?offset=${offset}&timeout=30&allowed_updates=${encodeURIComponent(
            JSON.stringify(["message"])
          )}`;

          const res = await fetch(url, { signal });

          if (res.status === 429) {
            const body = (await res.json().catch(() => ({}))) as any;
            const retryAfterSec = body?.parameters?.retry_after ?? 3;
            await new Promise((resolve) => setTimeout(resolve, retryAfterSec * 1000 + 500));
            continue;
          }

          if (!res.ok) {
            consecutiveErrors++;
            const backoffMs = Math.min(1000 * Math.pow(2, consecutiveErrors), 15000);
            await new Promise((resolve) => setTimeout(resolve, backoffMs));
            continue;
          }

          const data = (await res.json()) as any;
          if (!data || !data.ok || !Array.isArray(data.result)) {
            continue;
          }

          consecutiveErrors = 0; // Reset consecutive errors on success

          for (const update of data.result) {
            const updateId = update.update_id;
            if (typeof updateId === "number") {
              offset = Math.max(offset, updateId + 1);

              if (this.seenUpdateIds.has(updateId)) {
                continue;
              }
              this.seenUpdateIds.add(updateId);
              if (this.seenUpdateIds.size > this.maxSeenUpdateIds) {
                // Prune older half of seen update IDs
                const toRemove = Array.from(this.seenUpdateIds).slice(
                  0,
                  this.maxSeenUpdateIds / 2
                );
                for (const id of toRemove) this.seenUpdateIds.delete(id);
              }
            }

            const msg = update.message;
            if (!msg || typeof msg.text !== "string") {
              continue;
            }

            const chatId = msg.chat?.id;
            const senderId = msg.from?.id;

            // Rule 1: Ignore any message where message.chat.id != config.groupId
            if (this.config.groupId !== undefined && this.config.groupId !== "") {
              if (String(chatId) !== String(this.config.groupId)) {
                continue;
              }
            }

            // Rule 2: Ignore any message where sender is not Muse's bot ID
            if (this.config.museBotId !== undefined && this.config.museBotId !== "") {
              if (String(senderId) !== String(this.config.museBotId)) {
                continue;
              }
            }

            // Feed chunk or message to reassembler
            const envelope = this.reassembler.processMessage(msg.text);
            if (!envelope) {
              continue;
            }

            // Rule 3: Validate envelope schema
            const val = validateEnvelope(envelope, senderId, chatId, {
              groupId: this.config.groupId,
              museBotId: this.config.museBotId,
            });

            if (!val.valid) {
              console.warn(`[MuseClient] Envelope rejected: ${val.error}`);
              continue;
            }

            try {
              await onEnvelope(val.envelope!);
            } catch (handleErr: any) {
              const sanitized = this.sanitizeError(handleErr.message || String(handleErr));
              console.error(`[MuseClient] Error in onEnvelope handler: ${sanitized}`);
            }
          }
        } catch (err: any) {
          if (signal?.aborted || err.name === "AbortError") {
            break;
          }
          consecutiveErrors++;
          const backoffMs = Math.min(1000 * Math.pow(2, consecutiveErrors), 15000);
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
        }
      }
    } finally {
      this.isPolling = false;
    }
  }
}

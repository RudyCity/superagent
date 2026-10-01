import { RemoteAgentConfig, maskToken } from "./config.js";
import {
  RemoteAgentEnvelope,
  encodeEnvelope,
  EnvelopeReassembler,
  validateEnvelope,
} from "./protocol.js";
import { logE2E } from "../utils/unifiedLogger.js";

/**
 * Note on Telegram Bot API File Limits (for future file transfer work):
 * Bot API allows bots to send files up to 50 MB and download files up to 20 MB.
 * For v1, transport is restricted to text JSON envelopes only.
 */

export interface MuseClientOptions {
  config: RemoteAgentConfig;
  signal?: AbortSignal;
}

export interface BotMeInfo {
  ok: boolean;
  id?: number;
  username?: string;
  firstName?: string;
  canReadGroupMessages?: boolean;
  error?: string;
}

export class MuseClient {
  private config: RemoteAgentConfig;
  private reassembler = new EnvelopeReassembler();
  private isPolling = false;
  private seenUpdateIds = new Set<number>();
  private readonly maxSeenUpdateIds = 2000;
  private lastSentMessageId?: number;

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

  public getLastSentMessageId(): number | undefined {
    return this.lastSentMessageId;
  }

  /**
   * Fetches the bot identity and privacy mode status via Telegram Bot API getMe.
   */
  public async getMeInfo(): Promise<BotMeInfo> {
    const token = this.config.botToken;
    if (!token) {
      return { ok: false, error: "Bot token is not configured." };
    }
    try {
      const url = `https://api.telegram.org/bot${token}/getMe`;
      const res = await fetch(url);
      const data = (await res.json()) as any;
      if (!data || !data.ok || !data.result) {
        return { ok: false, error: data?.description || `HTTP ${res.status}` };
      }
      return {
        ok: true,
        id: data.result.id,
        username: data.result.username,
        firstName: data.result.first_name,
        canReadGroupMessages: Boolean(data.result.can_read_all_group_messages),
      };
    } catch (err: any) {
      return { ok: false, error: this.sanitizeError(err.message || String(err)) };
    }
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
    retryCount = 0,
    replyToMessageId?: number
  ): Promise<boolean> {
    const token = this.config.botToken;
    if (!token) {
      throw new Error("Bot token is not configured.");
    }

    const maxRetries = 3;
    const url = `https://api.telegram.org/bot${token}/sendMessage`;

    try {
      const payload: Record<string, any> = {
        chat_id: chatId,
        text,
      };
      if (replyToMessageId) {
        payload.reply_parameters = { message_id: replyToMessageId };
      }

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (res.status === 429) {
        // Respect Telegram parameters.retry_after
        const body = (await res.json().catch(() => ({}))) as any;
        const retryAfterSec = body?.parameters?.retry_after ?? 2;
        logE2E("REMOTE-AGENT", `Telegram 429 rate limit. Retrying after ${retryAfterSec}s (retry ${retryCount + 1}/${maxRetries})`);
        if (retryCount < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, retryAfterSec * 1000 + 500));
          return this.sendMessage(chatId, text, retryCount + 1, replyToMessageId);
        }
        return false;
      }

      if (!res.ok) {
        const bodyText = await res.text().catch(() => "");
        const sanitized = this.sanitizeError(`HTTP ${res.status}: ${bodyText}`);
        logE2E("REMOTE-AGENT", `sendMessage failed: ${sanitized}`);
        console.warn(`[MuseClient] sendMessage failed: ${sanitized}`);
        return false;
      }

      const data = (await res.json()) as any;
      if (data && data.ok && data.result?.message_id) {
        this.lastSentMessageId = data.result.message_id;
      }
      return Boolean(data && data.ok);
    } catch (err: any) {
      const sanitized = this.sanitizeError(err.message || String(err));
      logE2E("REMOTE-AGENT", `sendMessage network error: ${sanitized}`);
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
    targetGroupId?: string | number,
    replyToMessageId?: number
  ): Promise<boolean> {
    const groupId = targetGroupId || this.config.groupId;
    if (!groupId) {
      throw new Error("Group ID is not configured.");
    }

    const chunks = encodeEnvelope(envelope);
    let allOk = true;

    logE2E("REMOTE-AGENT", `Sending envelope ${envelope.kind} (chunks: ${chunks.length}) to group ${groupId}`);

    for (let i = 0; i < chunks.length; i++) {
      const ok = await this.sendMessage(groupId, chunks[i], 0, replyToMessageId);
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

    logE2E("REMOTE-AGENT", `Starting envelope polling loop for group ${this.config.groupId}, museBotId: ${this.config.museBotId}`);

    try {
      // Step 1: Ensure webhooks are deleted before polling
      await this.deleteWebhook();

      // Step 2: Main polling loop
      while (!signal?.aborted) {
        try {
          const url = `https://api.telegram.org/bot${token}/getUpdates?offset=${offset}&timeout=30&allowed_updates=${encodeURIComponent(
            JSON.stringify(["message"])
          )}`;

          // Create a per-request signal with a 35s timeout to prevent hanging sockets
          const fetchSignal = signal
            ? AbortSignal.any([signal, AbortSignal.timeout(35000)])
            : AbortSignal.timeout(35000);

          const res = await fetch(url, { signal: fetchSignal });

          if (res.status === 429) {
            const body = (await res.json().catch(() => ({}))) as any;
            const retryAfterSec = body?.parameters?.retry_after ?? 3;
            logE2E("REMOTE-AGENT", `pollEnvelopes 429 rate limit. Waiting ${retryAfterSec}s`);
            await new Promise((resolve) => setTimeout(resolve, retryAfterSec * 1000 + 500));
            continue;
          }

          if (!res.ok) {
            consecutiveErrors++;
            const backoffMs = Math.min(1000 * Math.pow(2, consecutiveErrors), 15000);
            logE2E("REMOTE-AGENT", `pollEnvelopes HTTP error ${res.status}. Backoff ${backoffMs}ms`);
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

            logE2E("REMOTE-AGENT", `Update ${updateId} from sender ${senderId} in chat ${chatId}`);

            // Rule 1: Ignore any message where message.chat.id != config.groupId
            if (this.config.groupId !== undefined && this.config.groupId !== "") {
              if (String(chatId) !== String(this.config.groupId)) {
                logE2E("REMOTE-AGENT", `Update ${updateId} ignored: chat ID ${chatId} != expected ${this.config.groupId}`);
                continue;
              }
            }

            // Rule 2: Ignore any message where sender is not Muse's bot ID
            if (this.config.museBotId !== undefined && this.config.museBotId !== "") {
              if (String(senderId) !== String(this.config.museBotId)) {
                logE2E("REMOTE-AGENT", `Update ${updateId} ignored: sender ID ${senderId} != expected ${this.config.museBotId}`);
                continue;
              }
            }

            // Feed chunk or message to reassembler
            const envelope = this.reassembler.processMessage(msg.text);
            if (!envelope) {
              logE2E("REMOTE-AGENT", `Update ${updateId}: message did not yield complete envelope yet (pending assembly or non-envelope text)`);
              continue;
            }

            // Rule 3: Validate envelope schema
            const val = validateEnvelope(envelope, senderId, chatId, {
              groupId: this.config.groupId,
              museBotId: this.config.museBotId,
            });

            if (!val.valid) {
              logE2E("REMOTE-AGENT", `Update ${updateId}: envelope rejected: ${val.error}`);
              console.warn(`[MuseClient] Envelope rejected: ${val.error}`);
              continue;
            }

            logE2E("REMOTE-AGENT", `Processing received envelope: kind=${val.envelope!.kind}, id=${(val.envelope as any).id || (val.envelope as any).task_id}`);

            try {
              await onEnvelope(val.envelope!);
            } catch (handleErr: any) {
              const sanitized = this.sanitizeError(handleErr.message || String(handleErr));
              logE2E("REMOTE-AGENT", `Error in onEnvelope handler: ${sanitized}`);
              console.error(`[MuseClient] Error in onEnvelope handler: ${sanitized}`);
            }
          }
        } catch (err: any) {
          if (signal?.aborted) {
            logE2E("REMOTE-AGENT", "Polling loop stopped: signal aborted by user");
            break;
          }
          // Per-request timeout is expected for long-polling when no updates arrive
          if (err.name === "TimeoutError" || (err.name === "AbortError" && !signal?.aborted)) {
            continue;
          }
          consecutiveErrors++;
          const backoffMs = Math.min(1000 * Math.pow(2, consecutiveErrors), 15000);
          const sanitized = this.sanitizeError(err.message || String(err));
          logE2E("REMOTE-AGENT", `Polling loop network error: ${sanitized}. Backoff ${backoffMs}ms`);
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
        }
      }
    } finally {
      this.isPolling = false;
      logE2E("REMOTE-AGENT", "Polling loop terminated");
    }
  }
}

import { RemoteAgentConfig, maskToken } from "./config.js";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { FILE_TRANSFER_MAX_BYTES } from "./museFileTransfer.js";
import { acquireTelegramPollingLease } from "./telegramPollingLease.js";
import {
  RemoteAgentEnvelope,
  encodeEnvelope,
  EnvelopeReassembler,
  validateEnvelope,
} from "./protocol.js";
import { logE2E } from "../utils/unifiedLogger.js";

/** An abortable delay that always removes its event listener. */
function pollingDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise(resolve => {
    let done = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (done) return;
      done = true;
      if (timeout) clearTimeout(timeout);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    signal?.addEventListener("abort", finish, { once: true });
    timeout = setTimeout(finish, Math.max(1, ms));
    if (signal?.aborted) finish();
  });
}

/** Clean per-request timeout and abort listener on every poll cycle. */
async function fetchTelegramPoll(url: string, signal?: AbortSignal): Promise<Response> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(
    () => controller.abort(new DOMException("Telegram poll timeout", "TimeoutError")),
    30_000,
  );
  timeout.unref?.();
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

/** Telegram attachment receipt confirms Telegram acceptance, not Muse ingestion. */
export interface TelegramDocumentReceipt {
  ok: true;
  chatId: string | number;
  messageId: number;
  fileId?: string;
  name: string;
  size: number;
  sha256: string;
}

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
  private lastSuccessfulPollAt?: number;
  private lastPollError?: string;

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

  /** Poller activity alone is not readiness (409 conflicts can loop forever). */
  public getPollHealth(): { lastSuccessfulPollAt?: number; lastError?: string } {
    return {
      lastSuccessfulPollAt: this.lastSuccessfulPollAt,
      lastError: this.lastPollError,
    };
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
   * 20s request timeout so a hanging connection never wedges the loop.
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
        // 20s timeout: a hanging Telegram POST must never wedge the loop
        signal: AbortSignal.timeout(20000),
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
   * 20s timeout per attempt; retries network errors and transient 5xx up to 3 times, 5s apart.
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

      // 20s per-attempt timeout: a hanging Telegram POST must never wedge the loop
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(20000),
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
        // If 400 Bad Request caused by invalid reply_parameters (e.g. replied message deleted), retry without reply_parameters
        if (
          res.status === 400 &&
          replyToMessageId &&
          /message to be replied not found|replied message not found/i.test(bodyText)
        ) {
          logE2E(
            "REMOTE-AGENT",
            `sendMessage: replied message ${replyToMessageId} not found, retrying without reply_parameters`
          );
          return this.sendMessage(chatId, text, retryCount, undefined);
        }
        // Retry transient server errors: up to 3 attempts, 5s apart
        if (res.status >= 500 && retryCount < maxRetries) {
          logE2E("REMOTE-AGENT", `sendMessage transient HTTP ${res.status}: retrying in 5s (${retryCount + 1}/${maxRetries})`);
          await new Promise((resolve) => setTimeout(resolve, 5000));
          return this.sendMessage(chatId, text, retryCount + 1, replyToMessageId);
        }
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
      console.warn(`[MuseClient] sendMessage networkerror: ${sanitized}`);
      // Retry network/timeout errors: up to 3 attempts, 5s apart
      if (retryCount < maxRetries) {
        logE2E("REMOTE-AGENT", `sendMessage retrying in 5s (${retryCount + 1}/${maxRetries})`);
        await new Promise((resolve) => setTimeout(resolve, 5000));
        return this.sendMessage(chatId, text, retryCount + 1, replyToMessageId);
      }
      return false;
    }
  }

  /**
   * Send a local file as an actual Telegram document using multipart/form-data.
   * This does not use sendMessage or MUSEBUS and does not change text behavior.
   * Retries are intentionally disabled: an ambiguous network failure may already
   * have delivered a document, and retrying could duplicate it.
   */
  public async sendDocument(
    chatId: string | number,
    filePath: string,
    caption?: string,
  ): Promise<TelegramDocumentReceipt> {
    const token = this.config.botToken;
    if (!token) throw new Error("Bot token is not configured.");
    if (caption && caption.length > 1024) throw new Error("Telegram caption exceeds 1024 characters");
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > FILE_TRANSFER_MAX_BYTES) {
      throw new Error("Document must be a regular non-symlink file of at most 8 MiB");
    }
    const bytes = await fs.readFile(filePath);
    if (bytes.length > FILE_TRANSFER_MAX_BYTES) throw new Error("Document exceeds 8 MiB");
    const name = path.basename(filePath);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const form = new FormData();
    form.append("chat_id", String(chatId));
    if (caption) form.append("caption", caption);
    form.append("document", new Blob([new Uint8Array(bytes)], {
      type: name.toLowerCase().endsWith(".csv") ? "text/csv" : "application/octet-stream",
    }), name);

    let data: any;
    try {
      const res = await fetch("https://api.telegram.org/bot" + token + "/sendDocument", {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(60_000),
      });
      data = await res.json();
      if (!res.ok || !data?.ok || typeof data?.result?.message_id !== "number") {
        throw new Error("Telegram sendDocument failed (HTTP " + res.status + "): " +
          (data?.description || "invalid delivery receipt"));
      }
    } catch (error: any) {
      throw new Error(this.sanitizeError(error?.message || String(error)));
    }
    return {
      ok: true, chatId, messageId: data.result.message_id,
      fileId: data.result.document?.file_id,
      name, size: bytes.length, sha256,
    };
  }

  /**
   * Sends an envelope to the configured private group, splitting into chunks if needed.
   * Respects chat rate limits with brief delays between multi-part chunks.
   * Reports per-chunk progress via onProgress when provided.
   */
  public async sendEnvelope(
    envelope: RemoteAgentEnvelope,
    targetGroupId?: string | number,
    replyToMessageId?: number,
    onProgress?: (message: string) => void
  ): Promise<boolean> {
    const groupId = targetGroupId || this.config.groupId;
    if (!groupId) {
      throw new Error("Group ID is not configured.");
    }

    const chunks = encodeEnvelope(envelope);
    let allOk = true;

    logE2E("REMOTE-AGENT", `Sending envelope ${envelope.kind} (chunks: ${chunks.length}) to group ${groupId}`);
    onProgress?.(`Sending ${envelope.kind} (${chunks.length} chunk${chunks.length === 1 ? "" : "s"})...`);

    for (let i = 0; i < chunks.length; i++) {
      if (chunks.length > 1) {
        onProgress?.(`Sending ${envelope.kind} chunk ${i + 1}/${chunks.length}...`);
      }
      const ok = await this.sendMessage(groupId, chunks[i], 0, replyToMessageId);
      if (!ok) {
        allOk = false;
        // If a chunk fails completely, abort remaining chunks to prevent broken fragments
        break;
      }
      // If multiple chunks, insert a 1500ms delay to respect 1 msg/sec rate limit per chat
      if (chunks.length > 1 && i < chunks.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    }

    onProgress?.(
      allOk
        ? `${envelope.kind} sent (${chunks.length}/${chunks.length} chunks)`
        : `${envelope.kind} send failed - results may not have reached Muse`
    );

    return allOk;
  }

  /**
   * Sends a chat action (e.g. "typing") to the Telegram chat.
   * Provides real-time visual feedback while processing batches or commands.
   */
  public async sendChatAction(
    chatId?: string | number,
    action: string = "typing"
  ): Promise<boolean> {
    const token = this.config.botToken;
    const targetChat = chatId || this.config.groupId;
    if (!token || !targetChat) return false;

    try {
      const url = `https://api.telegram.org/bot${token}/sendChatAction`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: targetChat, action }),
        signal: AbortSignal.timeout(5000),
      });
      const data = (await res.json().catch(() => ({}))) as any;
      return Boolean(data && data.ok);
    } catch {
      return false;
    }
  }

  /**
   * Starts the long-polling loop.
   * Only one poller loop is permitted per MuseClient instance.
   * Yields validated envelopes received from Muse bot in the configured group.
   */
  public async pollEnvelopes(
    onEnvelope: (
      envelope: RemoteAgentEnvelope,
      meta?: { messageId?: number }
    ) => Promise<void> | void,
    signal?: AbortSignal
  ): Promise<void> {
    if (this.isPolling) {
      throw new Error("A poller is already running for this bot token.");
    }

    const token = this.config.botToken;
    if (!token) {
      throw new Error("Bot token is not configured.");
    }

    // Mark the instance active before awaiting a cross-process lease. A
    // second concurrent caller must not slip through during lease acquisition.
    if (signal?.aborted) return;
    this.isPolling = true;
    this.lastSuccessfulPollAt = undefined;
    this.lastPollError = undefined;
    let pollingLease: Awaited<ReturnType<typeof acquireTelegramPollingLease>> | undefined;
    let offset = 0;
    let consecutiveErrors = 0;
    const pollerStartTime = Math.floor(Date.now() / 1000);

    try {
      // Cross-process singleton lease; also cover acquisition with finally.
      pollingLease = await acquireTelegramPollingLease(token);
      if (signal?.aborted) return;
      logE2E("REMOTE-AGENT", `Starting envelope polling loop for group ${this.config.groupId}, museBotId: ${this.config.museBotId}`);
      // Step 1: Ensure webhooks are deleted before polling
      await this.deleteWebhook();

      // Step 2: Main polling loop with responsive real-time polling
      while (!signal?.aborted) {
        try {
          const url = `https://api.telegram.org/bot${token}/getUpdates?offset=${offset}&timeout=25&allowed_updates=${encodeURIComponent(
            JSON.stringify(["message", "edited_message"])
          )}`;

          // Bound each request and clean abort listeners after completion.
          const res = await fetchTelegramPoll(url, signal);

          if (res.status === 429) {
            const body = (await res.json().catch(() => ({}))) as any;
            const retryAfterSec = body?.parameters?.retry_after ?? 3;
            this.lastPollError = `Telegram getUpdates 429 rate limited (retry after ${retryAfterSec}s)`;
            logE2E("REMOTE-AGENT", `pollEnvelopes 429 rate limit. Waiting ${retryAfterSec}s`);
            await pollingDelay(retryAfterSec * 1000 + 500, signal);
            continue;
          }

          if (res.status === 409) {
            this.lastPollError = "Telegram getUpdates 409 Conflict: another poller or webhook owns this bot token.";
            logE2E("REMOTE-AGENT", `pollEnvelopes 409 Conflict (competing poller detected). Waiting 2000ms.`);
            await pollingDelay(2000, signal);
            continue;
          }

          if (!res.ok) {
            consecutiveErrors++;
            this.lastPollError = `Telegram getUpdates HTTP ${res.status}`;
            const backoffMs = Math.min(1000 * Math.pow(2, consecutiveErrors), 15000);
            logE2E("REMOTE-AGENT", `pollEnvelopes HTTP error ${res.status}. Backoff ${backoffMs}ms`);
            await pollingDelay(backoffMs, signal);
            continue;
          }

          const data = (await res.json()) as any;
          if (!data || !data.ok || !Array.isArray(data.result)) {
            consecutiveErrors++;
            const backoffMs = Math.min(1000 * Math.pow(2, consecutiveErrors), 15000);
            this.lastPollError = "Telegram getUpdates returned an invalid response.";
            logE2E("REMOTE-AGENT", `pollEnvelopes invalid response. Backoff ${backoffMs}ms`);
            await pollingDelay(backoffMs, signal);
            continue;
          }

          this.lastSuccessfulPollAt = Date.now();
          this.lastPollError = undefined;
          consecutiveErrors = 0; // Reset consecutive errors on success

          if (data.result.length === 0) {
            // Idle polling: small yield so fast responses or mocks don't spin the event loop
            await pollingDelay(50, signal);
            continue;
          }

          for (const update of data.result) {
            const updateId = update.update_id;
            if (typeof updateId === "number") {
              if (this.seenUpdateIds.has(updateId)) {
                offset = Math.max(offset, updateId + 1);
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

            const msg = update.message || update.edited_message;
            if (!msg || typeof msg.text !== "string") {
              if (typeof updateId === "number") offset = Math.max(offset, updateId + 1);
              continue;
            }

            // Skip stale historical updates sent before watch session started (>30s old)
            if (typeof msg.date === "number" && msg.date < pollerStartTime - 30) {
              logE2E("REMOTE-AGENT", `Update ${updateId} skipped: pre-dates watch session (date: ${msg.date}, started: ${pollerStartTime})`);
              if (typeof updateId === "number") offset = Math.max(offset, updateId + 1);
              continue;
            }

            const chatId = msg.chat?.id;
            const senderId = msg.from?.id;

            logE2E("REMOTE-AGENT", `Update ${updateId} from sender ${senderId} in chat ${chatId}`);

            // Rule 1: Ignore any message where message.chat.id != config.groupId
            if (this.config.groupId !== undefined && this.config.groupId !== "") {
              if (String(chatId) !== String(this.config.groupId)) {
                logE2E("REMOTE-AGENT", `Update ${updateId} ignored: chat ID ${chatId} != expected ${this.config.groupId}`);
                if (typeof updateId === "number") offset = Math.max(offset, updateId + 1);
                continue;
              }
            }

            // Determine if sender is authorized Muse Bot
            const isMuseSender =
              !this.config.museBotId ||
              String(senderId) === String(this.config.museBotId);

            // Feed chunk or message to reassembler
            let envelope = this.reassembler.processMessage(msg.text);

            // If not an envelope, handle plain text chat or operator commands
            if (!envelope) {
              const trimmed = msg.text.trim();
              const lower = trimmed.toLowerCase();
              const senderTag = msg.from?.username
                ? `@${msg.from.username}`
                : msg.from?.first_name || String(senderId);

              if (
                lower === "/cancel" ||
                lower === "/stop" ||
                lower === "cancel" ||
                lower === "stop" ||
                lower.startsWith("/cancel@") ||
                lower.startsWith("/stop@")
              ) {
                envelope = {
                  v: 1,
                  kind: "task_cancel",
                  task_id: "current",
                  reason: `Cancelled via Telegram by ${senderTag}`,
                };
              } else if (trimmed.length > 0) {
                const chatText = isMuseSender
                  ? trimmed
                  : `[Telegram Operator ${senderTag}]: ${trimmed}`;
                envelope = {
                  v: 1,
                  kind: "chat",
                  text: chatText,
                };
              }
            }

            if (!envelope) {
              logE2E("REMOTE-AGENT", `Update ${updateId}: message did not yield envelope (pending assembly or empty text)`);
              if (typeof updateId === "number") offset = Math.max(offset, updateId + 1);
              continue;
            }

            // Security: Only Muse bot is authorized to trigger task batches or completion
            if (
              (envelope.kind === "task_batch" || envelope.kind === "task_done" || envelope.kind === "result_ack") &&
              !isMuseSender
            ) {
              logE2E("REMOTE-AGENT", `Update ${updateId}: rejected unauthorized ${envelope.kind} from non-Muse sender ${senderId}`);
              console.warn(`[MuseClient] Rejected unauthorized ${envelope.kind} from sender ${senderId}`);
              if (typeof updateId === "number") offset = Math.max(offset, updateId + 1);
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
              if (typeof updateId === "number") offset = Math.max(offset, updateId + 1);
              continue;
            }

            logE2E("REMOTE-AGENT", `Processing received envelope: kind=${val.envelope!.kind}, id=${(val.envelope as any).id || (val.envelope as any).task_id}`);

            try {
              await onEnvelope(val.envelope!, { messageId: msg.message_id });
            } catch (handleErr: any) {
              const sanitized = this.sanitizeError(handleErr.message || String(handleErr));
              logE2E("REMOTE-AGENT", `Error in onEnvelope handler: ${sanitized}`);
              console.error(`[MuseClient] Error in onEnvelope handler: ${sanitized}`);
            } finally {
              // Advance offset only after processing (or skipping) this update,
              // so a crash mid-processing does not lose the message forever.
              if (typeof updateId === "number") {
                offset = Math.max(offset, updateId + 1);
              }
            }
          }
        } catch (err: any) {
          if (signal?.aborted) {
            logE2E("REMOTE-AGENT", "Polling loop stopped: signal aborted by user");
            break;
          }
          // Per-request timeout is expected for long-polling when no updates arrive
          if (err.name === "TimeoutError" || (err.name === "AbortError" && !signal?.aborted)) {
            consecutiveErrors = 0;
            // A mock or broken transport may fail immediately; never spin.
            await pollingDelay(100, signal);
            continue;
          }
          consecutiveErrors++;
          const backoffMs = Math.min(1000 * Math.pow(2, consecutiveErrors), 15000);
          const sanitized = this.sanitizeError(err.message || String(err));
          this.lastPollError = `Telegram getUpdates network error: ${sanitized}`;
          logE2E("REMOTE-AGENT", `Polling loop network error: ${sanitized}. Backoff ${backoffMs}ms`);
          await pollingDelay(backoffMs, signal);
        }
      }
    } finally {
      this.isPolling = false;
      await pollingLease?.release().catch(() => {});
      logE2E("REMOTE-AGENT", "Polling loop terminated");
    }
  }
}

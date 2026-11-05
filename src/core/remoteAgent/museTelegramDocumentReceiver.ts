/**
 * Muse-side Telegram document ingestion helper.
 *
 * Integrate this in the existing Telegram update owner. DO NOT start a second
 * getUpdates loop for the same bot: Bot API offsets are shared.
 * The Telegram sender's successful sendDocument is NOT proof of bot ingestion.
 */
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { FILE_TRANSFER_MAX_BYTES } from "./museFileTransfer.js";

export interface TelegramIncomingDocumentUpdate {
  message?: {
    message_id?: number;
    chat?: { id?: number | string };
    from?: { id?: number | string };
    document?: {
      file_id?: string;
      file_name?: string;
      file_size?: number;
      mime_type?: string;
    };
  };
}

export interface TelegramDocumentReceipt {
  chatId: string;
  messageId: number;
  fileId: string;
  name: string;
  size: number;
  sha256: string;
  savedPath: string;
}

export class MuseTelegramDocumentReceiver {
  constructor(private readonly options: {
    botToken: string;
    groupId: string;
    allowedSenderIds: Array<number | string>;
    directory: string;
    maxBytes?: number;
    /** Provide a mock only for tests. No user-controlled URL is accepted. */
    fetchImpl?: typeof fetch;
  }) {
    if (!options.botToken || !options.groupId ||
        !Array.isArray(options.allowedSenderIds) || !options.allowedSenderIds.length ||
        !path.isAbsolute(options.directory)) {
      throw new Error("Telegram ingestion requires bot token, group, trusted senders and absolute directory");
    }
  }

  /** Returns null for messages without a document; rejects unauthorized document updates. */
  async ingest(update: TelegramIncomingDocumentUpdate): Promise<TelegramDocumentReceipt | null> {
    const msg = update.message;
    const doc = msg?.document;
    if (!doc) return null;
    const maxBytes = Math.min(FILE_TRANSFER_MAX_BYTES, this.options.maxBytes ?? FILE_TRANSFER_MAX_BYTES);
    const chatId = String(msg?.chat?.id || "");
    const sender = String(msg?.from?.id || "");
    if (chatId !== this.options.groupId ||
        !this.options.allowedSenderIds.some(id => String(id) === sender)) {
      throw new Error("Telegram document sender or chat is not authorized");
    }
    if (!Number.isSafeInteger(msg?.message_id) || (msg!.message_id as number) < 0 ||
        typeof doc.file_id !== "string" || !doc.file_id ||
        doc.file_id.length > 256 ||
        doc.file_size !== undefined &&
          (!Number.isSafeInteger(doc.file_size) || doc.file_size < 0 || doc.file_size > maxBytes)) {
      throw new Error("Invalid Telegram document metadata or file size");
    }
    const name = doc.file_name || "document.bin";
    if (name.length > 180 || name === "." || name === ".." || /[/\\\x00-\x1f]/.test(name)) {
      throw new Error("Unsafe Telegram document filename");
    }
    const sanitized = name.replace(/[^\p{L}\p{N}._ -]/gu, "_");
    const safeId = createHash("sha256")
      .update(chatId + ":" + String(msg!.message_id) + ":" + doc.file_id)
      .digest("hex").slice(0, 32);
    const urlBase = "https://api.telegram.org/bot" + this.options.botToken;
    const fetchImpl = this.options.fetchImpl ?? fetch;

    const metadataRes = await fetchImpl(urlBase + "/getFile?file_id=" +
      encodeURIComponent(doc.file_id), { signal: AbortSignal.timeout(30_000) });
    if (!metadataRes.ok) throw new Error("Telegram getFile request failed");
    const metadata = await metadataRes.json() as any;
    if (!metadata?.ok || typeof metadata?.result?.file_path !== "string") {
      throw new Error("Telegram getFile returned no usable file path");
    }
    const filePath = metadata.result.file_path as string;
    const segments = filePath.split("/");
    if (!segments.length || segments.some(s => !s || s === "." || s === ".." ||
        !/^[A-Za-z0-9_.-]{1,180}$/.test(s))) {
      throw new Error("Unsafe Telegram file path");
    }
    const download = await fetchImpl("https://api.telegram.org/file/bot" +
      this.options.botToken + "/" + segments.map(encodeURIComponent).join("/"),
      { signal: AbortSignal.timeout(60_000) });
    if (!download.ok || !download.body) throw new Error("Telegram document download failed");

    const chunks: Buffer[] = [];
    let length = 0;
    const reader = download.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > maxBytes) {
          await reader.cancel();
          throw new Error("Telegram document exceeds configured maximum");
        }
        chunks.push(Buffer.from(value));
      }
    } finally { reader.releaseLock(); }
    if (doc.file_size !== undefined && doc.file_size !== length) {
      throw new Error("Telegram document size differs from downloaded bytes");
    }
    const bytes = Buffer.concat(chunks, length);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await fs.mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    const folder = await fs.lstat(this.options.directory);
    if (!folder.isDirectory() || folder.isSymbolicLink()) throw new Error("Unsafe receiving directory");
    const savedPath = path.join(this.options.directory, safeId + "-" + sanitized);
    try {
      const handle = await fs.open(savedPath, "wx", 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } catch (error) {
        await handle.close();
        await fs.rm(savedPath, { force: true });
        throw error;
      }
      await handle.close();
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      // Idempotent only when previously written bytes match, never overwrite.
      const existing = await fs.readFile(savedPath);
      if (!existing.equals(bytes)) throw new Error("Conflicting Telegram document at destination");
    }
    return {
      chatId, messageId: msg!.message_id!, fileId: doc.file_id,
      name, size: length, sha256, savedPath,
    };
  }
}

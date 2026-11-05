import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MuseTelegramDocumentReceiver } from "../src/core/remoteAgent/museTelegramDocumentReceiver.js";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "muse-telegram-ingest-"));
  const bytes = Buffer.from("sku,amount\n123,456\n");
  const update = {
    message: {
      message_id: 456,
      chat: { id: -10012345 },
      from: { id: 883311 },
      document: { file_id: "telegram-document-id", file_name: "sales.csv", file_size: bytes.length },
    },
  };
  const fetchImpl = vi.fn(async (url: string) => {
    if (url.includes("/getFile")) {
      return new Response(JSON.stringify({
        ok: true, result: { file_path: "documents/f_444.csv" },
      }), { status: 200 });
    }
    return new Response(bytes, { status: 200 });
  });
  const receiver = new MuseTelegramDocumentReceiver({
    botToken: "test-secret", groupId: "-10012345", allowedSenderIds: [883311],
    directory: path.join(root, "inbox"), fetchImpl: fetchImpl as any,
  });
  return { root, bytes, update, receiver, fetchImpl };
}

describe("Muse-side Telegram document ingestion helper", () => {
  it("downloads getFile bytes and durably persists SHA-256 verified CSV", async () => {
    const f = await fixture();
    try {
      const receipt = await f.receiver.ingest(f.update);
      expect(receipt?.name).toBe("sales.csv");
      expect(receipt?.sha256).toBe(createHash("sha256").update(f.bytes).digest("hex"));
      expect((await fs.readFile(receipt!.savedPath)).equals(f.bytes)).toBe(true);
      expect(f.fetchImpl).toHaveBeenCalledTimes(2);
      expect(f.fetchImpl.mock.calls[0][0]).toContain("/getFile");
      expect(f.fetchImpl.mock.calls[1][0]).toContain("/file/bottest-secret/documents/f_444.csv");
      const duplicate = await f.receiver.ingest(f.update);
      expect(duplicate?.savedPath).toBe(receipt?.savedPath);
    } finally { await fs.rm(f.root, { force: true, recursive: true }); }
  });

  it("rejects untrusted senders before any Telegram network request", async () => {
    const f = await fixture();
    try {
      await expect(f.receiver.ingest({
        ...f.update, message: { ...f.update.message, from: { id: 999 } },
      })).rejects.toThrow("not authorized");
      expect(f.fetchImpl).not.toHaveBeenCalled();
    } finally { await fs.rm(f.root, { force: true, recursive: true }); }
  });

  it("rejects traversal paths returned by getFile", async () => {
    const f = await fixture();
    try {
      const fake = vi.fn(async () => new Response(JSON.stringify({
        ok: true, result: { file_path: "../secrets.csv" },
      }), { status: 200 }));
      const receiver = new MuseTelegramDocumentReceiver({
        botToken: "token", groupId: "-10012345", allowedSenderIds: [883311],
        directory: path.join(f.root, "inbox"), fetchImpl: fake as any,
      });
      await expect(receiver.ingest(f.update)).rejects.toThrow("Unsafe Telegram file path");
      expect(fake).toHaveBeenCalledTimes(1);
    } finally { await fs.rm(f.root, { force: true, recursive: true }); }
  });

  it("rejects oversized or declared-size-mismatched Telegram uploads", async () => {
    const f = await fixture();
    try {
      await expect(f.receiver.ingest({
        ...f.update, message: {
          ...f.update.message,
          document: { ...f.update.message.document, file_size: 9 * 1024 * 1024 },
        },
      })).rejects.toThrow("Invalid Telegram document metadata or file size");
      await expect(f.receiver.ingest({
        ...f.update, message: {
          ...f.update.message,
          document: { ...f.update.message.document, file_size: 1 },
        },
      })).rejects.toThrow("size differs");
    } finally { await fs.rm(f.root, { force: true, recursive: true }); }
  });
});

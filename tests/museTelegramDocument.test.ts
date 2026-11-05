import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MuseClient } from "../src/core/remoteAgent/museClient.js";

const tempDirs: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const dir of tempDirs.splice(0)) await fs.rm(dir, { force: true, recursive: true });
});

describe("Telegram sendDocument real multipart attachment", () => {
  it("sends 0.5 MiB CSV with correct filename and bytes via sendDocument", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "telegram-document-"));
    tempDirs.push(dir);
    const file = path.join(dir, "sales.csv");
    const data = randomBytes(512 * 1024);
    await fs.writeFile(file, data);
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      urls.push(url);
      expect(init.method).toBe("POST");
      expect(init.headers).toBeUndefined(); // FormData owns multipart boundary.
      expect(init.body).toBeInstanceOf(FormData);
      const form = init.body as FormData;
      expect(form.get("chat_id")).toBe("-100456");
      expect(form.get("caption")).toBe("sample");
      const document = form.get("document") as File;
      expect(document.name).toBe("sales.csv");
      expect(document.type).toBe("text/csv");
      expect(Buffer.from(await document.arrayBuffer()).equals(data)).toBe(true);
      return new Response(JSON.stringify({
        ok: true, result: { message_id: 55, document: { file_id: "bot-document-id" } },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const client = new MuseClient({ botToken: "test-token", groupId: "-100456" });
    const receipt = await client.sendDocument("-100456", file, "sample");
    expect(receipt.messageId).toBe(55);
    expect(receipt.fileId).toBe("bot-document-id");
    expect(receipt.size).toBe(data.length);
    expect(receipt.sha256).toBe(createHash("sha256").update(data).digest("hex"));
    expect(urls).toEqual(["https://api.telegram.org/bottest-token/sendDocument"]);
  });

  it("preserves existing text sendMessage endpoint and envelope behavior", async () => {
    const endpoints: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      endpoints.push(url);
      const body = JSON.parse(init.body as string);
      expect(body.chat_id).toBe("-100456");
      expect(body.text).toBe("hello");
      return new Response(JSON.stringify({ ok: true, result: { message_id: 10 } }),
        { status: 200, headers: { "content-type": "application/json" } });
    }));
    const client = new MuseClient({ botToken: "test-token", groupId: "-100456" });
    expect(await client.sendMessage("-100456", "hello")).toBe(true);
    expect(endpoints).toEqual(["https://api.telegram.org/bottest-token/sendMessage"]);
  });

  it("does not retry ambiguous sendDocument network failures", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "telegram-document-"));
    tempDirs.push(dir);
    const file = path.join(dir, "sales.csv");
    await fs.writeFile(file, "a,b\n1,2\n");
    const request = vi.fn(async () => { throw new Error("connection reset"); });
    vi.stubGlobal("fetch", request);
    const client = new MuseClient({ botToken: "test-token", groupId: "-100456" });
    await expect(client.sendDocument("-100456", file)).rejects.toThrow("connection reset");
    expect(request).toHaveBeenCalledTimes(1);
  });
});

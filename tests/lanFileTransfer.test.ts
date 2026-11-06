import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { LanTargetFiles, decodeLanChunk, safeLanFilename, sha256File,
  LAN_FILE_CHUNK_BYTES, LAN_FILE_MAX_BYTES } from "../src/core/lanRemote/fileTransfer.js";
import { parseTrayLanAction } from "../src/core/runtime/trayLanBridge.js";

let directory: string;
beforeEach(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), "superagent-lan-file-")); });
afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });
const handle = "a0b1c2d3-1234-4abc-9f00-aabbccddeeff";
const digest = (bytes: Buffer) => crypto.createHash("sha256").update(bytes).digest("hex");

describe("LAN target file transfer: isolated safe contract", () => {
  it("uploads chunks, rejects partial save, verifies SHA-256 and writes unique file", async () => {
    const bytes = crypto.randomBytes(21_137);
    const target = new LanTargetFiles(path.join(directory, "received"));
    const offer = target.offer("upload", { name: "report.pdf", size: bytes.length, sha256: digest(bytes) });
    expect(offer.chunkBytes).toBe(4096);
    expect(await fs.readdir(directory)).toEqual([]);
    for (let seq = 0, offset = 0; offset < bytes.length; seq++, offset += LAN_FILE_CHUNK_BYTES) {
      const chunk = bytes.subarray(offset, offset + LAN_FILE_CHUNK_BYTES);
      const ack = target.put(offer.transferId, seq, chunk.toString("base64"));
      expect(ack.received).toBe(Math.min(offset + LAN_FILE_CHUNK_BYTES, bytes.length));
    }
    const committed = await target.finish(offer.transferId);
    expect(committed.ok).toBe(true);
    const final = (committed as { savedTo: string }).savedTo;
    expect(final).toContain(path.join(directory, "received"));
    expect(final.endsWith("-report.pdf")).toBe(true);
    expect(await fs.readFile(final)).toEqual(bytes);
    await expect(target.finish(offer.transferId)).rejects.toThrow("Unknown transfer");
  });

  it("downloads only the target owner's explicitly selected file, one chunk at a time", async () => {
    const target = new LanTargetFiles(directory);
    expect(() => target.offer("download")).toThrow("select");
    const bytes = crypto.randomBytes(14_890);
    const source = path.join(directory, "owner-document.txt");
    await fs.writeFile(source, bytes);
    expect(await target.shareSelectedFile(source)).toEqual({ name: "owner-document.txt", size: bytes.length });
    const offer = target.offer("download");
    expect(offer.sha256).toBe(digest(bytes));
    expect(() => target.get(offer.transferId, 2)).toThrow("Out-of-order");
    let rebuilt = Buffer.alloc(0);
    for (let seq = 0; rebuilt.length < bytes.length; seq++) {
      const item = target.get(offer.transferId, seq);
      rebuilt = Buffer.concat([rebuilt, decodeLanChunk(item.data)]);
    }
    expect(rebuilt).toEqual(bytes);
    expect(await target.finish(offer.transferId)).toMatchObject({ ok: true, name: "owner-document.txt", bytes: bytes.length });
  });

  it("rejects malformed names, encoded chunks, oversize files, incorrect sequence and hash", async () => {
    for (const name of ["../secret", "..", ".env", "a/b.txt", "a\\b.txt", "x:cmd", "line\nbreak",
      "long".repeat(30), "ending.", "space "])
      expect(() => safeLanFilename(name)).toThrow();
    for (const data of ["", "!", "QU JD", "a".repeat(5465), "Zm9v==", "AA=", "A" ])
      expect(() => decodeLanChunk(data)).toThrow();
    const target = new LanTargetFiles(directory);
    expect(() => target.offer("upload", {
      name: "too-large.bin", size: LAN_FILE_MAX_BYTES + 1, sha256: "a".repeat(64),
    })).toThrow();
    const source = Buffer.from("hello");
    const offer = target.offer("upload", { name: "hello.txt", size: source.length, sha256: "0".repeat(64) });
    expect(() => target.put(offer.transferId, 1, source.toString("base64"))).toThrow("Out-of-order");
    expect(() => target.offer("upload", { name: "other.txt", size: 1, sha256: "0".repeat(64) })).toThrow("Another");
    target.put(offer.transferId, 0, source.toString("base64"));
    await expect(target.finish(offer.transferId)).rejects.toThrow("SHA-256");
    expect((await fs.readdir(directory))).toEqual([]);
    target.abort(offer.transferId);
    expect(() => target.put(offer.transferId, 1, "AA==")).toThrow("Unknown");
  });

  it("enforces a narrow on-device export selection and transfer reset", async () => {
    const source = path.join(directory, "note.txt");
    await fs.writeFile(source, "safe");
    const target = new LanTargetFiles(directory);
    await target.shareSelectedFile(source);
    const first = target.offer("download");
    target.clear();
    expect(target.getShared()).toBeNull();
    expect(() => target.get(first.transferId, 0)).toThrow();
    expect(() => target.offer("download")).toThrow();
  });
});

describe("Core LAN file action parser blocks unchecked paths and payloads", () => {
  const offer = { action: "file_offer", deviceId: handle, direction: "upload",
    name: "report.pdf", size: 128, sha256: "f".repeat(64) };
  it("accepts upload/download metadata and ordered chunk actions", () => {
    expect(parseTrayLanAction(offer).action).toBe("file_offer");
    expect(parseTrayLanAction({ action: "file_offer", deviceId: handle, direction: "download" }).action)
      .toBe("file_offer");
    for (const action of ["file_get", "file_put", "file_finish", "file_abort"]) {
      const body = { action, deviceId: handle, transferId: handle,
        ...(action === "file_get" || action === "file_put" ? { seq: 0 } : {}),
        ...(action === "file_put" ? { data: "AA==" } : {}) };
      expect(parseTrayLanAction(body).action).toBe(action);
    }
  });
  it("rejects raw local paths, huge chunks, extra file enumeration fields and wrong digest", () => {
    for (const changes of [
      { name: "../report.pdf" }, { name: "sub/report.pdf" },
      { size: 0 }, { size: LAN_FILE_MAX_BYTES + 1 },
      { sha256: "a" }, { localPath: "C:\\Users\\target\\secret.txt" },
      { overwrite: true }, { direction: "download", name: "sensitive.txt" },
    ]) expect(() => parseTrayLanAction({ ...offer, ...changes })).toThrow();
    for (const body of [
      { action: "file_put", deviceId: handle, transferId: handle, seq: 0, data: "A".repeat(5600) },
      { action: "file_put", deviceId: handle, transferId: handle, seq: -1, data: "AA==" },
      { action: "file_get", deviceId: handle, transferId: handle, seq: 1025 },
      { action: "file_abort", deviceId: handle, transferId: "../escape" },
      { action: "file_finish", deviceId: handle, transferId: handle, saveTo: "C:\\" },
    ]) expect(() => parseTrayLanAction(body)).toThrow();
  });
  it("documents 4 KiB chunks and 4 MiB per file", () => {
    expect(LAN_FILE_CHUNK_BYTES).toBe(4096);
    expect(LAN_FILE_MAX_BYTES).toBe(4194304);
    expect(sha256File(Buffer.from("hi"))).toBe(digest(Buffer.from("hi")));
  });
});

import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import os from "node:os";
import { lanInterfaces, startLanServer, type LanServerHandle } from "../src/core/lanRemote/transport.js";
import {
  pairLanDevice, openLanSession, offerLanFile, putLanFileChunk, getLanFileChunk,
  finalizeLanFile, closeLanSession, revokeLanDevice, abortLanFile,
} from "../src/core/lanRemote/controller.js";

describe("Real on-link TLS, owner-consented bidirectional file exchange", () => {
  let server: LanServerHandle | null = null;
  let temp: string | null = null;
  afterEach(async () => {
    if (server) { await server.close(); server = null; }
    if (temp) { await fs.rm(temp, { recursive: true, force: true }); temp = null; }
  });
  const adapter = lanInterfaces()[0];
  const runIfAvailable = adapter ? it : it.skip;
  runIfAvailable("denies unapproved file, sends then receives fixtures with identical SHA-256", async () => {
    temp = await fs.mkdtemp(path.join(os.tmpdir(), "superagent-lan-file-e2e-"));
    const receivedDir = path.join(temp, "target-received");
    const bytes = crypto.randomBytes(12_345);
    const hash = crypto.createHash("sha256").update(bytes).digest("hex");
    const shared = path.join(temp, "owner-shared.txt");
    await fs.writeFile(shared, bytes);
    let filesAllowed = false;
    const kinds: string[] = [];
    server = await startLanServer({
      segmentName: "test-lan",
      host: adapter.address, port: 0, code: "12345678", transferDirectory: receivedDir,
      onApproval: async (request) => {
        kinds.push(request.kind);
        return request.kind === "pair" || request.kind === "session" || filesAllowed;
      },
    });
    await server.shareSelectedFile(shared);
    const device = await pairLanDevice({
      host: adapter.address, port: server.port, code: "12345678",
      fingerprint: server.fingerprint, controller: "Isolated File Test",
    });
    await openLanSession(device.id);
    await expect(offerLanFile(device.id, "upload", {
      name: "report.pdf", size: bytes.length, sha256: hash,
    })).rejects.toThrow(/offer|denied|not approved/i);
    expect(await fs.readdir(temp)).toEqual(["owner-shared.txt"]);
    filesAllowed = true;

    const upload = await offerLanFile(device.id, "upload",
      { name: "report.pdf", size: bytes.length, sha256: hash });
    expect(upload.size).toBe(bytes.length);
    for (let seq = 0, offset = 0; offset < bytes.length; offset += 4096, seq++) {
      const portion = bytes.subarray(offset, offset + 4096).toString("base64");
      const receipt = await putLanFileChunk(device.id, upload.transferId, seq, portion);
      expect(receipt.received).toBe(Math.min(offset + 4096, bytes.length));
    }
    expect((await finalizeLanFile(device.id, upload.transferId)).bytes).toBe(bytes.length);
    const [saved] = await fs.readdir(receivedDir);
    expect(saved.endsWith("-report.pdf")).toBe(true);
    expect(await fs.readFile(path.join(receivedDir, saved))).toEqual(bytes);

    const download = await offerLanFile(device.id, "download");
    expect(download).toMatchObject({ name: "owner-shared.txt", size: bytes.length, sha256: hash });
    let rebuilt = Buffer.alloc(0);
    for (let seq = 0; rebuilt.length < download.size; seq++) {
      const chunk = await getLanFileChunk(device.id, download.transferId, seq);
      rebuilt = Buffer.concat([rebuilt, Buffer.from(chunk.data, "base64")]);
    }
    expect(rebuilt).toEqual(bytes);
    expect(crypto.createHash("sha256").update(rebuilt).digest("hex")).toBe(hash);
    expect((await finalizeLanFile(device.id, download.transferId)).ok).toBe(true);
    const cancel = await offerLanFile(device.id, "download");
    await abortLanFile(device.id, cancel.transferId);
    await expect(getLanFileChunk(device.id, cancel.transferId, 0)).rejects.toThrow();
    await closeLanSession(device.id);
    await revokeLanDevice(device.id);
    expect(kinds).toContain("file-upload");
    expect(kinds).toContain("file-download");
  }, 55_000);
  runIfAvailable("rejects a different source file selected while owner approval is pending", async () => {
    temp = await fs.mkdtemp(path.join(os.tmpdir(), "superagent-lan-switch-"));
    const one = path.join(temp, "original.txt");
    const two = path.join(temp, "replacement.txt");
    await fs.writeFile(one, "owner-selected-A");
    await fs.writeFile(two, "owner-selected-B");
    server = await startLanServer({
      segmentName: "test-lan",
      host: adapter.address, port: 0, code: "12345678", transferDirectory: path.join(temp, "unused"),
      onApproval: async (request) => {
        if (request.kind === "file-download") {
          await server!.shareSelectedFile(two);
          return true;
        }
        return true;
      },
    });
    await server.shareSelectedFile(one);
    const device = await pairLanDevice({ host: adapter.address, port: server.port,
      code: "12345678", fingerprint: server.fingerprint, controller: "Switch test" });
    await openLanSession(device.id);
    await expect(offerLanFile(device.id, "download")).rejects.toThrow();
    await closeLanSession(device.id);
    await revokeLanDevice(device.id);
    expect((await fs.readdir(temp)).sort()).toEqual(["original.txt", "replacement.txt"]);
  }, 30_000);
});

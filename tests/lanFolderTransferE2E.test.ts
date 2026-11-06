import { afterEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startLanServer, lanInterfaces, type LanServerHandle } from "../src/core/lanRemote/transport.js";
import {
  pairLanDevice, openLanSession, offerLanFile, putLanFileChunk, getLanFileChunk,
  finalizeLanFile, abortLanFile, closeLanSession, revokeLanDevice,
} from "../src/core/lanRemote/controller.js";
import { inspectFolderPackage, packFolder } from "../src/core/lanRemote/folderPackage.js";

describe("LAN folder two-way real TLS E2E (isolated local fixtures only)", () => {
  let server: LanServerHandle | null = null;
  let sandbox: string | null = null;
  afterEach(async () => {
    if (server) { await server.close(); server = null; }
    if (sandbox) { await fs.rm(sandbox, { recursive: true, force: true }); sandbox = null; }
  });
  const physical = lanInterfaces()[0];
  const maybeIt = physical ? it : it.skip;
  maybeIt("physically approved target shares and receives nested folder, hashes, blocked traversal", async () => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "sa-lan-folder-e2e-"));
    const outbound = path.join(sandbox, "photos");
    const targetReceived = path.join(sandbox, "target-rec");
    await fs.mkdir(path.join(outbound, "reports"), { recursive: true });
    await fs.writeFile(path.join(outbound, "reports", "A.txt"), "Alpha");
    await fs.writeFile(path.join(outbound, "B.txt"), "Beta");
    const approved: string[] = [];
    server = await startLanServer({
      host: physical.address, port: 0, segmentName: "team-lab",
      transferDirectory: targetReceived, code: "12345678",
      onApproval: async ({ kind }) => { approved.push(kind); return true; },
    });
    const chosen = await server.shareSelectedFolder(outbound);
    expect(chosen).toMatchObject({ name: "photos.safolder", files: 2 });
    const client = await pairLanDevice({ host: physical.address, port: server.port,
      fingerprint: server.fingerprint, code: "12345678", controller: "Folder Fixture" });
    await openLanSession(client.id);
    const download = await offerLanFile(client.id, "download");
    expect(download).toMatchObject({ name: chosen.name, size: chosen.size });
    const received: Buffer[] = [];
    for (let seq = 0, offset = 0; offset < download.size; seq++, offset += 4096) {
      const part = await getLanFileChunk(client.id, download.transferId, seq);
      received.push(Buffer.from(part.data, "base64"));
    }
    const archive = Buffer.concat(received);
    expect(crypto.createHash("sha256").update(archive).digest("hex")).toBe(download.sha256);
    expect(inspectFolderPackage(archive).files.map((item) => item.path)).toEqual(["B.txt", "reports/A.txt"]);
    expect((await finalizeLanFile(client.id, download.transferId)).bytes).toBe(archive.length);

    const uploaded = await packFolder(outbound);
    const digest = crypto.createHash("sha256").update(uploaded).digest("hex");
    const upload = await offerLanFile(client.id, "upload", {
      name: "photos.safolder", size: uploaded.length, sha256: digest,
    });
    for (let seq = 0, offset = 0; offset < uploaded.length; seq++, offset += 4096) {
      const part = uploaded.subarray(offset, offset + 4096);
      const receipt = await putLanFileChunk(client.id, upload.transferId, seq, part.toString("base64"));
      expect(receipt.received).toBe(Math.min(uploaded.length, offset + part.length));
    }
    const imported = await finalizeLanFile(client.id, upload.transferId);
    expect(imported.ok).toBe(true);
    expect(imported.savedTo).toContain("SuperAgent-LAN-");
    expect(await fs.readFile(path.join(imported.savedTo, "B.txt"), "utf8")).toBe("Beta");
    expect(await fs.readFile(path.join(imported.savedTo, "reports", "A.txt"), "utf8")).toBe("Alpha");
    expect(approved.filter((kind) => kind === "file-upload" || kind === "file-download")).toHaveLength(2);

    // Malicious manifest has a valid whole-package digest but MUST fail
    // because a nested file attempts to escape the chosen output directory.
    const manifest = Buffer.from(JSON.stringify({ version: 1, files: [{
      path: "../outside.txt", size: 1, sha256: crypto.createHash("sha256").update("x").digest("hex"),
    }] }), "utf8");
    const header = Buffer.alloc(13);
    header.write("SAFOLDER1", 0, "ascii");
    header.writeUInt32BE(manifest.length, 9);
    const malicious = Buffer.concat([header, manifest, Buffer.from("x")]);
    const offer = await offerLanFile(client.id, "upload", { name: "unsafe.safolder",
      size: malicious.length, sha256: crypto.createHash("sha256").update(malicious).digest("hex") });
    await putLanFileChunk(client.id, offer.transferId, 0, malicious.toString("base64"));
    await expect(finalizeLanFile(client.id, offer.transferId)).rejects.toThrow();
    await abortLanFile(client.id, offer.transferId);
    expect(await fs.readdir(targetReceived)).toHaveLength(1);
    await closeLanSession(client.id);
    await revokeLanDevice(client.id);
  }, 55_000);
});

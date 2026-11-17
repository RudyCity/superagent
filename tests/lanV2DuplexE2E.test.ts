import { afterEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { lanInterfaces, startLanServer, type LanServerHandle } from "../src/core/lanRemote/transport.js";
import {
  pairLanDevice, openLanSession, closeLanSession, revokeLanDevice,
  offerLanFileV2Source, offerLanFileV2, getLanFileChunkV2,
  putLanFileChunkV2, getLanFileStatusV2, finalizeLanFileV2Source,
  finalizeLanFileV2,
} from "../src/core/lanRemote/controller.js";

describe("V2 two-owner encrypted source and destination interoperability", () => {
  const servers: LanServerHandle[] = [];
  const handles: string[] = [];
  const roots: string[] = [];
  afterEach(async () => {
    for (const id of handles.splice(0)) {
      try { await closeLanSession(id); } catch { /* ephemeral session may have closed */ }
      try { await revokeLanDevice(id); } catch { /* ephemeral pairing may be gone */ }
    }
    for (const s of servers.splice(0)) await s.close();
    for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
  });
  const adapter = lanInterfaces()[0];
  const testOnPhysical = adapter ? it : it.skip;
  testOnPhysical("copies an owner-selected >4MiB Windows file between two physical-LAN TLS endpoints", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "superagent-lan-v2-tls-"));
    roots.push(root);
    const file = path.join(root, "owner.bin");
    const output = path.join(root, "receiver");
    const selected = crypto.randomBytes(4 * 1024 * 1024 + 37);
    await fs.writeFile(file, selected);
    const sha256 = crypto.createHash("sha256").update(selected).digest("hex");
    const pair = async (role: "sender" | "receiver", targetFolder: string) => {
      const server = await startLanServer({
        segmentName: "v2-two-party", host: adapter.address, port: 0,
        transferDirectory: targetFolder, code: role === "sender" ? "12345678" : "87654321",
        onApproval: async () => true,
      });
      servers.push(server);
      const device = await pairLanDevice({
        host: adapter.address, port: server.port,
        code: role === "sender" ? "12345678" : "87654321",
        fingerprint: server.fingerprint, controller: "V2 TLS test controller",
      });
      handles.push(device.id);
      await openLanSession(device.id);
      return { server, device };
    };
    const from = await pair("sender", path.join(root, "sender-output"));
    const to = await pair("receiver", output);
    await from.server.shareSelectedLargeFile(file);
    const offered = await offerLanFileV2Source(from.device.id);
    expect(offered).toMatchObject({ name: "owner.bin", size: selected.length,
      sha256, chunkBytes: 16 * 1024 });
    const target = await offerLanFileV2(to.device.id, {
      name: offered.name, size: offered.size, sha256: offered.sha256,
    });
    expect(target.received).toBe(0);
    for (let offset = 0, seq = 0; offset < offered.size; seq++) {
      const chunk = await getLanFileChunkV2(from.device.id, offered.transferId, seq);
      const receipt = await putLanFileChunkV2(to.device.id, target.transferId, seq, chunk.data);
      offset += Buffer.from(chunk.data, "base64").length;
      expect(receipt).toEqual({ received: offset, seq: seq + 1 });
      if (seq === 1) {
        expect(await getLanFileStatusV2(to.device.id, target.transferId))
          .toMatchObject({ direction: "upload", received: offset, seq: seq + 1 });
        const reread = await getLanFileChunkV2(from.device.id, offered.transferId, seq);
        expect(reread).toEqual(chunk);
      }
    }
    expect((await finalizeLanFileV2Source(from.device.id, offered.transferId)).bytes)
      .toBe(selected.length);
    const done = await finalizeLanFileV2(to.device.id, target.transferId);
    expect(done.bytes).toBe(selected.length);
    const actual = await fs.readFile(done.savedTo);
    expect(actual).toEqual(selected);
    expect(crypto.createHash("sha256").update(actual).digest("hex")).toBe(sha256);
  }, 120_000);
});

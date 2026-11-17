import { afterEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { lanInterfaces, startLanServer, type LanServerHandle } from "../src/core/lanRemote/transport.js";
import {
  pairLanDevice, openLanSession, offerLanFile, putLanFileChunk,
  getLanFileStatus, finalizeLanFile, closeLanSession, revokeLanDevice,
} from "../src/core/lanRemote/controller.js";

describe("LAN authenticated read-only transfer checkpoint", () => {
  let server: LanServerHandle | null = null;
  let folder: string | null = null;
  afterEach(async () => {
    if (server) { await server.close(); server = null; }
    if (folder) { await fs.rm(folder, { recursive: true, force: true }); folder = null; }
  });
  const adapter = lanInterfaces()[0];
  const onLink = adapter ? it : it.skip;
  onLink("checking progress does not cancel an active approved transfer", async () => {
    folder = await fs.mkdtemp(path.join(os.tmpdir(), "superagent-lan-status-"));
    server = await startLanServer({
      segmentName: "test-lan", host: adapter.address, port: 0,
      transferDirectory: folder, code: "12345678",
      onApproval: async () => true,
    });
    const paired = await pairLanDevice({
      host: adapter.address, port: server.port, code: "12345678",
      fingerprint: server.fingerprint, controller: "Checkpoint Regression",
    });
    await openLanSession(paired.id);
    const bytes = Buffer.from("owner-approved-status-does-not-cancel");
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    const offer = await offerLanFile(paired.id, "upload", {
      name: "report.txt", size: bytes.length, sha256,
    });
    expect(await getLanFileStatus(paired.id, offer.transferId))
      .toMatchObject({ direction: "upload", size: bytes.length, sha256, seq: 0, received: 0 });
    expect(server.state().transfer?.status).toBe("active");
    const receipt = await putLanFileChunk(paired.id, offer.transferId, 0, bytes.toString("base64"));
    expect(receipt.received).toBe(bytes.length);
    expect(await getLanFileStatus(paired.id, offer.transferId))
      .toMatchObject({ direction: "upload", seq: 1, received: bytes.length });
    expect(server.state().transfer?.status).toBe("active");
    expect((await finalizeLanFile(paired.id, offer.transferId)).bytes).toBe(bytes.length);
    expect(server.state().transfer?.status).toBe("completed");
    await closeLanSession(paired.id);
    await revokeLanDevice(paired.id);
  }, 50_000);
});

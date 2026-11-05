import { describe, expect, it } from "vitest";
import { randomBytes, createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { MuseWsClientTransport, MuseWsServerTransport } from "../src/core/remoteAgent/museWsTransport.js";
import { FileTransferSender, type FileAckEnvelope } from "../src/core/remoteAgent/museFileTransfer.js";

async function choosePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>(resolve => s.listen(0, "127.0.0.1", resolve));
  const addr = s.address();
  if (!addr || typeof addr === "string") throw Error("No port");
  await new Promise<void>(resolve => s.close(() => resolve()));
  return addr.port;
}

describe("MuseWsClientTransport opt-in durable receiver (real authenticated socket)", () => {
  it("Muse receives a 6 MiB CSV, persists it, verifies SHA-256, and acknowledges SuperAgent", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "muse-peer-e2e-"));
    const source = path.join(root, "sales.csv");
    const directory = path.join(root, "muse-inbox");
    const bytes = randomBytes(6 * 1024 * 1024);
    await fs.writeFile(source, bytes);
    const port = await choosePort();
    const token = "muse-file-e2e-token";
    const server = new MuseWsServerTransport({
      wsHost: "127.0.0.1", wsPort: port, wsPath: "/muse", wsToken: token,
    } as any);
    const client = new MuseWsClientTransport({
      wsRemoteUrl: "ws://127.0.0.1:" + port + "/muse", wsToken: token,
    } as any, undefined, { directory });
    let sender!: FileTransferSender;
    try {
      await server.start(async (envelope, meta) => {
        if (envelope.kind === "file_ack" && meta?.transport === "websocket") {
          sender.handleAck(envelope as FileAckEnvelope);
        }
      });
      sender = new FileTransferSender(async (frame) => server.sendEnvelope(frame), 2500, 2);
      await client.start(async () => {});
      expect(client.isConnected()).toBe(true);
      const receipt = await sender.sendFile(source);
      expect(receipt.chunks).toBe(96);
      const data = await fs.readFile(path.join(directory, receipt.transferId + "-sales.csv"));
      expect(data.equals(bytes)).toBe(true);
      expect(createHash("sha256").update(data).digest("hex")).toBe(receipt.sha256);
    } finally {
      await client.stop();
      await server.stop();
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 30000);
});

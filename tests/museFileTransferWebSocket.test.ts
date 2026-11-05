import { describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { MuseWsServerTransport } from "../src/core/remoteAgent/museWsTransport.js";
import {
  FileTransferReceiver, FileTransferSender,
  type FileAckEnvelope, type FileOfferEnvelope, type FileChunkEnvelope, type FileCompleteEnvelope,
} from "../src/core/remoteAgent/museFileTransfer.js";

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing local port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

describe("actual authenticated Muse WebSocket file transfer", () => {
  it.each([512 * 1024, 6 * 1024 * 1024])("transfers %i bytes over authenticated WebSocket and reconstructs the file", async (size) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "muse-ws-file-"));
    const input = path.join(root, "sample.csv");
    const bytes = randomBytes(size);
    await fs.writeFile(input, bytes);
    const receiver = new FileTransferReceiver(path.join(root, "destination"));
    const port = await unusedPort();
    const transport = new MuseWsServerTransport({
      wsHost: "127.0.0.1", wsPort: port, wsPath: "/muse", wsToken: "file-transfer-test-token",
    } as any);
    let sender!: FileTransferSender;
    let client: WebSocket | null = null;
    try {
      await transport.start(async (envelope, meta) => {
        if (envelope.kind === "file_ack" && meta?.transport === "websocket") {
          sender.handleAck(envelope as FileAckEnvelope);
        }
      });
      sender = new FileTransferSender(async (frame) => transport.sendEnvelope(frame), 1_000, 3);
      client = new WebSocket("ws://127.0.0.1:" + port + "/muse", {
        headers: { Authorization: "Bearer file-transfer-test-token" },
      });
      await new Promise<void>((resolve, reject) => {
        client!.once("open", resolve);
        client!.once("error", reject);
      });
      const peer = client;
      peer.on("message", async (wire) => {
        const envelope = JSON.parse(wire.toString()) as
          FileOfferEnvelope | FileChunkEnvelope | FileCompleteEnvelope;
        if (!["file_offer", "file_chunk", "file_complete"].includes(envelope.kind)) return;
        const ack = await receiver.receive(envelope);
        peer.send(JSON.stringify(ack));
      });
      const sent = await sender.sendFile(input);
      expect(sent.size).toBe(bytes.length);
      const received = receiver.getReceipt(sent.transferId);
      expect(received).not.toBeNull();
      expect(received?.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
      expect((await fs.readFile(received!.savedPath)).equals(bytes)).toBe(true);
    } finally {
      client?.close();
      await transport.stop();
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 15_000);
});

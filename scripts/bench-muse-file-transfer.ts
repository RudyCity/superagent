/**
 * Local-only benchmark. No public tunnel, Telegram traffic, or user documents.
 * Usage: bun scripts/bench-muse-file-transfer.ts
 */
import { performance } from "node:perf_hooks";
import { randomBytes, createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileTransferSender, type FileAckEnvelope } from "../src/core/remoteAgent/museFileTransfer.js";
import { DurableMuseFileReceiver } from "../src/core/remoteAgent/museFileReceiverPersistent.js";

const sizes = [512 * 1024, 6 * 1024 * 1024];
const root = await fs.mkdtemp(path.join(os.tmpdir(), "superagent-file-benchmark-"));
try {
  for (const size of sizes) {
    const source = path.join(root, "sample-" + size + ".csv");
    const inbox = path.join(root, "inbox-" + size);
    const bytes = randomBytes(size);
    await fs.writeFile(source, bytes);
    const receiver = new DurableMuseFileReceiver(inbox);
    let sender!: FileTransferSender;
    const rssBefore = process.memoryUsage().rss;
    let peakRss = rssBefore;
    let peakHeap = process.memoryUsage().heapUsed;
    const sample = () => {
      const used = process.memoryUsage();
      peakRss = Math.max(peakRss, used.rss);
      peakHeap = Math.max(peakHeap, used.heapUsed);
    };
    sender = new FileTransferSender(async (frame) => {
      const ack = await receiver.receive(frame as any);
      sample();
      queueMicrotask(() => sender.handleAck(ack as FileAckEnvelope));
      return true;
    }, 5000, 3);
    const start = performance.now();
    const result = await sender.sendFile(source, { onProgress: sample });
    const durationSec = (performance.now() - start) / 1000;
    const receipt = await receiver.getReceipt(result.transferId);
    if (!receipt || receipt.sha256 !== result.sha256) throw Error("Benchmark digest mismatch");
    const saved = await fs.readFile(receipt.savedPath);
    if (!saved.equals(bytes)) throw Error("Benchmark bytes mismatch");
    console.log(JSON.stringify({
      bytes: size, chunks: result.chunks,
      durationSeconds: Math.round(durationSec * 1000) / 1000,
      throughputMiBps: Math.round((size / 1048576 / durationSec) * 100) / 100,
      rssStartMiB: Math.round(rssBefore / 1048576 * 100) / 100,
      peakRssMiB: Math.round(peakRss / 1048576 * 100) / 100,
      peakHeapMiB: Math.round(peakHeap / 1048576 * 100) / 100,
      sha256Verified: true,
      transport: "local in-process sender + durable filesystem receiver",
    }));
  }
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

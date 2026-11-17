import crypto from "node:crypto";
import path from "node:path";
import os from "node:os";
import {
  listLanDevices, offerLanFileV2Source, getLanFileChunkV2,
  getLanFileStatusV2, finalizeLanFileV2Source, abortLanFileV2,
} from "./controller.js";
import { LanDiskTargetV2, LAN_V2_CHUNK_BYTES, LAN_V2_MAX_BYTES } from "./streamTransferV2.js";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const JOB_TTL = 70 * 60_000;
type Status = "awaiting-approval" | "transferring" | "verifying" | "completed" | "cancelled" | "failed";
type Job = {
  id: string; deviceId: string; status: Status; name: string | null; size: number;
  received: number; started: number; updated: number; cancel: boolean;
  error: string | null; saved: boolean;
  sourceId: string | null; targetId: string | null;
};
type Api = {
  list: typeof listLanDevices;
  offer: typeof offerLanFileV2Source;
  get: typeof getLanFileChunkV2;
  status: typeof getLanFileStatusV2;
  finish: typeof finalizeLanFileV2Source;
  abort: typeof abortLanFileV2;
};
export class LanLargeFileReceiveManager {
  private readonly jobs = new Map<string, Job>();
  private active: string | null = null;
  constructor(private readonly api: Api,
    private readonly disk = new LanDiskTargetV2(
      path.join(os.homedir(), "Downloads", "SuperAgent LAN", "Received")),
    private readonly now = Date.now) {}

  private read(id: string) {
    if (typeof id !== "string" || !UUID.test(id)) throw Error("Invalid V2 receive job ID.");
    const job = this.jobs.get(id);
    if (!job || this.now() - job.updated > JOB_TTL) throw Error("V2 receive job expired.");
    return job;
  }
  status(id: string) {
    const job = this.read(id);
    return {
      id: job.id, deviceId: job.deviceId, name: job.name,
      size: job.size, received: job.received, status: job.status,
      error: job.error, saved: job.saved, started: job.started, updated: job.updated,
      speedBytesPerSecond: Math.floor(job.received / Math.max(1, (this.now() - job.started) / 1000)),
    };
  }
  start(deviceId: string) {
    if (typeof deviceId !== "string" || !UUID.test(deviceId))
      throw Error("Invalid approved source device ID.");
    const source = this.api.list().find(x => x.id === deviceId);
    if (!source?.connected || !["windows", "android"].includes(source.platform))
      throw Error("Connect an updated owner-approved Android/Windows source first.");
    if (this.active) throw Error("Another large-file receive is running.");
    const now = this.now();
    for (const [id, job] of this.jobs) {
      if (now - job.updated > JOB_TTL) this.jobs.delete(id);
    }
    const id = crypto.randomUUID();
    const job: Job = {
      id, deviceId, status: "awaiting-approval", name: null,
      size: 0, received: 0, started: now, updated: now,
      cancel: false, saved: false, error: null, sourceId: null, targetId: null,
    };
    this.jobs.set(id, job);
    this.active = id;
    void this.execute(job);
    return this.status(id);
  }
  cancel(id: string) {
    const job = this.read(id);
    if (["completed", "failed", "cancelled"].includes(job.status)) return this.status(id);
    job.cancel = true;
    job.updated = this.now();
    return this.status(id);
  }
  private check(job: Job) {
    if (job.cancel) throw Error("Local owner cancelled large receive.");
  }
  private async execute(job: Job) {
    let targetId: string | null = null;
    let sourceId: string | null = null;
    let commitCompleted = false;
    try {
      this.check(job);
      // Source owner explicitly selects the document in the Android picker
      // or Windows share-large command. Each offer requests a new approval.
      const offer = await this.api.offer(job.deviceId);
      sourceId = offer.transferId;
      job.sourceId = sourceId;
      this.check(job);
      if (!offer.name || offer.size <= 4 * 1024 * 1024 ||
          offer.size > LAN_V2_MAX_BYTES || offer.chunkBytes !== LAN_V2_CHUNK_BYTES ||
          !/^[a-f0-9]{64}$/.test(offer.sha256))
        throw Error("Invalid owner-approved source V2 metadata.");
      job.size = offer.size;
      job.name = offer.name;
      const destination = await this.disk.offerUpload(offer.name, offer.size, offer.sha256);
      targetId = destination.transferId;
      job.targetId = targetId;
      const restored = destination.received;
      job.status = "transferring";
      job.updated = this.now();
      // All source bytes are streamed and hashed, including already persisted
      // prefix chunks. Skip committing them to the receiver disk a second time.
      const checksum = crypto.createHash("sha256");
      for (let offset = 0, seq = 0; offset < offer.size; seq++) {
        this.check(job);
        let chunk;
        try {
          chunk = await this.api.get(job.deviceId, offer.transferId, seq);
        } catch (error) {
          const status = await this.api.status(job.deviceId, offer.transferId);
          if (status.transferId !== offer.transferId ||
              status.name !== offer.name || status.sha256 !== offer.sha256 ||
              status.size !== offer.size ||
              (status.seq !== seq && status.seq !== seq + 1))
            throw error;
          chunk = await this.api.get(job.deviceId, offer.transferId, seq);
        }
        this.check(job);
        const part = Buffer.from(chunk.data, "base64");
        if (!part.length || part.length > LAN_V2_CHUNK_BYTES ||
            part.toString("base64") !== chunk.data ||
            offset + part.length !== chunk.received ||
            offset + part.length > offer.size ||
            (part.length !== LAN_V2_CHUNK_BYTES && offset + part.length !== offer.size))
          throw Error("Malformed V2 source data or sequence.");
        checksum.update(part);
        if (offset >= restored) {
          const ack = await this.disk.put(targetId, seq, chunk.data);
          if (ack.received !== offset + part.length || ack.seq !== seq + 1)
            throw Error("Local V2 disk acknowledgement mismatch.");
        } else if (offset + part.length > restored) {
          throw Error("Local restored checkpoint is not chunk-aligned.");
        }
        offset += part.length;
        job.received = offset;
        job.updated = this.now();
      }
      job.status = "verifying";
      this.check(job);
      if (checksum.digest("hex") !== offer.sha256)
        throw Error("Remote source SHA-256 mismatch.");
      await this.api.finish(job.deviceId, offer.transferId);
      this.check(job);
      const saved = await this.disk.finish(targetId);
      commitCompleted = true;
      if (!saved.ok || saved.bytes !== offer.size)
        throw Error("Local verified file commit was not acknowledged.");
      job.saved = true;
      job.status = "completed";
      job.updated = this.now();
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error);
      const network = /timeout|network|connection|econn|reset|tls/i.test(message);
      job.status = job.cancel ? "cancelled" : "failed";
      job.error = job.cancel ? "Owner cancelled; inspect final destination before retry." :
        "Receive unverified: " + message.slice(0, 190) +
        (network ? ". Partial bytes retained for fresh owner-approved retry." :
          ". Inspect source before retry.");
      job.updated = this.now();
      if (!commitCompleted) {
        if (network && !job.cancel) this.disk.suspend();
        else if (targetId) await this.disk.abort(targetId);
      }
    } finally {
      if (sourceId && !commitCompleted) {
        try { await this.api.abort(job.deviceId, sourceId); }
        catch { /* Current pairing may have been revoked; no unattended replay. */ }
      }
      if (this.active === job.id) this.active = null;
    }
  }
}
export const lanLargeFileReceiveManager = new LanLargeFileReceiveManager({
  list: listLanDevices, offer: offerLanFileV2Source, get: getLanFileChunkV2,
  status: getLanFileStatusV2, finish: finalizeLanFileV2Source, abort: abortLanFileV2,
});

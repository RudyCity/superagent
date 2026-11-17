import crypto from "node:crypto";
import {
  listLanDevices, offerLanFile, getLanFileChunk, getLanFileStatus,
  putLanFileChunk, finalizeLanFile, abortLanFile,
  offerLanFileV2, offerLanFileV2Source, getLanFileChunkV2, getLanFileStatusV2,
  putLanFileChunkV2, finalizeLanFileV2, finalizeLanFileV2Source, abortLanFileV2,
} from "./controller.js";

const MAX_BYTES = 4 * 1024 * 1024;
const CHUNK = 4096;
const MAX_JOB_AGE = 70 * 60_000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

type JobStatus = "awaiting-approval" | "transferring" | "verifying" | "completed" | "cancelled" | "failed";
interface RelayJob {
  id: string;
  protocol: "v1" | "v2";
  retainDestination: boolean;
  sourceId: string;
  destinationId: string;
  name: string | null;
  size: number;
  transferred: number;
  startedAt: number;
  updatedAt: number;
  status: JobStatus;
  error: string | null;
  cancelRequested: boolean;
  committed: boolean;
  sourceTransferId: string | null;
  destinationTransferId: string | null;
}

type RelayApi = {
  list: typeof listLanDevices;
  offer: typeof offerLanFile;
  get: typeof getLanFileChunk;
  status: typeof getLanFileStatus;
  put: typeof putLanFileChunk;
  finish: typeof finalizeLanFile;
  abort: typeof abortLanFile;
  offerV2Source?: typeof offerLanFileV2Source;
  offerV2Upload?: typeof offerLanFileV2;
  getV2?: typeof getLanFileChunkV2;
  statusV2?: typeof getLanFileStatusV2;
  putV2?: typeof putLanFileChunkV2;
  finishV2Upload?: typeof finalizeLanFileV2;
  finishV2Source?: typeof finalizeLanFileV2Source;
  abortV2?: typeof abortLanFileV2;
};

export class LanFileRelayManager {
  private readonly jobs = new Map<string, RelayJob>();
  constructor(private readonly api: RelayApi, private readonly now = Date.now) {}

  private read(id: string) {
    if (typeof id !== "string" || !UUID.test(id)) throw Error("Invalid relay job handle.");
    const job = this.jobs.get(id);
    if (!job || this.now() - job.updatedAt > MAX_JOB_AGE) throw Error("Relay job expired.");
    return job;
  }

  private check(job: RelayJob) {
    if (job.cancelRequested) throw Error("Relay cancelled by local owner.");
  }

  status(id: string) {
    const job = this.read(id);
    // No pairing/session credentials or file contents are exposed.
    return {
      id: job.id, protocol: job.protocol,
      sourceId: job.sourceId, destinationId: job.destinationId,
      name: job.name, size: job.size, transferred: job.transferred,
      status: job.status, error: job.error,
      startedAt: job.startedAt, updatedAt: job.updatedAt,
      speedBytesPerSecond: Math.floor(job.transferred /
        Math.max(1, (this.now() - job.startedAt) / 1000)),
    };
  }

  start(sourceId: string, destinationId: string, protocol: "v1" | "v2" = "v1") {
    if (protocol !== "v1" && protocol !== "v2") throw Error("Invalid relay protocol.");
    if (!UUID.test(sourceId) || !UUID.test(destinationId) || sourceId === destinationId)
      throw Error("Select two different approved and connected LAN devices.");
    const devices = this.api.list();
    const source = devices.find((d) => d.id === sourceId);
    const destination = devices.find((d) => d.id === destinationId);
    if (!source?.connected || !destination?.connected)
      throw Error("Both endpoints require active, owner-approved support sessions.");
    if (protocol === "v2" && (source.platform !== "windows" ||
        !["windows", "android"].includes(destination.platform) ||
        !this.api.offerV2Source || !this.api.offerV2Upload || !this.api.getV2 ||
        !this.api.statusV2 || !this.api.putV2 || !this.api.finishV2Source ||
        !this.api.finishV2Upload || !this.api.abortV2))
      throw Error("V2 relay requires an updated Windows source and Windows/Android destination.");
    if ((source.transport || "lan") !== (destination.transport || "lan"))
      throw Error("Cross-route relay is disabled; pair both devices on the same verified route.");
    for (const existing of this.jobs.values()) {
      if (["awaiting-approval", "transferring", "verifying"].includes(existing.status))
        throw Error("Another LAN relay is active; finish or cancel it first.");
    }
    for (const [id, previous] of this.jobs) {
      if (this.now() - previous.updatedAt > MAX_JOB_AGE) this.jobs.delete(id);
    }
    const id = crypto.randomUUID();
    const job: RelayJob = {
      id, protocol, retainDestination: false, sourceId, destinationId,
      name: null, size: 0, transferred: 0,
      startedAt: this.now(), updatedAt: this.now(), status: "awaiting-approval",
      error: null, cancelRequested: false, committed: false,
      sourceTransferId: null, destinationTransferId: null,
    };
    this.jobs.set(id, job);
    void this.run(job);
    return this.status(id);
  }

  cancel(id: string) {
    const job = this.read(id);
    if (job.status === "completed" || job.status === "failed" || job.status === "cancelled")
      return this.status(id);
    job.cancelRequested = true;
    job.updatedAt = this.now();
    // Cancellation is asynchronous because an on-device approval or commit
    // may be in flight. The final receipt is authoritative.
    return this.status(id);
  }

  private async run(job: RelayJob) {
    const v2 = job.protocol === "v2";
    const chunkBytes = v2 ? 16 * 1024 : CHUNK;
    let sourceDigest = "";
    try {
      this.check(job);
      // A fresh owner approval is required on the SOURCE; no filesystem
      // selector or arbitrary source path is ever accepted from the network.
      const source = v2
        ? await this.api.offerV2Source!(job.sourceId)
        : await this.api.offer(job.sourceId, "download");
      job.sourceTransferId = source.transferId;
      this.check(job);
      const maxBytes = v2 ? 256 * 1024 * 1024 : MAX_BYTES;
      if (source.size < (v2 ? MAX_BYTES + 1 : 1) ||
          source.size > maxBytes || source.chunkBytes !== chunkBytes ||
          !/^[a-f0-9]{64}$/.test(source.sha256))
        throw Error("Source did not produce an approved verified relay offer.");
      job.name = source.name;
      job.size = source.size;
      sourceDigest = source.sha256;
      // The destination independently approves the identical filename,
      // size and hash. A restored V2 target checkpoint is revalidated.
      const destination = v2
        ? await this.api.offerV2Upload!(job.destinationId, {
            name: source.name, size: source.size, sha256: source.sha256,
          })
        : await this.api.offer(job.destinationId, "upload", {
            name: source.name, size: source.size, sha256: source.sha256,
          });
      job.destinationTransferId = destination.transferId;
      this.check(job);
      if (destination.name !== source.name || destination.size !== source.size ||
          destination.sha256 !== source.sha256 || destination.chunkBytes !== chunkBytes)
        throw Error("Approved relay destination metadata differs from source.");
      const existing = v2 ? (destination as { received: number }).received : 0;
      if (!Number.isSafeInteger(existing) || existing < 0 || existing > source.size ||
          existing % chunkBytes !== 0 && existing !== source.size)
        throw Error("Invalid V2 target resume boundary.");
      job.status = "transferring";
      job.updatedAt = this.now();

      const checksum = crypto.createHash("sha256");
      for (let offset = 0, seq = 0; offset < source.size; seq++) {
        this.check(job);
        let chunk;
        try {
          chunk = v2
            ? await this.api.getV2!(job.sourceId, source.transferId, seq)
            : await this.api.get(job.sourceId, source.transferId, seq);
        } catch (error) {
          const remote = v2
            ? await this.api.statusV2!(job.sourceId, source.transferId)
            : await this.api.status(job.sourceId, source.transferId);
          if (remote.transferId !== source.transferId || remote.sha256 !== source.sha256 ||
              remote.name !== source.name || remote.size !== source.size ||
              (remote.seq !== seq && remote.seq !== seq + 1))
            throw error;
          chunk = v2
            ? await this.api.getV2!(job.sourceId, source.transferId, seq)
            : await this.api.get(job.sourceId, source.transferId, seq);
        }
        this.check(job);
        const bytes = Buffer.from(chunk.data, "base64");
        if (!bytes.length || bytes.length > chunkBytes ||
            chunk.received !== offset + bytes.length ||
            offset + bytes.length > source.size ||
            (bytes.length !== chunkBytes && offset + bytes.length !== source.size) ||
            bytes.toString("base64") !== chunk.data)
          throw Error("Invalid authenticated source chunk.");
        checksum.update(bytes);
        if (offset >= existing) {
          let ack;
          try {
            ack = v2
              ? await this.api.putV2!(job.destinationId, destination.transferId, seq, chunk.data)
              : await this.api.put(job.destinationId, destination.transferId, seq, chunk.data);
          } catch (error) {
            // Never replay a potentially committed write.
            const checkpoint = v2
              ? await this.api.statusV2!(job.destinationId, destination.transferId)
              : await this.api.status(job.destinationId, destination.transferId);
            if (checkpoint.transferId !== destination.transferId ||
                checkpoint.sha256 !== source.sha256 || checkpoint.name !== source.name ||
                checkpoint.size !== source.size || checkpoint.seq !== seq + 1 ||
                checkpoint.received !== offset + bytes.length)
              throw error;
            ack = { received: checkpoint.received, seq: checkpoint.seq };
          }
          if (ack.seq !== seq + 1 || ack.received !== offset + bytes.length)
            throw Error("Target returned an inconsistent relay checkpoint.");
        } else if (offset + bytes.length > existing) {
          throw Error("Target restored an unaligned partial file.");
        }
        offset += bytes.length;
        job.transferred = offset;
        job.updatedAt = this.now();
      }
      this.check(job);
      job.status = "verifying";
      if (checksum.digest("hex") !== sourceDigest)
        throw Error("Source content differed from owner-selected SHA-256.");
      if (v2) await this.api.finishV2Source!(job.sourceId, source.transferId);
      else await this.api.finish(job.sourceId, source.transferId);
      this.check(job);
      const saved = v2
        ? await this.api.finishV2Upload!(job.destinationId, destination.transferId)
        : await this.api.finish(job.destinationId, destination.transferId);
      if (!saved.ok || saved.bytes !== source.size)
        throw Error("Destination did not confirm verified final commit.");
      job.committed = true;
      job.status = "completed";
      job.updatedAt = this.now();
    } catch (error) {
      const cancelled = job.cancelRequested;
      const message = String(error instanceof Error ? error.message : error);
      // An uncertain V2 NETWORK error must not delete a recoverable target
      // partial. A later restart/reapproval matches SHA-256 before resuming.
      // Explicit owner cancel and integrity failures do discard partial bytes.
      job.retainDestination = v2 && !cancelled &&
        /timeout|timed out|network|connection|tls|econn|reset/i.test(message);
      job.status = cancelled ? "cancelled" : "failed";
      job.error = cancelled
        ? "Relay cancelled; inspect the target if final commit had already started."
        : "Relay not verified: " + message.slice(0, 170) +
          (job.retainDestination ? ". V2 checkpoint retained for reapproved retry." :
            ". Inspect the target before retrying.");
      job.updatedAt = this.now();
    } finally {
      if (!job.committed) {
        const sourceAbort = job.sourceTransferId
          ? v2 ? this.api.abortV2!(job.sourceId, job.sourceTransferId)
            : this.api.abort(job.sourceId, job.sourceTransferId)
          : Promise.resolve();
        const destinationAbort = job.destinationTransferId && !job.retainDestination
          ? v2 ? this.api.abortV2!(job.destinationId, job.destinationTransferId)
            : this.api.abort(job.destinationId, job.destinationTransferId)
          : Promise.resolve();
        await Promise.allSettled([sourceAbort, destinationAbort]);
      }
    }
  }

}

export const lanFileRelayManager = new LanFileRelayManager({
  list: listLanDevices, offer: offerLanFile, get: getLanFileChunk,
  status: getLanFileStatus, put: putLanFileChunk, finish: finalizeLanFile, abort: abortLanFile,
  offerV2Source: offerLanFileV2Source, offerV2Upload: offerLanFileV2,
  getV2: getLanFileChunkV2, statusV2: getLanFileStatusV2, putV2: putLanFileChunkV2,
  finishV2Source: finalizeLanFileV2Source, finishV2Upload: finalizeLanFileV2,
  abortV2: abortLanFileV2,
});

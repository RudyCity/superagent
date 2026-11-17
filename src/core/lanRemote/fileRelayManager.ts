import crypto from "node:crypto";
import {
  listLanDevices, offerLanFile, getLanFileChunk, getLanFileStatus,
  putLanFileChunk, finalizeLanFile, abortLanFile,
} from "./controller.js";

const MAX_BYTES = 4 * 1024 * 1024;
const CHUNK = 4096;
const MAX_JOB_AGE = 10 * 60_000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

type JobStatus = "awaiting-approval" | "transferring" | "verifying" | "completed" | "cancelled" | "failed";
interface RelayJob {
  id: string;
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
};

export class LanFileRelayManager {
  private readonly jobs = new Map<string, RelayJob>();
  constructor(private readonly api: RelayApi, private readonly now = Date.now) {}

  private read(id: string) {
    if (typeof id !== "string" || !UUID.test(id)) throw Error("Invalid relay job handle.");
    const job = this.jobs.get(id);
    if (!job || this.now() - job.startedAt > MAX_JOB_AGE) throw Error("Relay job expired.");
    return job;
  }

  private check(job: RelayJob) {
    if (job.cancelRequested) throw Error("Relay cancelled by local owner.");
  }

  status(id: string) {
    const job = this.read(id);
    // No pairing/session credentials or file contents are exposed.
    return {
      id: job.id, sourceId: job.sourceId, destinationId: job.destinationId,
      name: job.name, size: job.size, transferred: job.transferred,
      status: job.status, error: job.error,
      startedAt: job.startedAt, updatedAt: job.updatedAt,
      speedBytesPerSecond: Math.floor(job.transferred /
        Math.max(1, (this.now() - job.startedAt) / 1000)),
    };
  }

  start(sourceId: string, destinationId: string) {
    if (!UUID.test(sourceId) || !UUID.test(destinationId) || sourceId === destinationId)
      throw Error("Select two different approved and connected LAN devices.");
    const devices = this.api.list();
    const source = devices.find((d) => d.id === sourceId);
    const destination = devices.find((d) => d.id === destinationId);
    if (!source?.connected || !destination?.connected)
      throw Error("Both endpoints require active, owner-approved support sessions.");
    if ((source.transport || "lan") !== (destination.transport || "lan"))
      throw Error("Cross-route relay is disabled; pair both devices on the same verified route.");
    for (const existing of this.jobs.values()) {
      if (["awaiting-approval", "transferring", "verifying"].includes(existing.status))
        throw Error("Another LAN relay is active; finish or cancel it first.");
    }
    for (const [id, previous] of this.jobs) {
      if (this.now() - previous.startedAt > MAX_JOB_AGE) this.jobs.delete(id);
    }
    const id = crypto.randomUUID();
    const job: RelayJob = {
      id, sourceId, destinationId, name: null, size: 0, transferred: 0,
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
    try {
      this.check(job);
      // Source must be explicitly selected on its device; this operation
      // invokes a new physical permission prompt on that endpoint.
      const source = await this.api.offer(job.sourceId, "download");
      job.sourceTransferId = source.transferId;
      this.check(job);
      if (source.size < 1 || source.size > MAX_BYTES || source.chunkBytes !== CHUNK ||
          !/^[a-f0-9]{64}$/.test(source.sha256))
        throw Error("Source does not support bounded, verified V1 relay.");

      job.name = source.name;
      job.size = source.size;
      // Destination separately approves receipt of this exact basename,
      // length and hash. Its filesystem paths are never chosen remotely.
      const destination = await this.api.offer(job.destinationId, "upload", {
        name: source.name, size: source.size, sha256: source.sha256,
      });
      job.destinationTransferId = destination.transferId;
      this.check(job);
      if (destination.name !== source.name || destination.size !== source.size ||
          destination.sha256 !== source.sha256 || destination.chunkBytes !== CHUNK)
        throw Error("Relay destination metadata differs from the approved source.");
      job.status = "transferring";
      job.updatedAt = this.now();

      const checksum = crypto.createHash("sha256");
      for (let offset = 0, seq = 0; offset < source.size; seq++) {
        this.check(job);
        let chunk;
        try {
          chunk = await this.api.get(job.sourceId, source.transferId, seq);
        } catch (error) {
          const remote = await this.api.status(job.sourceId, source.transferId);
          if (remote.transferId !== source.transferId || remote.sha256 !== source.sha256 ||
              remote.name !== source.name || remote.size !== source.size ||
              (remote.seq !== seq && remote.seq !== seq + 1))
            throw error;
          chunk = await this.api.get(job.sourceId, source.transferId, seq);
        }
        this.check(job);
        const bytes = Buffer.from(chunk.data, "base64");
        if (!bytes.length || bytes.length > CHUNK || chunk.received !== offset + bytes.length ||
            offset + bytes.length > source.size ||
            (bytes.length !== CHUNK && offset + bytes.length !== source.size) ||
            bytes.toString("base64") !== chunk.data)
          throw Error("Invalid authenticated source chunk.");
        checksum.update(bytes);
        let ack;
        try {
          ack = await this.api.put(job.destinationId, destination.transferId, seq, chunk.data);
        } catch (error) {
          // Never replay an uncertain write. The target's read-only
          // checkpoint proves whether it has already accepted this chunk.
          const checkpoint = await this.api.status(job.destinationId, destination.transferId);
          if (checkpoint.transferId !== destination.transferId ||
              checkpoint.sha256 !== source.sha256 || checkpoint.name !== source.name ||
              checkpoint.size !== source.size || checkpoint.seq !== seq + 1 ||
              checkpoint.received !== offset + bytes.length)
            throw error;
          ack = { received: checkpoint.received, seq: checkpoint.seq };
        }
        if (ack.seq !== seq + 1 || ack.received !== offset + bytes.length)
          throw Error("Target returned an inconsistent relay checkpoint.");
        offset += bytes.length;
        job.transferred = offset;
        job.updatedAt = this.now();
      }
      this.check(job);
      job.status = "verifying";
      if (checksum.digest("hex") !== source.sha256)
        throw Error("Source content differed from owner-selected SHA-256.");
      // Keep both endpoints alive until the target verifies its own final hash.
      await this.api.finish(job.sourceId, source.transferId);
      this.check(job);
      const saved = await this.api.finish(job.destinationId, destination.transferId);
      if (!saved.ok || saved.bytes !== source.size)
        throw Error("Destination did not confirm the verified commit.");
      job.committed = true;
      job.status = "completed";
      job.updatedAt = this.now();
    } catch (error) {
      const cancelled = job.cancelRequested;
      job.status = cancelled ? "cancelled" : "failed";
      job.error = cancelled
        ? "Transfer cancelled; verify target if its final commit had already started."
        : "Relay not verified: " + String(error instanceof Error ? error.message : error).slice(0, 190) +
          ". Inspect the target before retrying.";
      job.updatedAt = this.now();
    } finally {
      if (!job.committed) {
        // Clean up each endpoint independently and never claim a remote
        // outcome was undone if a commit had already completed.
        await Promise.allSettled([
          job.sourceTransferId ? this.api.abort(job.sourceId, job.sourceTransferId) : Promise.resolve(),
          job.destinationTransferId ? this.api.abort(job.destinationId, job.destinationTransferId) : Promise.resolve(),
        ]);
      }
    }
  }
}

export const lanFileRelayManager = new LanFileRelayManager({
  list: listLanDevices, offer: offerLanFile, get: getLanFileChunk,
  status: getLanFileStatus, put: putLanFileChunk, finish: finalizeLanFile, abort: abortLanFile,
});

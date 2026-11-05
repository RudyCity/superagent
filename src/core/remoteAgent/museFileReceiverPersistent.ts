/**
 * Opt-in, crash-tolerant receive side for Muse's authenticated WebSocket peer.
 *
 * State is persisted outside the workspace, in a private destination directory.
 * Incoming frames may only be accepted AFTER transport authentication.
 * This does not start a second Telegram getUpdates poller or alter Muse chat.
 */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";

import {
  FILE_TRANSFER_CHUNK_BYTES, FILE_TRANSFER_MAX_BYTES, validateFileTransferEnvelope,
  type FileOfferEnvelope, type FileChunkEnvelope, type FileCompleteEnvelope,
  type FileAckEnvelope, type FileReceivedReceipt,
} from "./museFileTransfer.js";

interface PersistedState {
  version: 1;
  offer: FileOfferEnvelope;
  nextIndex: number;
  bytes: number;
  updatedAt: number;
  status: "receiving" | "completed";
  receipt?: FileReceivedReceipt;
}
export interface DurableReceiverOptions {
  maxConcurrent?: number;
  maxStorageBytes?: number;
  expireAfterMs?: number;
  onComplete?: (receipt: FileReceivedReceipt) => void | Promise<void>;
}
type FileFrame = FileOfferEnvelope | FileChunkEnvelope | FileCompleteEnvelope;

const SAFE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class DurableMuseFileReceiver {
  private lock = Promise.resolve();
  private readonly expireAfterMs: number;
  private readonly maxConcurrent: number;
  private readonly maxStorageBytes: number;
  constructor(private readonly directory: string, private readonly options: DurableReceiverOptions = {}) {
    if (!path.isAbsolute(directory)) throw new Error("Receiver directory must be absolute");
    this.expireAfterMs = options.expireAfterMs ?? 24 * 60 * 60_000;
    this.maxConcurrent = options.maxConcurrent ?? 4;
    this.maxStorageBytes = options.maxStorageBytes ?? 256 * 1024 * 1024;
  }

  private filePaths(id: string, name: string) {
    if (!SAFE_ID.test(id)) throw new Error("Invalid transfer UUID");
    const safeName = name.replace(/[^\p{L}\p{N}._ -]/gu, "_");
    if (!safeName || safeName === "." || safeName === "..") throw new Error("Invalid filename");
    return {
      part: path.join(this.directory, "." + id + ".part"),
      state: path.join(this.directory, "." + id + ".state.json"),
      final: path.join(this.directory, id + "-" + safeName),
    };
  }

  private async ensureDirectory() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Receiver directory must be a real directory");
  }

  private async writeState(file: string, data: PersistedState) {
    const tmp = file + "." + randomUUID() + ".tmp";
    try {
      await fs.writeFile(tmp, JSON.stringify(data), { flag: "wx", mode: 0o600 });
      const handle = await fs.open(tmp, "r+");
      try { await handle.sync(); } finally { await handle.close(); }
      await fs.rename(tmp, file);
    } finally {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
    }
  }

  private async readState(file: string): Promise<PersistedState | null> {
    try {
      const raw = await fs.readFile(file, "utf8");
      const state = JSON.parse(raw) as PersistedState;
      if (state.version !== 1 || state.status !== "receiving" && state.status !== "completed" ||
          validateFileTransferEnvelope(state.offer) ||
          !Number.isSafeInteger(state.nextIndex) || state.nextIndex < 0 ||
          state.nextIndex > state.offer.total_chunks ||
          state.bytes !== Math.min(state.offer.size, state.nextIndex * FILE_TRANSFER_CHUNK_BYTES)) {
        throw new Error("Corrupt receiver checkpoint");
      }
      return state;
    } catch (error: any) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  private ack(frame: FileFrame, phase: FileAckEnvelope["phase"], ok: boolean,
    error?: string, index?: number, nextIndex?: number): FileAckEnvelope {
    return {
      v: 1, kind: "file_ack", id: randomUUID(), transfer_id: frame.transfer_id,
      phase, ok,
      ...(error ? { error: error.slice(0, 500) } : {}),
      ...(index === undefined ? {} : { index }),
      ...(nextIndex === undefined ? {} : { next_index: nextIndex }),
    };
  }

  private async diskState() {
    const files = await fs.readdir(this.directory);
    let reserved = 0;
    let active = 0;
    for (const name of files) {
      if (!name.startsWith(".") || !name.endsWith(".state.json")) continue;
      const state = await this.readState(path.join(this.directory, name)).catch(() => null);
      if (!state) continue;
      if (state.status === "receiving") active++;
      reserved += state.offer.size;
    }
    return { active, reserved };
  }

  /** Remove abandoned partials, retaining completed receipts until explicit retention expiry. */
  public async prune(): Promise<number> {
    await this.ensureDirectory();
    let removed = 0;
    const now = Date.now();
    const names = await fs.readdir(this.directory);
    for (const name of names) {
      if (!/^\.[0-9a-f-]{36}\.state\.json$/i.test(name)) continue;
      const id = name.slice(1, -".state.json".length);
      if (!SAFE_ID.test(id)) continue;
      const stateFile = path.join(this.directory, name);
      const state = await this.readState(stateFile).catch(() => null);
      if (!state) continue;
      if (now - state.updatedAt < this.expireAfterMs) continue;
      const paths = this.filePaths(id, state.offer.name);
      if (state.status === "receiving") {
        await fs.rm(paths.part, { force: true });
      } else {
        await fs.rm(paths.final, { force: true });
      }
      await fs.rm(paths.state, { force: true });
      removed++;
    }
    return removed;
  }

  private async digestFile(file: string): Promise<string> {
    const hash = createHash("sha256");
    const input = createReadStream(file);
    for await (const chunk of input) hash.update(chunk);
    return hash.digest("hex");
  }

  private async actualReceive(frame: FileFrame): Promise<FileAckEnvelope> {
    const phase = frame.kind === "file_offer" ? "offer" : frame.kind === "file_chunk" ? "chunk" : "complete";
    const index = frame.kind === "file_chunk" ? frame.index : undefined;
    const error = validateFileTransferEnvelope(frame);
    if (error) return this.ack(frame, phase, false, error, index);
    try {
      await this.ensureDirectory();
      const offer = frame.kind === "file_offer" ? frame : null;
      const statePath = path.join(this.directory, "." + frame.transfer_id + ".state.json");
      let state = await this.readState(statePath);
      if (offer) {
        if (state) {
          const existing = state.offer;
          if (existing.name !== offer.name || existing.sha256 !== offer.sha256 ||
              existing.size !== offer.size || existing.total_chunks !== offer.total_chunks) {
            return this.ack(frame, phase, false, "Transfer ID collision");
          }
          const paths = this.filePaths(frame.transfer_id, existing.name);
          if (state.status === "completed") {
            const stat = await fs.stat(paths.final).catch(() => null);
            if (!stat || stat.size !== existing.size ||
                await this.digestFile(paths.final) !== existing.sha256) {
              return this.ack(frame, phase, false, "Completed receipt missing or corrupted");
            }
            return this.ack(frame, phase, true, undefined, undefined, existing.total_chunks);
          }
          const part = await fs.stat(paths.part).catch(() => null);
          if (!part || part.size < state.bytes) {
            // Recover a crash between final rename and manifest commit only after
            // independently verifying the final file.
            const finalStat = await fs.stat(paths.final).catch(() => null);
            if (finalStat && finalStat.size === existing.size &&
                await this.digestFile(paths.final) === existing.sha256) {
              const receipt: FileReceivedReceipt = {
                transferId: frame.transfer_id, name: existing.name,
                size: existing.size, sha256: existing.sha256,
                chunks: existing.total_chunks, savedPath: paths.final,
              };
              state.status = "completed";
              state.receipt = receipt;
              state.nextIndex = existing.total_chunks;
              state.bytes = existing.size;
              state.updatedAt = Date.now();
              await this.writeState(statePath, state);
              return this.ack(frame, phase, true, undefined, undefined, existing.total_chunks);
            }
            return this.ack(frame, phase, false, "Partial file missing or truncated");
          }
          if (part.size > state.bytes) await fs.truncate(paths.part, state.bytes);
          state.updatedAt = Date.now();
          await this.writeState(statePath, state);
          return this.ack(frame, phase, true, undefined, undefined, state.nextIndex);
        }
        await this.prune();
        const { active, reserved } = await this.diskState();
        if (active >= this.maxConcurrent || reserved + offer.size > this.maxStorageBytes) {
          return this.ack(frame, phase, false, "Receiver quota reached");
        }
        const p = this.filePaths(frame.transfer_id, offer.name);
        const fh = await fs.open(p.part, "wx", 0o600);
        await fh.close();
        state = { version: 1, offer, nextIndex: 0, bytes: 0, updatedAt: Date.now(), status: "receiving" };
        await this.writeState(p.state, state);
        return this.ack(frame, phase, true, undefined, undefined, 0);
      }

      if (!state) return this.ack(frame, phase, false, "Unknown or expired transfer", index);
      const p = this.filePaths(frame.transfer_id, state.offer.name);
      if (state.status === "completed") {
        const stat = await fs.stat(p.final).catch(() => null);
        if (!stat || stat.size !== state.offer.size) return this.ack(frame, phase, false, "Completed file missing", index);
        if (frame.kind === "file_complete") return this.ack(frame, phase, true);
        if (frame.kind === "file_chunk" && frame.index < state.offer.total_chunks) {
          const bytes = Buffer.from(frame.data_base64, "base64");
          const fh = await fs.open(p.final, "r");
          try {
            const check = Buffer.alloc(bytes.length);
            const { bytesRead } = await fh.read(check, 0, bytes.length, frame.offset);
            if (bytesRead === bytes.length && check.equals(bytes)) return this.ack(frame, phase, true, undefined, frame.index);
          } finally { await fh.close(); }
        }
        return this.ack(frame, phase, false, "Completed chunk conflict", index);
      }
      if (frame.kind === "file_chunk") {
        const chunk = Buffer.from(frame.data_base64, "base64");
        const expected = Math.min(FILE_TRANSFER_CHUNK_BYTES, state.offer.size - frame.offset);
        if (frame.offset !== frame.index * FILE_TRANSFER_CHUNK_BYTES ||
            frame.index >= state.offer.total_chunks ||
            chunk.length !== expected || chunk.toString("base64") !== frame.data_base64) {
          return this.ack(frame, phase, false, "Invalid chunk offset or canonical encoding", index);
        }
        if (frame.index < state.nextIndex) {
          const fh = await fs.open(p.part, "r");
          try {
            const check = Buffer.alloc(chunk.length);
            const { bytesRead } = await fh.read(check, 0, chunk.length, frame.offset);
            return this.ack(frame, phase, bytesRead === chunk.length && check.equals(chunk),
              bytesRead === chunk.length && check.equals(chunk) ? undefined : "Duplicate chunk mismatch", index);
          } finally { await fh.close(); }
        }
        if (frame.index !== state.nextIndex) return this.ack(frame, phase, false, "Out-of-order chunk", index);
        const handle = await fs.open(p.part, "r+");
        try {
          await handle.write(chunk, 0, chunk.length, state.bytes);
          await handle.sync();
        } finally { await handle.close(); }
        state.bytes += chunk.length;
        state.nextIndex++;
        state.updatedAt = Date.now();
        await this.writeState(p.state, state);
        return this.ack(frame, phase, true, undefined, index);
      }
      if (state.nextIndex !== state.offer.total_chunks || state.bytes !== state.offer.size) {
        return this.ack(frame, phase, false, "Incomplete transfer");
      }
      const stat = await fs.stat(p.part).catch(() => null);
      if (!stat || stat.size !== state.bytes) return this.ack(frame, phase, false, "Partial file size mismatch");
      if (await this.digestFile(p.part) !== state.offer.sha256) {
        return this.ack(frame, phase, false, "SHA-256 mismatch");
      }
      await fs.rename(p.part, p.final);
      const receipt: FileReceivedReceipt = {
        transferId: frame.transfer_id, name: state.offer.name,
        size: state.offer.size, sha256: state.offer.sha256,
        chunks: state.offer.total_chunks, savedPath: p.final,
      };
      state.status = "completed";
      state.receipt = receipt;
      state.updatedAt = Date.now();
      await this.writeState(p.state, state);
      await this.options.onComplete?.(receipt);
      return this.ack(frame, phase, true);
    } catch (cause: any) {
      return this.ack(frame, phase, false, "Receiver error: " + String(cause?.message || cause).slice(0, 340), index);
    }
  }

  /** Sequentializes deliveries even when a WS client emits messages concurrently. */
  public async receive(frame: FileFrame): Promise<FileAckEnvelope> {
    const work = this.lock.then(() => this.actualReceive(frame));
    this.lock = work.then(() => undefined, () => undefined);
    return work;
  }

  public async getReceipt(transferId: string): Promise<FileReceivedReceipt | null> {
    if (!SAFE_ID.test(transferId)) return null;
    const state = await this.readState(path.join(this.directory, "." + transferId + ".state.json"));
    return state?.status === "completed" ? state.receipt || null : null;
  }
}

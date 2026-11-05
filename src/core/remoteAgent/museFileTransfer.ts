import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export const FILE_TRANSFER_MAX_BYTES = 8 * 1024 * 1024;
export const FILE_TRANSFER_CHUNK_BYTES = 64 * 1024;
export const FILE_TRANSFER_ACK_TIMEOUT_MS = 5_000;
export const FILE_TRANSFER_MAX_RETRIES = 3;
const FILE_TRANSFER_TTL_MS = 5 * 60_000;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export interface FileOfferEnvelope {
  v: 1;
  kind: "file_offer";
  id: string;
  transfer_id: string;
  name: string;
  size: number;
  sha256: string;
  chunk_bytes: number;
  total_chunks: number;
}

export interface FileChunkEnvelope {
  v: 1;
  kind: "file_chunk";
  id: string;
  transfer_id: string;
  index: number;
  offset: number;
  data_base64: string;
}

export interface FileCompleteEnvelope {
  v: 1;
  kind: "file_complete";
  id: string;
  transfer_id: string;
}

export interface FileAckEnvelope {
  v: 1;
  kind: "file_ack";
  id: string;
  transfer_id: string;
  phase: "offer" | "chunk" | "complete";
  index?: number;
  /** First missing chunk; returned by durable receivers on offer for resume. */
  next_index?: number;
  ok: boolean;
  error?: string;
}

export type FileTransferEnvelope =
  | FileOfferEnvelope
  | FileChunkEnvelope
  | FileCompleteEnvelope
  | FileAckEnvelope;

export function validateFileTransferEnvelope(value: unknown): string | null {
  const e = value as Record<string, unknown> | null;
  if (!e || typeof e !== "object" || e.v !== 1 ||
      typeof e.id !== "string" || e.id.length === 0 || e.id.length > 120 ||
      typeof e.transfer_id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(e.transfer_id)) {
    return "Invalid file-transfer identifier or version";
  }
  if (e.kind === "file_offer") {
    if (typeof e.name !== "string" || e.name.length === 0 || e.name.length > 180 ||
        e.name === "." || e.name === ".." || /[/\\\x00-\x1f]/.test(e.name) ||
        !Number.isSafeInteger(e.size) || (e.size as number) < 0 ||
        (e.size as number) > FILE_TRANSFER_MAX_BYTES ||
        typeof e.sha256 !== "string" || !SHA256_PATTERN.test(e.sha256) ||
        !Number.isSafeInteger(e.chunk_bytes) || (e.chunk_bytes as number) !== FILE_TRANSFER_CHUNK_BYTES ||
        !Number.isSafeInteger(e.total_chunks) ||
        e.total_chunks !== Math.ceil((e.size as number) / FILE_TRANSFER_CHUNK_BYTES)) {
      return "Invalid file_offer metadata";
    }
  } else if (e.kind === "file_chunk") {
    if (!Number.isSafeInteger(e.index) || (e.index as number) < 0 ||
        !Number.isSafeInteger(e.offset) || (e.offset as number) < 0 ||
        typeof e.data_base64 !== "string" ||
        e.data_base64.length === 0 || e.data_base64.length > 90_000 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(e.data_base64)) {
      return "Invalid file_chunk payload";
    }
  } else if (e.kind === "file_complete") {
    // All metadata is already covered by the common validation.
  } else if (e.kind === "file_ack") {
    if (!["offer", "chunk", "complete"].includes(String(e.phase)) ||
        typeof e.ok !== "boolean" ||
        (e.next_index !== undefined && (e.phase !== "offer" ||
          !Number.isSafeInteger(e.next_index) || (e.next_index as number) < 0 ||
          (e.next_index as number) > FILE_TRANSFER_MAX_BYTES / FILE_TRANSFER_CHUNK_BYTES)) ||
        (e.phase === "chunk" && (!Number.isSafeInteger(e.index) || (e.index as number) < 0)) ||
        (e.error !== undefined && (typeof e.error !== "string" || e.error.length > 500))) {
      return "Invalid file_ack receipt";
    }
  } else {
    return "Unknown file-transfer envelope kind";
  }
  return null;
}

export interface FileTransferReceipt {
  transferId: string;
  name: string;
  size: number;
  sha256: string;
  chunks: number;
}

export class FileTransferSender {
  private active = false;
  private cancelled = false;
  private pending: {
    transferId: string;
    phase: FileAckEnvelope["phase"];
    index?: number;
    accept: (ack: FileAckEnvelope | null) => void;
  } | null = null;

  constructor(
    private readonly transmit: (envelope: FileTransferEnvelope) => Promise<boolean>,
    private readonly ackTimeoutMs = FILE_TRANSFER_ACK_TIMEOUT_MS,
    private readonly maxRetries = FILE_TRANSFER_MAX_RETRIES,
  ) {}

  public handleAck(ack: FileAckEnvelope): boolean {
    const pending = this.pending;
    if (!pending || validateFileTransferEnvelope(ack) ||
        pending.transferId !== ack.transfer_id ||
        pending.phase !== ack.phase ||
        (pending.phase === "chunk" && pending.index !== ack.index)) {
      return false;
    }
    pending.accept(ack);
    return true;
  }

  public abort(): void {
    this.cancelled = true;
    this.pending?.accept(null);
  }

  private async sendAwaitingAck(
    frame: FileOfferEnvelope | FileChunkEnvelope | FileCompleteEnvelope,
    phase: FileAckEnvelope["phase"],
    index?: number,
  ): Promise<FileAckEnvelope> {
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (this.cancelled) throw new Error("Muse file transfer aborted");
      let timer: ReturnType<typeof setTimeout> | undefined;
      const wait = new Promise<FileAckEnvelope | null>((resolve) => {
        const accept = (ack: FileAckEnvelope | null) => {
          if (timer) clearTimeout(timer);
          if (this.pending?.accept === accept) this.pending = null;
          resolve(ack);
        };
        this.pending = { transferId: frame.transfer_id, phase, index, accept };
        timer = setTimeout(() => accept(null), this.ackTimeoutMs);
      });
      let sent = false;
      try {
        sent = await this.transmit(frame);
      } catch {
        sent = false;
      }
      if (!sent) this.pending?.accept(null);
      const ack = await wait;
      if (this.cancelled) throw new Error("Muse file transfer aborted");
      if (ack && !ack.ok) {
        throw new Error("Muse rejected " + phase + ": " + (ack.error || "unknown reason"));
      }
      if (ack?.ok) return ack;
      // Allow a reconnecting Muse WebSocket peer time to re-establish its
      // authenticated connection before resending the same idempotent frame.
      if (attempt < this.maxRetries) {
        await new Promise(resolve => setTimeout(resolve, Math.min(1000, this.ackTimeoutMs)));
      }
    }
    throw new Error("Timed out waiting for Muse " + phase + " ACK after retries");
  }

  public async sendFile(filePath: string, options: {
    checkpointDir?: string;
    onProgress?: (progress: {transferId: string; bytes: number; total: number; percent: number; resumed: boolean}) => void;
  } = {}): Promise<FileTransferReceipt> {
    if (this.active) throw new Error("A file transfer is already active on this watcher");
    this.active = true;
    this.cancelled = false;
    try {
      const stat = await fs.lstat(filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > FILE_TRANSFER_MAX_BYTES) {
        throw new Error("Source must be a regular file of at most 8 MiB");
      }
      const bytes = await fs.readFile(filePath);
      if (bytes.length > FILE_TRANSFER_MAX_BYTES) throw new Error("File exceeds 8 MiB");
      const name = path.basename(filePath);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const checkpointPath = options.checkpointDir
        ? path.join(options.checkpointDir,
            createHash("sha256").update(path.resolve(filePath) + "\0" + sha256).digest("hex") + ".json")
        : null;
      let transferId = randomUUID();
      if (checkpointPath) {
        await fs.mkdir(options.checkpointDir!, { recursive: true, mode: 0o700 });
        try {
          const stored = JSON.parse(await fs.readFile(checkpointPath, "utf8"));
          if (stored?.sha256 === sha256 && stored?.size === bytes.length &&
              typeof stored?.transferId === "string" &&
              /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(stored.transferId)) {
            transferId = stored.transferId;
          }
        } catch { /* New transfer; no valid checkpoint. */ }
        await fs.writeFile(checkpointPath,
          JSON.stringify({ transferId, sha256, size: bytes.length, filePath: path.resolve(filePath) }),
          { mode: 0o600 });
      }
      const chunks = Math.ceil(bytes.length / FILE_TRANSFER_CHUNK_BYTES);
      const offer: FileOfferEnvelope = {
        v: 1, kind: "file_offer", id: randomUUID(), transfer_id: transferId,
        name, size: bytes.length, sha256, chunk_bytes: FILE_TRANSFER_CHUNK_BYTES,
        total_chunks: chunks,
      };
      const invalid = validateFileTransferEnvelope(offer);
      if (invalid) throw new Error(invalid);
      const response = await this.sendAwaitingAck(offer, "offer");
      const startIndex = Math.min(chunks, response.next_index ?? 0);
      const resumed = startIndex > 0;
      options.onProgress?.({
        transferId, bytes: Math.min(bytes.length, startIndex * FILE_TRANSFER_CHUNK_BYTES),
        total: bytes.length, percent: bytes.length ? Math.round(100 * startIndex / Math.max(1, chunks)) : 100,
        resumed,
      });
      for (let index = startIndex; index < chunks; index++) {
        const offset = index * FILE_TRANSFER_CHUNK_BYTES;
        const frame: FileChunkEnvelope = {
          v: 1, kind: "file_chunk", id: randomUUID(), transfer_id: transferId,
          index, offset,
          data_base64: bytes.subarray(offset, offset + FILE_TRANSFER_CHUNK_BYTES).toString("base64"),
        };
        await this.sendAwaitingAck(frame, "chunk", index);
        options.onProgress?.({
          transferId, bytes: Math.min(bytes.length, (index + 1) * FILE_TRANSFER_CHUNK_BYTES),
          total: bytes.length, percent: Math.round(100 * (index + 1) / Math.max(1, chunks)), resumed,
        });
      }
      await this.sendAwaitingAck({
        v: 1, kind: "file_complete", id: randomUUID(), transfer_id: transferId,
      }, "complete");
      if (checkpointPath) await fs.rm(checkpointPath, { force: true });
      return { transferId, name, size: bytes.length, sha256, chunks };
    } finally {
      this.pending?.accept(null);
      this.active = false;
      this.cancelled = false;
    }
  }
}

interface ReceiverState {
  offer: FileOfferEnvelope;
  parts: Buffer[];
  received: number;
  nextIndex: number;
  updatedAt: number;
}

export interface FileReceivedReceipt extends FileTransferReceipt {
  savedPath: string;
}

export class FileTransferReceiver {
  private readonly pending = new Map<string, ReceiverState>();
  private readonly completed = new Map<string, { receipt: FileReceivedReceipt; at: number }>();
  constructor(private readonly destinationDir: string, private readonly maxConcurrent = 4) {}

  private ack(
    frame: FileOfferEnvelope | FileChunkEnvelope | FileCompleteEnvelope,
    phase: FileAckEnvelope["phase"],
    ok: boolean,
    error?: string,
    index?: number,
  ): FileAckEnvelope {
    return {
      v: 1, kind: "file_ack", id: randomUUID(), transfer_id: frame.transfer_id,
      phase, ...(index === undefined ? {} : { index }),
      ok, ...(error ? { error: error.slice(0, 500) } : {}),
    };
  }

  public async receive(
    frame: FileOfferEnvelope | FileChunkEnvelope | FileCompleteEnvelope,
  ): Promise<FileAckEnvelope> {
    const phase = frame.kind === "file_offer" ? "offer" :
      frame.kind === "file_chunk" ? "chunk" : "complete";
    const index = frame.kind === "file_chunk" ? frame.index : undefined;
    const invalid = validateFileTransferEnvelope(frame);
    if (invalid) return this.ack(frame, phase, false, invalid, index);

    const now = Date.now();
    for (const [id, state] of this.pending) {
      if (now - state.updatedAt > FILE_TRANSFER_TTL_MS) this.pending.delete(id);
    }
    for (const [id, state] of this.completed) {
      if (now - state.at > FILE_TRANSFER_TTL_MS) this.completed.delete(id);
    }

    const done = this.completed.get(frame.transfer_id);
    if (done) {
      if (frame.kind === "file_offer") {
        const same = frame.sha256 === done.receipt.sha256 &&
          frame.size === done.receipt.size && frame.name === done.receipt.name;
        return this.ack(frame, phase, same, same ? undefined : "Transfer ID already used");
      }
      if (frame.kind === "file_complete") return this.ack(frame, phase, true);
      return this.ack(frame, phase, frame.index < done.receipt.chunks,
        frame.index < done.receipt.chunks ? undefined : "Invalid completed chunk index", frame.index);
    }

    if (frame.kind === "file_offer") {
      const prior = this.pending.get(frame.transfer_id);
      if (prior) {
        const same = prior.offer.sha256 === frame.sha256 &&
          prior.offer.size === frame.size && prior.offer.name === frame.name;
        return this.ack(frame, phase, same, same ? undefined : "Transfer ID conflict");
      }
      if (this.pending.size >= this.maxConcurrent) return this.ack(frame, phase, false, "Receiver busy");
      this.pending.set(frame.transfer_id, {
        offer: frame, parts: [], received: 0, nextIndex: 0, updatedAt: now,
      });
      return this.ack(frame, phase, true);
    }

    const state = this.pending.get(frame.transfer_id);
    if (!state) return this.ack(frame, phase, false, "Unknown or expired transfer", index);
    state.updatedAt = now;
    if (frame.kind === "file_chunk") {
      if (frame.index < state.nextIndex) {
        const prior = state.parts[frame.index];
        const bytes = Buffer.from(frame.data_base64, "base64");
        const same = prior?.equals(bytes) && prior.toString("base64") === frame.data_base64;
        return this.ack(frame, phase, Boolean(same), same ? undefined : "Duplicate chunk mismatch", index);
      }
      if (frame.index !== state.nextIndex ||
          frame.offset !== frame.index * FILE_TRANSFER_CHUNK_BYTES ||
          frame.index >= state.offer.total_chunks) {
        return this.ack(frame, phase, false, "Out-of-order chunk or offset", index);
      }
      const bytes = Buffer.from(frame.data_base64, "base64");
      const expectedLength = Math.min(FILE_TRANSFER_CHUNK_BYTES, state.offer.size - frame.offset);
      if (!bytes.length || bytes.length !== expectedLength ||
          bytes.toString("base64") !== frame.data_base64) {
        return this.ack(frame, phase, false, "Invalid chunk encoding or byte count", index);
      }
      state.parts.push(bytes);
      state.received += bytes.length;
      state.nextIndex++;
      return this.ack(frame, phase, true, undefined, index);
    }

    if (state.nextIndex !== state.offer.total_chunks || state.received !== state.offer.size) {
      return this.ack(frame, phase, false, "Incomplete file");
    }
    const bytes = Buffer.concat(state.parts);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== state.offer.sha256) {
      this.pending.delete(frame.transfer_id);
      return this.ack(frame, phase, false, "SHA-256 mismatch");
    }

    const safeName = state.offer.name.replace(/[^\p{L}\p{N}._ -]/gu, "_");
    const targetName = frame.transfer_id + "-" + safeName;
    const target = path.join(this.destinationDir, targetName);
    try {
      await fs.mkdir(this.destinationDir, { recursive: true, mode: 0o700 });
      const handle = await fs.open(target, "wx", 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } catch {
        await handle.close();
        await fs.unlink(target).catch(() => undefined);
        throw new Error("File write failed");
      }
      await handle.close();
    } catch {
      return this.ack(frame, phase, false, "Receiver could not persist file");
    }
    const receipt: FileReceivedReceipt = {
      transferId: frame.transfer_id, name: state.offer.name,
      size: bytes.length, sha256: digest, chunks: state.offer.total_chunks, savedPath: target,
    };
    this.completed.set(frame.transfer_id, { receipt, at: now });
    this.pending.delete(frame.transfer_id);
    return this.ack(frame, phase, true);
  }

  public getReceipt(transferId: string): FileReceivedReceipt | null {
    return this.completed.get(transferId)?.receipt || null;
  }
}

/** Limit sending arbitrary local files to the selected workspace; reject symlinks and secrets. */
export async function resolveTransferSource(filePath: string, workspaceRoot: string): Promise<string> {
  if (!filePath || filePath.includes("\0")) throw new Error("Invalid source file path");
  const root = await fs.realpath(workspaceRoot);
  const full = path.resolve(workspaceRoot, filePath);
  const stat = await fs.lstat(full);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Source must be a regular non-symlink file");
  const real = await fs.realpath(full);
  const relative = path.relative(root, real);
  if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
    throw new Error("Source file is outside the selected workspace");
  }
  if (/(^|[/\\])\.env(?:$|\.)|(?:^|[/\\])(?:id_rsa|id_ed25519|credentials\.json|model-config\.json)$/i.test(real)) {
    throw new Error("Refusing to transfer a sensitive configuration file");
  }
  if (stat.size > FILE_TRANSFER_MAX_BYTES) throw new Error("File exceeds 8 MiB limit");
  return real;
}

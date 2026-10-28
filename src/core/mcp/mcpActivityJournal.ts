/**
 * mcpActivityJournal.ts — Safe, bounded append-only journal for cross-process MCP activity.
 *
 * Implements:
 * - Size-based rotation (default 16 MB max, 5 archives).
 * - Safe migration for legacy oversized files (atomic rename, zero in-memory read of multi-GB files).
 * - Cross-process-safe atomic rotation lock with stale-lock recovery (5s timeout).
 * - Bounded legacy archive retention (capped count to prevent unbound legacy storage growth).
 * - Bounded chunked reader (reads in 64 KB chunks, carries forward partial lines up to 128 KB,
 *   detects rotation/replacement/truncation via file-identity/generation tracking, and eliminates
 *   whole-delta Buffer.alloc spikes).
 * - Hard record size cap via serializeBoundedJournalEntry.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { serializeBoundedJournalEntry, MAX_ACTIVITY_RECORD_BYTES } from "./mcpLogSanitizer.js";
import type { McpActivityEvent } from "./mcpActivityBus.js";

export interface McpJournalEntry {
  ts: number;
  pid: number;
  workspace?: string;
  event: McpActivityEvent;
  chatLine: string;
}

export interface McpActivityJournalOptions {
  journalPath?: string;
  maxJournalBytes?: number;
  maxArchives?: number;
  maxLegacyArchives?: number;
  maxRecordBytes?: number;
}

export const DEFAULT_MCP_JOURNAL_PATH = path.join(os.homedir(), ".superagent-r", "mcp-activity.jsonl");
export const DEFAULT_MAX_JOURNAL_BYTES = 16 * 1024 * 1024; // 16 MB
export const DEFAULT_MAX_ARCHIVES = 5;
export const DEFAULT_MAX_LEGACY_ARCHIVES = 2; // Capped legacy archives
export const DEFAULT_CHUNK_SIZE_BYTES = 64 * 1024; // 64 KB
export const DEFAULT_MAX_LINE_BYTES = 128 * 1024; // 128 KB line cap
export const DEFAULT_MAX_BYTES_PER_POLL = 1024 * 1024; // 1 MB per poll interval
export const ROTATION_LOCK_TIMEOUT_MS = 5000; // 5 seconds stale-lock recovery
export const DEFAULT_GENERATION_HASH_CHUNK_BYTES = 64 * 1024; // 64 KB fixed buffer for streaming generation verification

export interface FileIdentity {
  ino: number;
  dev: number;
  birthtimeMs: number;
}

export function getFileIdentity(stat: fs.Stats): FileIdentity {
  return {
    ino: stat.ino || 0,
    dev: stat.dev || 0,
    birthtimeMs: stat.birthtimeMs || (stat.birthtime ? stat.birthtime.getTime() : 0),
  };
}

export function isSameFileIdentity(a: FileIdentity | null, b: FileIdentity): boolean {
  if (!a) return false;
  // If inode and dev are available and non-zero (Windows NTFS and Linux/macOS)
  if (a.ino !== 0 && b.ino !== 0) {
    if (a.dev !== 0 && b.dev !== 0) {
      return a.ino === b.ino && a.dev === b.dev;
    }
    return a.ino === b.ino;
  }
  // Fallback for filesystems without inode support: compare birth/creation time
  return Math.abs(a.birthtimeMs - b.birthtimeMs) < 2;
}

export class McpActivityJournal {
  readonly journalPath: string;
  readonly maxJournalBytes: number;
  readonly maxArchives: number;
  readonly maxLegacyArchives: number;
  readonly maxRecordBytes: number;
  private migrationChecked = false;

  constructor(options?: McpActivityJournalOptions) {
    this.journalPath = options?.journalPath || process.env.SUPERAGENT_MCP_JOURNAL_PATH || DEFAULT_MCP_JOURNAL_PATH;
    const envMaxBytes = process.env.SUPERAGENT_MCP_JOURNAL_MAX_BYTES ? parseInt(process.env.SUPERAGENT_MCP_JOURNAL_MAX_BYTES, 10) : NaN;
    this.maxJournalBytes = options?.maxJournalBytes || (Number.isFinite(envMaxBytes) && envMaxBytes > 0 ? envMaxBytes : DEFAULT_MAX_JOURNAL_BYTES);
    const envMaxArchives = process.env.SUPERAGENT_MCP_JOURNAL_MAX_ARCHIVES ? parseInt(process.env.SUPERAGENT_MCP_JOURNAL_MAX_ARCHIVES, 10) : NaN;
    this.maxArchives = options?.maxArchives !== undefined ? options.maxArchives : (Number.isFinite(envMaxArchives) && envMaxArchives >= 0 ? envMaxArchives : DEFAULT_MAX_ARCHIVES);
    const envMaxLegacy = process.env.SUPERAGENT_MCP_JOURNAL_MAX_LEGACY ? parseInt(process.env.SUPERAGENT_MCP_JOURNAL_MAX_LEGACY, 10) : NaN;
    this.maxLegacyArchives = options?.maxLegacyArchives !== undefined ? options.maxLegacyArchives : (Number.isFinite(envMaxLegacy) && envMaxLegacy >= 0 ? envMaxLegacy : DEFAULT_MAX_LEGACY_ARCHIVES);
    this.maxRecordBytes = options?.maxRecordBytes || MAX_ACTIVITY_RECORD_BYTES;
  }

  /**
   * Acquire cross-process atomic rotation lock with stale-lock recovery.
   * If lock is held by another process, returns null immediately without blocking or throwing.
   */
  private withRotationLock<T>(fn: () => T): T | null {
    const lockPath = `${this.journalPath}.rotation.lock`;
    let fd: number | null = null;

    try {
      fd = fs.openSync(lockPath, "wx");
    } catch (err: any) {
      if (err?.code === "EEXIST") {
        try {
          const stat = fs.statSync(lockPath);
          if (Date.now() - stat.mtimeMs > ROTATION_LOCK_TIMEOUT_MS) {
            try {
              fs.unlinkSync(lockPath);
              fd = fs.openSync(lockPath, "wx");
            } catch {
              return null; // Lost race for stale lock recovery or another process acquired it
            }
          } else {
            return null; // Lock is actively held
          }
        } catch {
          return null;
        }
      } else {
        return null;
      }
    }

    if (fd === null) return null;

    try {
      try {
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
      } catch {}
      return fn();
    } finally {
      try { fs.closeSync(fd); } catch {}
      try { fs.unlinkSync(lockPath); } catch {}
    }
  }

  /**
   * Prune old .legacy-<timestamp>.jsonl archives so legacy files do not bypass the retention budget.
   * Keeps at most maxLegacyArchives (default 2).
   */
  cleanLegacyArchives(): void {
    try {
      const dir = path.dirname(this.journalPath);
      if (!fs.existsSync(dir)) return;
      const ext = path.extname(this.journalPath) || ".jsonl";
      const baseName = path.basename(this.journalPath, ext);

      const files = fs.readdirSync(dir);
      const legacyPattern = new RegExp(`^${baseName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.legacy-\\d+${ext.replace(".", "\\.")}$`);
      const legacyFiles: { path: string; mtimeMs: number }[] = [];

      for (const file of files) {
        if (legacyPattern.test(file)) {
          const fullPath = path.join(dir, file);
          try {
            const stat = fs.statSync(fullPath);
            legacyFiles.push({ path: fullPath, mtimeMs: stat.mtimeMs });
          } catch {}
        }
      }

      // Sort newest first
      legacyFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);

      // Delete beyond maxLegacyArchives
      if (legacyFiles.length > this.maxLegacyArchives) {
        for (const extra of legacyFiles.slice(this.maxLegacyArchives)) {
          try {
            fs.unlinkSync(extra.path);
          } catch {}
        }
      }
    } catch {}
  }

  /**
   * Safe migration for existing oversized journals.
   * Atomically renames the file to a legacy archive without reading any content into memory,
   * then applies legacy archive retention.
   */
  migrateLegacyOversizedJournal(): boolean {
    if (this.migrationChecked) return false;
    this.migrationChecked = true;
    try {
      if (!fs.existsSync(this.journalPath)) return false;
      const stat = fs.statSync(this.journalPath);
      if (stat.size >= this.maxJournalBytes) {
        const migrated = this.withRotationLock(() => {
          if (!fs.existsSync(this.journalPath)) return false;
          const reStat = fs.statSync(this.journalPath);
          if (reStat.size < this.maxJournalBytes) return false;
          return this.rotateJournal("legacy");
        });
        return migrated ?? false;
      }
    } catch {
      // Best-effort migration
    }
    return false;
  }

  /**
   * Rotate active journal if size exceeds maxJournalBytes.
   * Cross-process safe: uses atomic lock file with stale-lock recovery.
   * Other concurrent writers continue without disruption.
   */
  rotateIfNeeded(): boolean {
    try {
      if (!fs.existsSync(this.journalPath)) return false;
      const stat = fs.statSync(this.journalPath);
      if (stat.size < this.maxJournalBytes) return false;

      const rotated = this.withRotationLock(() => {
        // Double-check inside lock
        if (!fs.existsSync(this.journalPath)) return false;
        const reStat = fs.statSync(this.journalPath);
        if (reStat.size < this.maxJournalBytes) return false;
        return this.rotateJournal("size");
      });

      return rotated ?? false;
    } catch {
      // Rotation check failure must not disrupt logging
    }
    return false;
  }

  private rotateJournal(reason: "size" | "legacy"): boolean {
    if (this.maxArchives <= 0) {
      try {
        fs.unlinkSync(this.journalPath);
        return true;
      } catch {
        return false;
      }
    }

    try {
      const dir = path.dirname(this.journalPath);
      const ext = path.extname(this.journalPath) || ".jsonl";
      const base = this.journalPath.slice(0, this.journalPath.length - ext.length);

      if (reason === "legacy") {
        const legacyTarget = `${base}.legacy-${Date.now()}${ext}`;
        try {
          fs.renameSync(this.journalPath, legacyTarget);
          this.cleanLegacyArchives();
          return true;
        } catch {
          // Fall through to standard numeric rotation if legacy rename fails
        }
      }

      // Evict oldest archive if at maxArchives
      const oldestArchive = `${base}.${this.maxArchives}${ext}`;
      if (fs.existsSync(oldestArchive)) {
        try { fs.unlinkSync(oldestArchive); } catch { /* ignore */ }
      }

      // Shift existing archives down (e.g. 4 -> 5, 3 -> 4, etc.)
      for (let i = this.maxArchives - 1; i >= 1; i--) {
        const current = `${base}.${i}${ext}`;
        const next = `${base}.${i + 1}${ext}`;
        if (fs.existsSync(current)) {
          try { fs.renameSync(current, next); } catch { /* continue shifting */ }
        }
      }

      // Rename active file to archive .1
      const firstArchive = `${base}.1${ext}`;
      try {
        fs.renameSync(this.journalPath, firstArchive);
        this.cleanLegacyArchives();
        return true;
      } catch {
        // If rename fails (e.g. locked on Windows), continue appending to active file
        return false;
      }
    } catch {
      return false;
    }
  }

  /**
   * Append a bounded entry to the activity journal.
   */
  appendEntry(entry: McpJournalEntry): void {
    try {
      this.migrateLegacyOversizedJournal();
      this.rotateIfNeeded();

      const dir = path.dirname(this.journalPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const serialized = serializeBoundedJournalEntry(entry, this.maxRecordBytes);
      fs.appendFileSync(this.journalPath, serialized + "\n", "utf8");
    } catch {
      // Append failure must never throw or disrupt callers
    }
  }

  /**
   * Return journal storage telemetry, reporting active, numeric archives, and legacy archives.
   * Rotation is checked before append, so each active/numeric file can exceed maxJournalBytes by at most
   * one bounded record plus newline. Under defaults, active + 5 numeric archives are therefore bounded by
   * < 6 * (16 MiB + 64 KiB + 1 byte) ~= 96.38 MiB.
   * Legacy forensic archives (.legacy-<timestamp>.jsonl) are count-bounded (default max 2) and operator-managed;
   * they are excluded from the active/numeric byte ceiling.
   */
  getJournalStats(): {
    activeSizeBytes: number;
    archiveCount: number;
    archiveSizeBytes: number;
    legacyArchiveCount: number;
    legacySizeBytes: number;
    totalSizeBytes: number;
    activePath: string;
    archives: string[];
    legacyArchives: string[];
  } {
    let activeSizeBytes = 0;
    try {
      if (fs.existsSync(this.journalPath)) {
        activeSizeBytes = fs.statSync(this.journalPath).size;
      }
    } catch {}

    const dir = path.dirname(this.journalPath);
    const ext = path.extname(this.journalPath) || ".jsonl";
    const baseName = path.basename(this.journalPath, ext);

    const archives: string[] = [];
    const legacyArchives: string[] = [];
    let archiveTotalBytes = 0;
    let legacyTotalBytes = 0;

    try {
      if (fs.existsSync(dir)) {
        const files = fs.readdirSync(dir);
        const legacyPattern = new RegExp(`^${baseName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.legacy-\\d+${ext.replace(".", "\\.")}$`);
        const numericPattern = new RegExp(`^${baseName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.\\d+${ext.replace(".", "\\.")}$`);

        for (const file of files) {
          if (file === path.basename(this.journalPath)) continue;
          const fullPath = path.join(dir, file);

          if (legacyPattern.test(file)) {
            legacyArchives.push(fullPath);
            try {
              legacyTotalBytes += fs.statSync(fullPath).size;
            } catch {}
          } else if (numericPattern.test(file)) {
            archives.push(fullPath);
            try {
              archiveTotalBytes += fs.statSync(fullPath).size;
            } catch {}
          }
        }
      }
    } catch {}

    return {
      activeSizeBytes,
      archiveCount: archives.length,
      archiveSizeBytes: archiveTotalBytes,
      legacyArchiveCount: legacyArchives.length,
      legacySizeBytes: legacyTotalBytes,
      totalSizeBytes: activeSizeBytes + archiveTotalBytes + legacyTotalBytes,
      activePath: this.journalPath,
      archives,
      legacyArchives,
    };
  }
}

/**
 * Bounded chunked streaming reader for cross-process activity polling.
 * Eliminates whole-delta Buffer.alloc(stat.size - lastFileSize) memory spikes.
 * Detects:
 * 1. File replacement/rotation (file identity inode, device, birthtime tracking).
 * 2. File truncation in place (stat.size < lastOffset).
 * 3. Same-file rewrite / truncate+rewrite anywhere in already-consumed bytes by
 *    streaming the complete consumed-prefix SHA-256 through a fixed 64 KB buffer.
 *    This keeps memory O(1) while preventing middle-of-file rewrites from being skipped.
 */
export class BoundedChunkedJournalReader {
  readonly journalPath: string;
  readonly chunkSize: number;
  readonly maxLineLength: number;
  readonly maxBytesPerPoll: number;
  private lastOffset = 0;
  private partialBuffer = "";
  private lastFileIdentity: FileIdentity | null = null;
  private consumedPrefixHasher: ReturnType<typeof crypto.createHash> | null = null;
  private lastMtimeMs: number | null = null;
  private lastCtimeMs: number | null = null;
  private lastObservedSize = 0;

  constructor(options?: {
    journalPath?: string;
    chunkSize?: number;
    maxLineLength?: number;
    maxBytesPerPoll?: number;
    startAtEnd?: boolean;
  }) {
    this.journalPath = options?.journalPath || DEFAULT_MCP_JOURNAL_PATH;
    this.chunkSize = options?.chunkSize || DEFAULT_CHUNK_SIZE_BYTES;
    this.maxLineLength = options?.maxLineLength || DEFAULT_MAX_LINE_BYTES;
    this.maxBytesPerPoll = options?.maxBytesPerPoll || DEFAULT_MAX_BYTES_PER_POLL;

    try {
      if (fs.existsSync(this.journalPath)) {
        const stat = fs.statSync(this.journalPath);
        this.lastFileIdentity = getFileIdentity(stat);
        this.lastMtimeMs = stat.mtimeMs;
        this.lastCtimeMs = stat.ctimeMs;
        this.lastObservedSize = stat.size;
        if (options?.startAtEnd !== false) {
          this.lastOffset = stat.size;
        }

        let fd: number | null = null;
        try {
          fd = fs.openSync(this.journalPath, "r");
          const res = this.buildConsumedPrefixHasher(fd, this.lastOffset);
          this.consumedPrefixHasher = res?.hasher ?? crypto.createHash("sha256");
        } finally {
          if (fd !== null) {
            try { fs.closeSync(fd); } catch {}
          }
        }
      }
    } catch {}

    if (this.consumedPrefixHasher === null) {
      this.consumedPrefixHasher = crypto.createHash("sha256");
    }
  }

  /**
   * Build a SHA-256 state for exactly the first `length` bytes using a fixed-size
   * streaming buffer. Memory stays O(1) even when the consumed prefix is large.
   *
   * Hashing the complete consumed prefix (rather than only a small anchor)
   * detects same-file rewrites that preserve the beginning of the file but
   * modify already-consumed records in the middle.
   */
  private buildConsumedPrefixHasher(
    fd: number,
    length: number
  ): { hasher: ReturnType<typeof crypto.createHash>; length: number } | null {
    const targetLength = Math.max(0, length);
    const hasher = crypto.createHash("sha256");
    if (targetLength === 0) {
      return { hasher, length: 0 };
    }

    const buffer = Buffer.alloc(Math.min(DEFAULT_GENERATION_HASH_CHUNK_BYTES, targetLength));
    let offset = 0;
    while (offset < targetLength) {
      const toRead = Math.min(buffer.length, targetLength - offset);
      const bytesRead = fs.readSync(fd, buffer, 0, toRead, offset);
      if (bytesRead <= 0) return null;
      hasher.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    return { hasher, length: offset };
  }

  getOffset(): number {
    return this.lastOffset;
  }

  setOffset(offset: number): void {
    this.lastOffset = Math.max(0, offset);
    this.partialBuffer = "";
    this.consumedPrefixHasher = crypto.createHash("sha256");

    try {
      if (fs.existsSync(this.journalPath)) {
        const stat = fs.statSync(this.journalPath);
        this.lastFileIdentity = getFileIdentity(stat);
        this.lastMtimeMs = stat.mtimeMs;
        this.lastCtimeMs = stat.ctimeMs;
        this.lastObservedSize = stat.size;

        let fd: number | null = null;
        try {
          fd = fs.openSync(this.journalPath, "r");
          const res = this.buildConsumedPrefixHasher(fd, Math.min(this.lastOffset, stat.size));
          if (res && res.length === this.lastOffset) {
            this.consumedPrefixHasher = res.hasher;
          }
        } finally {
          if (fd !== null) {
            try { fs.closeSync(fd); } catch {}
          }
        }
      }
    } catch {}
  }

  /**
   * Poll journal for newly appended entries using bounded chunks.
   * Invokes onEntry for each complete parsed McpJournalEntry.
   * Returns count of entries processed.
   * Detects:
   * - File replacement/rotation (file identity changed)
   * - In-place truncation (size < lastOffset)
   * - Same-file rewrite / truncate+rewrite anywhere inside the already-consumed
   *   prefix by streaming and comparing the complete consumed-prefix SHA-256.
   */
  poll(onEntry: (entry: McpJournalEntry) => void): number {
    try {
      if (!fs.existsSync(this.journalPath)) return 0;
      const stat = fs.statSync(this.journalPath);
      const currentIdentity = getFileIdentity(stat);

      const isReplaced = this.lastFileIdentity !== null && !isSameFileIdentity(this.lastFileIdentity, currentIdentity);
      const isTruncated = stat.size < this.lastOffset;

      if (isReplaced || isTruncated) {
        this.lastOffset = 0;
        this.partialBuffer = "";
        this.lastFileIdentity = currentIdentity;
        this.consumedPrefixHasher = crypto.createHash("sha256");
      } else if (this.lastFileIdentity === null) {
        this.lastFileIdentity = currentIdentity;
      }

      // Fast path only when both data and metadata observations are unchanged.
      if (
        !isReplaced &&
        !isTruncated &&
        stat.size === this.lastOffset &&
        stat.size === this.lastObservedSize &&
        this.lastMtimeMs !== null &&
        this.lastCtimeMs !== null &&
        stat.mtimeMs === this.lastMtimeMs &&
        stat.ctimeMs === this.lastCtimeMs
      ) {
        return 0;
      }

      let entriesProcessed = 0;
      let fd: number | null = null;
      let bytesReadThisPoll = 0;
      let workingHasher = this.consumedPrefixHasher ?? crypto.createHash("sha256");

      try {
        fd = fs.openSync(this.journalPath, "r");

        // If the same file changed since the prior observation, verify every
        // already-consumed byte using a fixed-size streaming buffer. This is
        // O(consumed bytes) I/O on a changed generation but O(1) memory.
        const metadataChanged =
          !isReplaced &&
          !isTruncated &&
          this.lastOffset > 0 &&
          (this.lastMtimeMs === null ||
            this.lastCtimeMs === null ||
            stat.mtimeMs !== this.lastMtimeMs ||
            stat.ctimeMs !== this.lastCtimeMs ||
            stat.size !== this.lastObservedSize);

        if (metadataChanged) {
          const previousDigest = this.consumedPrefixHasher?.copy().digest("hex") ?? null;
          const verified = this.buildConsumedPrefixHasher(fd, this.lastOffset);
          const currentDigest = verified?.hasher.copy().digest("hex") ?? null;

          if (
            previousDigest === null ||
            verified === null ||
            verified.length !== this.lastOffset ||
            currentDigest !== previousDigest
          ) {
            // Same path/inode was rewritten somewhere in already-consumed data.
            this.lastOffset = 0;
            this.partialBuffer = "";
            this.lastFileIdentity = currentIdentity;
            workingHasher = crypto.createHash("sha256");
          } else {
            // Normal append/extension: retain the verified prefix hash state and
            // continue it with newly read bytes below.
            workingHasher = verified.hasher;
          }
        }

        if (stat.size === this.lastOffset) {
          this.consumedPrefixHasher = workingHasher;
          this.lastMtimeMs = stat.mtimeMs;
          this.lastCtimeMs = stat.ctimeMs;
          this.lastObservedSize = stat.size;
          return 0;
        }

        while (this.lastOffset < stat.size && bytesReadThisPoll < this.maxBytesPerPoll) {
          const toRead = Math.min(this.chunkSize, stat.size - this.lastOffset);
          const buf = Buffer.alloc(toRead);
          const bytesRead = fs.readSync(fd, buf, 0, toRead, this.lastOffset);
          if (bytesRead <= 0) break;

          workingHasher.update(buf.subarray(0, bytesRead));
          this.lastOffset += bytesRead;
          bytesReadThisPoll += bytesRead;

          this.partialBuffer += buf.subarray(0, bytesRead).toString("utf8");

          let newlineIdx: number;
          while ((newlineIdx = this.partialBuffer.indexOf("\n")) !== -1) {
            const rawLine = this.partialBuffer.slice(0, newlineIdx);
            this.partialBuffer = this.partialBuffer.slice(newlineIdx + 1);

            const line = rawLine.trim();
            if (!line) continue;

            try {
              const entry = JSON.parse(line) as McpJournalEntry;
              if (entry && typeof entry === "object") {
                onEntry(entry);
                entriesProcessed++;
              }
            } catch {
              // Ignore malformed individual JSON line.
            }
          }

          if (this.partialBuffer.length > this.maxLineLength) {
            this.partialBuffer = "";
          }
        }

        this.consumedPrefixHasher = workingHasher;
        this.lastMtimeMs = stat.mtimeMs;
        this.lastCtimeMs = stat.ctimeMs;
        this.lastObservedSize = stat.size;
      } finally {
        if (fd !== null) {
          try { fs.closeSync(fd); } catch {}
        }
      }

      return entriesProcessed;
    } catch {
      return 0;
    }
  }
}

let defaultJournalInstance: McpActivityJournal | null = null;

export function getActivityJournal(): McpActivityJournal {
  if (!defaultJournalInstance) {
    defaultJournalInstance = new McpActivityJournal();
  }
  return defaultJournalInstance;
}

export function resetActivityJournalForTests(customJournal?: McpActivityJournal): void {
  defaultJournalInstance = customJournal || null;
}

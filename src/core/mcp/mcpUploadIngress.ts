/**
 * mcpUploadIngress.ts — Secure Browser Upload Ingress Pipeline for SuperAgent MCP.
 *
 * Provides safe, audited staging and verification for CDP file uploads:
 * 1. Accepts user-selected artifact
 * 2. Stages in isolated ingress directory
 * 3. Validates path, MIME, magic bytes, size limits, and SHA-256 hash
 * 4. Checks permanent host file-policy and native approval
 * 5. Binds operation to principal, profile, tabId, lease token, and unique operation ID
 * 6. Executes upload via host-certified CDP pathway
 * 7. Verifies upload result in target DOM
 * 8. Cleans up staging according to retention policy
 */

import fs from "node:fs/promises";
import * as syncFs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileRulesRegistered, isPathAllowedByPermanentRegistry } from "../tools/registeredFileToolGate.js";

export const MAX_UPLOAD_FILE_BYTES = 100 * 1024 * 1024; // 100 MiB per file
export const MAX_TOTAL_UPLOAD_BYTES = 200 * 1024 * 1024; // 200 MiB combined
export const INGRESS_RETENTION_MS = 15 * 60 * 1000; // 15 minutes TTL

export const OFFICE_MIME_TYPES = {
  DOCX: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  XLSX: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  PPTX: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
} as const;

export interface IngressArtifactReceipt {
  receiptId: string;
  operationId: string;
  sourcePath: string;
  stagedPath: string;
  filename: string;
  mimeType: string;
  fileSize: number;
  sha256: string;
  principalId?: string;
  targetId?: string;
  sessionToken?: string;
  createdAt: number;
  expiresAt: number;
}

const activeReceipts = new Map<string, IngressArtifactReceipt>();
const usedOperationIds = new Set<string>();


const OPERATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;

export function getIngressRootDir(): string {
  return path.join(os.homedir(), ".superagent-r", "ingress", "uploads");
}

/** Detects MIME type and validates magic bytes */
export async function detectAndValidateMagicBytes(filePath: string, expectedMime?: string): Promise<{ mime: string; verified: boolean }> {
  const handle = await fs.open(filePath, "r");
  const buffer = Buffer.alloc(32);
  await handle.read(buffer, 0, 32, 0);
  await handle.close();

  let detectedMime = "application/octet-stream";
  let verified = true;

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    detectedMime = "image/png";
  }
  // JPEG: FF D8 FF
  else if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    detectedMime = "image/jpeg";
  }
  // GIF: GIF87a or GIF89a
  else if (buffer.toString("ascii", 0, 4) === "GIF8") {
    detectedMime = "image/gif";
  }
  // PDF: %PDF-
  else if (buffer.toString("ascii", 0, 4) === "%PDF") {
    detectedMime = "application/pdf";
  }
  // WebP: RIFF....WEBP
  else if (buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    detectedMime = "image/webp";
  }
  // MP4: ....ftyp
  else if (buffer.toString("ascii", 4, 8) === "ftyp") {
    detectedMime = "video/mp4";
  }
  // WebM: 1A 45 DF A3
  else if (buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) {
    detectedMime = "video/webm";
  }
  // ZIP / Office Open XML: PK..
  else if (buffer[0] === 0x50 && buffer[1] === 0x4b && (buffer[2] === 0x03 || buffer[2] === 0x05)) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === ".docx" || expectedMime === OFFICE_MIME_TYPES.DOCX) {
      detectedMime = OFFICE_MIME_TYPES.DOCX;
    } else if (ext === ".xlsx" || expectedMime === OFFICE_MIME_TYPES.XLSX) {
      detectedMime = OFFICE_MIME_TYPES.XLSX;
    } else if (ext === ".pptx" || expectedMime === OFFICE_MIME_TYPES.PPTX) {
      detectedMime = OFFICE_MIME_TYPES.PPTX;
    } else {
      detectedMime = "application/zip";
    }
  }
  // Text / CSV (check no null bytes in sample)
  else if (!buffer.includes(0x00)) {
    detectedMime = "text/plain";
  }

  if (expectedMime && expectedMime !== detectedMime && expectedMime !== "application/octet-stream") {
    verified = false;
  }

  return { mime: detectedMime, verified };
}

/** Computes SHA-256 hash of a file */
export async function computeFileSha256(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  const fileBuffer = await fs.readFile(filePath);
  hash.update(fileBuffer);
  return hash.digest("hex");
}

export interface StageArtifactOptions {
  sourcePath: string;
  workspace?: string;
  operationId: string;
  expectedSha256?: string;
  expectedMime?: string;
  principalId?: string;
  targetId?: string;
  sessionToken?: string;
}

/** Stages a user-selected artifact into isolated ingress */
export async function stageUploadArtifact(opts: StageArtifactOptions): Promise<IngressArtifactReceipt> {
  // 1. Anti-replay check
  if (typeof opts.operationId !== "string" || !OPERATION_ID_RE.test(opts.operationId)) {
    throw new Error("SECURE_INGRESS_INVALID_OPERATION_ID: operationId must be 16-128 safe characters.");
  }
  if (usedOperationIds.has(opts.operationId)) {
    throw new Error("SECURE_INGRESS_REPLAY_DETECTED: operationId has already been used.");
  }
  usedOperationIds.add(opts.operationId);

  // 2. Validate path traversal & symlink escape
  const rawPath = opts.sourcePath.trim();
  if (!path.isAbsolute(rawPath)) {
    throw new Error("SECURE_INGRESS_PATH_ERROR: Source path must be an absolute local path.");
  }

  // Realpath verification
  const realSource = await fs.realpath(rawPath).catch(() => {
    throw new Error("SECURE_INGRESS_FILE_NOT_FOUND: Source file does not exist or is inaccessible.");
  });

  const stat = await fs.stat(realSource);
  if (!stat.isFile()) {
    throw new Error("SECURE_INGRESS_INVALID_FILE: Target is not an ordinary file.");
  }
  if (stat.size > MAX_UPLOAD_FILE_BYTES) {
    throw new Error(`SECURE_INGRESS_SIZE_EXCEEDED: File size ${stat.size} exceeds maximum ${MAX_UPLOAD_FILE_BYTES} bytes.`);
  }

  // 3. Check permanent host file-policy
  if (fileRulesRegistered()) {
    const allowed = isPathAllowedByPermanentRegistry(realSource, "read");
    if (!allowed) {
      throw new Error(`SECURE_INGRESS_HOST_POLICY_BLOCKED: Host permanent file policy denies read access to '${realSource}'.`);
    }
  }

  // 4. Magic bytes & MIME verification
  const { mime, verified } = await detectAndValidateMagicBytes(realSource, opts.expectedMime);
  if (!verified) {
    throw new Error(`SECURE_INGRESS_MIME_SPOOF_DETECTED: File magic bytes do not match expected MIME type '${opts.expectedMime}'.`);
  }

  // 5. SHA-256 verification
  const sha256 = await computeFileSha256(realSource);
  if (opts.expectedSha256 && opts.expectedSha256.toLowerCase() !== sha256.toLowerCase()) {
    throw new Error(`SECURE_INGRESS_HASH_MISMATCH: Computed hash ${sha256} does not match expected hash ${opts.expectedSha256}.`);
  }

  // 6. Staging in isolated ingress directory
  const ingressRoot = getIngressRootDir();
  const safeFilename = path.basename(realSource).replace(/[^a-zA-Z0-9._-]/g, "_");
  const stageDir = path.join(ingressRoot, opts.operationId);
  await fs.mkdir(stageDir, { recursive: true });

  const stagedPath = path.join(stageDir, safeFilename);
  await fs.copyFile(realSource, stagedPath);

  const receiptId = `ing_${crypto.randomBytes(12).toString("hex")}`;
  const now = Date.now();
  const receipt: IngressArtifactReceipt = {
    receiptId,
    operationId: opts.operationId,
    sourcePath: realSource,
    stagedPath,
    filename: safeFilename,
    mimeType: mime,
    fileSize: stat.size,
    sha256,
    principalId: opts.principalId,
    targetId: opts.targetId,
    sessionToken: opts.sessionToken,
    createdAt: now,
    expiresAt: now + INGRESS_RETENTION_MS,
  };

  activeReceipts.set(receiptId, receipt);
  return receipt;
}

/** Retrieves an active ingress receipt */
export function getIngressReceipt(receiptId: string): IngressArtifactReceipt | null {
  const receipt = activeReceipts.get(receiptId);
  if (!receipt) return null;
  if (Date.now() > receipt.expiresAt) {
    cleanupIngressReceipt(receiptId);
    return null;
  }
  return receipt;
}

/** Cleans up a staged ingress file and removes receipt */
export async function cleanupIngressReceipt(receiptId: string): Promise<boolean> {
  const receipt = activeReceipts.get(receiptId);
  if (!receipt) return false;
  activeReceipts.delete(receiptId);

  try {
    await fs.unlink(receipt.stagedPath).catch(() => {});
    const stageDir = path.dirname(receipt.stagedPath);
    await fs.rm(stageDir, { recursive: true, force: true }).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

/** Finds an active receipt for one exact, ordinary file under the real ingress root. */
export function getIngressReceiptByStagedPath(filePath: string): IngressArtifactReceipt | null {
  if (!filePath || typeof filePath !== "string") return null;
  try {
    const ingressRoot = syncFs.realpathSync.native(path.resolve(getIngressRootDir()));
    const resolved = path.resolve(filePath);
    const resolvedStat = syncFs.lstatSync(resolved);
    if (resolvedStat.isSymbolicLink() || !resolvedStat.isFile()) return null;
    const resolvedReal = syncFs.realpathSync.native(resolved);
    const relative = path.relative(ingressRoot, resolvedReal);
    if (!relative || relative === "." || relative.startsWith("..") || path.isAbsolute(relative)) return null;
    const normalize = (value: string) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
    const expected = normalize(resolvedReal);
    for (const receipt of activeReceipts.values()) {
      if (receipt.expiresAt < Date.now()) continue;
      const receiptPath = path.resolve(receipt.stagedPath);
      const receiptStat = syncFs.lstatSync(receiptPath);
      if (receiptStat.isSymbolicLink() || !receiptStat.isFile()) continue;
      if (normalize(syncFs.realpathSync.native(receiptPath)) === expected) return receipt;
    }
  } catch {
    return null;
  }
  return null;
}

/** A staged path is usable only by the same authenticated MCP principal and exact tab lease. */
export function isIngressReceiptBoundToSession(
  filePath: string,
  binding: { principalId: string; targetId: string; sessionToken: string },
): boolean {
  if (!binding || !binding.principalId || !binding.targetId || !binding.sessionToken) return false;
  const receipt = getIngressReceiptByStagedPath(filePath);
  return Boolean(receipt && receipt.principalId === binding.principalId &&
    receipt.targetId === binding.targetId && receipt.sessionToken === binding.sessionToken);
}

/** A path is certified only while an active receipt owns that exact staged file. */
export function isCertifiedIngressStagedFile(filePath: string): boolean {
  return getIngressReceiptByStagedPath(filePath) !== null;
}

/**
 * Prunes expired staged ingress files and receipts older than INGRESS_RETENTION_MS.
 * Returns the count of pruned staging directories or receipts.
 */
export async function pruneExpiredIngressStaging(now: number = Date.now()): Promise<number> {
  let prunedCount = 0;

  // 1. Prune in-memory receipts and remove expired files
  for (const [receiptId, receipt] of activeReceipts.entries()) {
    if (now > receipt.expiresAt) {
      activeReceipts.delete(receiptId);
      try {
        await fs.unlink(receipt.stagedPath).catch(() => {});
        const stageDir = path.dirname(receipt.stagedPath);
        await fs.rm(stageDir, { recursive: true, force: true }).catch(() => {});
        prunedCount++;
      } catch {
        // ignore disk errors
      }
    }
  }

  // 2. Scan physical ingress directory for orphaned or stale staging dirs
  const ingressRoot = getIngressRootDir();
  try {
    const entries = await fs.readdir(ingressRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const dirPath = path.join(ingressRoot, entry.name);
        try {
          const stat = await fs.stat(dirPath);
          const age = now - stat.mtimeMs;
          if (age > INGRESS_RETENTION_MS) {
            await fs.rm(dirPath, { recursive: true, force: true });
            prunedCount++;
          }
        } catch {
          // ignore stat/removal errors for individual directory
        }
      }
    }
  } catch {
    // ingressRoot might not exist yet
  }

  return prunedCount;
}

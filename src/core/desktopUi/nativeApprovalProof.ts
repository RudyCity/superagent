/**
 * Core-side, single-use proof that a PRIVATE native Tray dialog approved
 * precisely one application window. The HTTP Core bearer alone must never
 * authorize video capture (including requests from loopback).
 *
 * Local-user trust boundary: a separate 32-byte key resides in the local
 * config directory with owner-only POSIX permissions. It is not exposed to
 * the webview, any HTTP endpoint, MCP, tunnels, or logs. A same-OS-user
 * malicious process is outside this file-key threat boundary: stronger
 * platform keystore/native IPC attestation is still required before remote
 * Desktop Live is enabled.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getRootConfigDir } from "../config/paths.js";
import { DesktopUiError } from "./errors.js";

const KEY_FILE = ".desktop-live-native-approval.key";
const MAX_CHALLENGES = 8;
const CHALLENGE_TTL_MS = 30_000;

function denied(): never {
  throw new DesktopUiError("INPUT_DISABLED", "Native Desktop Live approval is missing or invalid.");
}

function localKey(): Buffer {
  const root = getRootConfigDir();
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(root).isSymbolicLink()) denied();
  const file = path.join(root, KEY_FILE);
  try {
    const fd = fs.openSync(file, "wx", 0o600);
    try {
      fs.writeSync(fd, randomBytes(32).toString("hex") + "\n");
    } finally { fs.closeSync(fd); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 64 || stat.size > 80 ||
      (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) denied();
  const raw = fs.readFileSync(file, "ascii").trim();
  if (!/^[a-f0-9]{64}$/.test(raw)) denied();
  return Buffer.from(raw, "hex");
}

function nativeApprovalMessage(body: Record<string, unknown>, nonce: string): string {
  const pid = body.pid;
  const id = body.nativeId;
  const title = body.expectedTitle;
  const application = body.expectedApplication;
  const bounds = body.expectedBounds;
  if (!Number.isSafeInteger(pid) || Number(pid) <= 0 ||
      typeof id !== "string" || id.length > 256 || !id ||
      typeof title !== "string" || !title || title.length > 512 ||
      typeof application !== "string" || !application || application.length > 256 ||
      !bounds || typeof bounds !== "object" || Array.isArray(bounds)) denied();
  const b = bounds as Record<string, unknown>;
  if (Object.keys(b).length !== 4 || !["x", "y", "width", "height"].every(k =>
    Number.isSafeInteger(b[k])) || Number(b.width) <= 0 || Number(b.height) <= 0) denied();
  const b64 = (value: string) => Buffer.from(value, "utf8").toString("base64url");
  return [
    "desktop-live-native-approval-v1", nonce, String(pid),
    b64(id), b64(title), b64(application),
    ...["x", "y", "width", "height"].map(k => String(b[k])),
  ].join(":");
}

export class NativeDesktopApprovalGuard {
  private pending = new Map<string, number>();
  constructor(
    private readonly key: () => Buffer = localKey,
    private readonly now: () => number = Date.now,
  ) {}

  issue(): { nonce: string; expiresAt: number } {
    // Fail closed if local key cannot be loaded or safely created.
    this.key();
    const now = this.now();
    for (const [nonce, expiry] of this.pending) {
      if (expiry <= now) this.pending.delete(nonce);
    }
    if (this.pending.size >= MAX_CHALLENGES) denied();
    const nonce = randomBytes(24).toString("hex");
    const expiresAt = now + CHALLENGE_TTL_MS;
    this.pending.set(nonce, expiresAt);
    return { nonce, expiresAt };
  }

  consume(raw: unknown): Record<string, unknown> {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) denied();
    const body = raw as Record<string, unknown>;
    const proof = body.approvalProof;
    if (!proof || typeof proof !== "object" || Array.isArray(proof)) denied();
    const record = proof as Record<string, unknown>;
    if (Object.keys(record).length !== 2 ||
        typeof record.nonce !== "string" || !/^[a-f0-9]{48}$/.test(record.nonce) ||
        typeof record.mac !== "string" || !/^[a-f0-9]{64}$/.test(record.mac)) denied();
    const expiry = this.pending.get(record.nonce);
    this.pending.delete(record.nonce); // Burn even a forged proof.
    if (expiry === undefined || this.now() >= expiry) denied();
    const message = nativeApprovalMessage(body, record.nonce);
    const valid = createHmac("sha256", this.key()).update(message).digest();
    const presented = Buffer.from(record.mac, "hex");
    if (!timingSafeEqual(valid, presented)) denied();
    const { approvalProof: _proof, ...start } = body;
    return start;
  }

  /** Public only for test clients exercising the exact native protocol. */
  static computeProofForTest(key: Buffer, target: Record<string, unknown>, nonce: string): string {
    return createHmac("sha256", key).update(nativeApprovalMessage(target, nonce)).digest("hex");
  }
}

export const nativeDesktopApprovalGuard = new NativeDesktopApprovalGuard();

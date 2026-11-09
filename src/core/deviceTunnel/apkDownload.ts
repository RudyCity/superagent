import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface AndroidApkDownloadTicket {
  token: string;
  expiresAt: number;
  size: number;
  sha256: string;
  filename: string;
}

type TicketRecord = AndroidApkDownloadTicket & {
  filePath: string;
};

const TTL_MS = 10 * 60_000;
const MAX_APK_BYTES = 100 * 1024 * 1024;
const tickets = new Map<string, TicketRecord>();

function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
}

export function androidApkPath(): string {
  return path.join(
    repoRoot(),
    "apps",
    "superagent-lan-android",
    "app",
    "build",
    "outputs",
    "apk",
    "debug",
    "app-debug.apk",
  );
}

function inspectApk(): { filePath: string; size: number; sha256: string; filename: string } {
  const filePath = androidApkPath();
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1024 || stat.size > MAX_APK_BYTES)
    throw new Error("Android APK artifact is unavailable or unsafe.");
  const expectedParent = path.resolve(repoRoot(), "apps/superagent-lan-android/app/build/outputs/apk/debug");
  if (path.dirname(path.resolve(filePath)) !== expectedParent)
    throw new Error("Android APK artifact path escaped expected build output.");
  const sha256 = crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  return {
    filePath,
    size: stat.size,
    sha256,
    filename: "SuperAgent-Android-0.9.1-qr-scan-fix.apk",
  };
}

function cleanup(now = Date.now()) {
  for (const [token, ticket] of tickets) {
    if (ticket.expiresAt <= now) tickets.delete(token);
  }
}

export function createAndroidApkDownloadTicket(): AndroidApkDownloadTicket {
  cleanup();
  const apk = inspectApk();
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = Date.now() + TTL_MS;
  const record: TicketRecord = {
    token,
    expiresAt,
    size: apk.size,
    sha256: apk.sha256,
    filename: apk.filename,
    filePath: apk.filePath,
  };
  tickets.set(token, record);
  return {
    token,
    expiresAt,
    size: apk.size,
    sha256: apk.sha256,
    filename: apk.filename,
  };
}

export function getAndroidApkDownloadTicket(token: string): TicketRecord {
  cleanup();
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("APK download ticket is invalid.");
  const record = tickets.get(token);
  if (!record || record.expiresAt <= Date.now()) throw new Error("APK download ticket expired or unknown.");
  const stat = fs.lstatSync(record.filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== record.size)
    throw new Error("APK artifact changed after ticket creation.");
  return record;
}


export function getAndroidApkDownloadTicketStatus(token: string): { valid: boolean; expiresAt: number | null; remainingMs: number } {
  cleanup();
  if (!/^[a-f0-9]{64}$/.test(token)) return { valid: false, expiresAt: null, remainingMs: 0 };
  const record = tickets.get(token);
  if (!record) return { valid: false, expiresAt: null, remainingMs: 0 };
  const remainingMs = Math.max(0, record.expiresAt - Date.now());
  return { valid: remainingMs > 0, expiresAt: record.expiresAt, remainingMs };
}

export function revokeAndroidApkDownloadTicket(token: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(token)) return false;
  return tickets.delete(token);
}

export function resetAndroidApkDownloadTicketsForTests(): void {
  tickets.clear();
}

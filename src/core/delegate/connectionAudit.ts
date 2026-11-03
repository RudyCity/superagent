import fs from "node:fs";
import path from "node:path";
import { getRootConfigDir } from "../config/paths.js";

/**
 * Audit only connection metadata. Never log WS frames, authToken, cookies,
 * request params, message text, headers or full client-provided errors.
 */
export type DelegateAuditEvent =
  | "listener_started"
  | "origin_rejected"
  | "socket_open"
  | "handshake_rejected"
  | "connected"
  | "pairing_accepted"
  | "client_updated"
  | "disconnected"
  | "socket_error"
  | "listener_closed";

export interface DelegateAuditRecord {
  timestamp: string;
  event: DelegateAuditEvent;
  connectionId?: string;
  pid: number;
  listenerPort: number;
  endpoint: string;
  remoteAddress?: string;
  remotePort?: number;
  extensionId?: string;
  clientId?: string;
  profileLabel?: string;
  extensionVersion?: string;
  browserUserAgent?: string;
  authMode?: "pairing_required" | "development_unpaired";
  authVerified?: boolean;
  handshakeDurationMs?: number;
  connectedDurationMs?: number;
  activeProfiles: number;
  openSockets: number;
  pendingRequests: number;
  closeCode?: number;
  reasonCode?: string;
  transportErrorCode?: string;
}

export type DelegateAuditSink = (record: DelegateAuditRecord) => void;

let warned = false;
let pendingWrite: Promise<void> = Promise.resolve();

export async function flushDelegateConnectionAudit(): Promise<void> {
  await pendingWrite;
}

/** Console: connected Chrome profiles only. Disk JSONL: every audit event. */
export const writeDelegateConnectionAudit: DelegateAuditSink = record => {
  const line = JSON.stringify(record);
  // Keep the server terminal readable: print successful connections only.
  // Pairing codes have their own separate [Delegate][PAIR] terminal notice.
  // Rejections, disconnects and transport diagnostics remain in private JSONL.
  if (record.event === "connected") {
    console.info("[Delegate][CONNECTED] " + line);
  }
  try {
    const dir = path.join(getRootConfigDir(), "logs");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const name = "delegate-connections-" + record.timestamp.slice(0, 10) + ".jsonl";
    const filePath = path.join(dir, name);
    // Single sequential append queue preserves event order without blocking
    // WS message handling. close() flushes it before returning.
    pendingWrite = pendingWrite.then(async () => {
      await fs.promises.appendFile(filePath, line + "\n", { encoding: "utf8", mode: 0o600 });
    }).catch((error: NodeJS.ErrnoException) => {
      if (!warned) {
        warned = true;
        console.warn("[Delegate][connection] Audit file write failed:", error.code || "UNKNOWN");
      }
    });
  } catch (error) {
    if (!warned) {
      warned = true;
      console.warn("[Delegate][connection] Audit file unavailable:", error instanceof Error ? error.name : "UNKNOWN");
    }
  }
};

/** Fixed-size fields, stripped of control characters and angle brackets. */
export function safeAuditText(value: unknown, maxLength = 160): string | undefined {
  if (typeof value !== "string") return undefined;
  const safe = value.replace(/[\u0000-\u001f\u007f<>]/g, " ").trim().slice(0, maxLength);
  return safe || undefined;
}

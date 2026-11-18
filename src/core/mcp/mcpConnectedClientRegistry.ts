/**
 * Native operator-only, metadata-only registry of observed MCP connections.
 *
 * This is NOT an authorization store. The source is the authenticated,
 * owner-verified live MCP session inventory, never an MCP tool argument or a
 * client-provided name. One stable opaque credential handle is one observed
 * connection even if multiple sessions share the same public MCP URL.
 *
 * OAuth clientInfo labels are untrusted claims. No access token, token hash,
 * raw OAuth subject, session ID, URL or grant is persisted here.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getRootConfigDir } from "../config/paths.js";

const MAX_CONNECTIONS = 128;
const MAX_FILE_BYTES = 96 * 1024;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const CONNECTION_HANDLE = /^idh_[a-f0-9]{16}$/;
const SESSION_HANDLE = /^ses_[a-f0-9]{12}$/;

export interface TrustedMcpSessionMetadata {
  principalHandle: string;
  sessionHandle: string;
  authMode: "oauth" | "static-bearer";
  claimedClientName: string | null;
  /** Human approved OAuth label bound to the authenticated token. */
  ownerConnectionName?: string | null;
  claimedClientVersion: string | null;
  createdAt: number;
  lastSeenAt: number;
  state: "active" | "idle" | "retiring";
}

export interface RegisteredMcpConnection {
  connectionHandle: string;
  ownerPort: number;
  authMode: "oauth" | "static-bearer";
  reportedClientName: string | null;
  ownerConnectionName?: string | null;
  reportedClientVersion: string | null;
  firstObservedAt: number;
  lastObservedAt: number;
  sessionCount: number;
  status: "connected" | "disconnected";
}

interface ConnectionLedger {
  version: 1;
  connections: RegisteredMcpConnection[];
}

function ledgerPath(): string {
  return path.join(getRootConfigDir(), "mcp-connected-clients.json");
}

function safeName(value: string | null, maxLength: number): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new Error("Invalid MCP client label");
  const name = value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/\s+/g, " ").trim();
  return name && name.length <= maxLength ? name : null;
}

function validTimestamp(value: number, now: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= now + 1000;
}

function validateRecord(value: RegisteredMcpConnection, now: number): boolean {
  return Boolean(value && CONNECTION_HANDLE.test(value.connectionHandle) &&
    Number.isSafeInteger(value.ownerPort) && value.ownerPort >= 1024 && value.ownerPort <= 65535 &&
    ["oauth", "static-bearer"].includes(value.authMode) &&
    (value.reportedClientName === null ||
      (typeof value.reportedClientName === "string" && value.reportedClientName.length <= 64 &&
        safeName(value.reportedClientName, 64) === value.reportedClientName)) &&
    (value.ownerConnectionName === undefined || value.ownerConnectionName === null ||
      (typeof value.ownerConnectionName === "string" && value.ownerConnectionName.length <= 64 &&
        safeName(value.ownerConnectionName,64) === value.ownerConnectionName)) &&
    (value.reportedClientVersion === null ||
      (typeof value.reportedClientVersion === "string" && value.reportedClientVersion.length <= 32 &&
        safeName(value.reportedClientVersion, 32) === value.reportedClientVersion)) &&
    validTimestamp(value.firstObservedAt, now) &&
    validTimestamp(value.lastObservedAt, now) &&
    value.firstObservedAt <= value.lastObservedAt &&
    Number.isSafeInteger(value.sessionCount) && value.sessionCount >= 0 && value.sessionCount <= 64 &&
    ["connected", "disconnected"].includes(value.status));
}

function readLedger(now: number, targetPath = ledgerPath()): ConnectionLedger {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, connections: [] };
    }
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 ||
      stat.size > MAX_FILE_BYTES) {
    throw new Error("Unsafe MCP connected-client ledger");
  }
  const data = JSON.parse(fs.readFileSync(targetPath, "utf8")) as ConnectionLedger;
  if (data?.version !== 1 || !Array.isArray(data.connections) ||
      data.connections.length > MAX_CONNECTIONS ||
      !data.connections.every(value => validateRecord(value, now))) {
    throw new Error("Invalid MCP connected-client ledger");
  }
  const identities = new Set(data.connections.map(value =>
    value.ownerPort + ":" + value.connectionHandle));
  if (identities.size !== data.connections.length) {
    throw new Error("Duplicate MCP connected-client ledger records");
  }
  return data;
}

function writeLedger(ledger: ConnectionLedger, targetPath = ledgerPath()): void {
  const directory = path.dirname(targetPath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    const stat = fs.lstatSync(targetPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw new Error("Unsafe MCP connected-client ledger destination");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const bytes = JSON.stringify(ledger) + "\n";
  if (Buffer.byteLength(bytes) > MAX_FILE_BYTES) throw new Error("MCP connection ledger exceeds limit");
  const temp = targetPath + "." + process.pid + "." + crypto.randomUUID() + ".tmp";
  try {
    fs.writeFileSync(temp, bytes, { flag: "wx", encoding: "utf8", mode: 0o600 });
    // Check again before replacing to prevent following a newly-added link.
    try {
      const stat = fs.lstatSync(targetPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
        throw new Error("Unsafe MCP connected-client ledger replacement");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    fs.renameSync(temp, targetPath);
  } catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch { /* best effort */ }
    throw error;
  }
}

/**
 * Reconcile one COMPLETE, authenticated and fresh owner inventory.
 * An unavailable owner must never be passed as an empty array.
 */
export function reconcileVerifiedMcpConnections(
  ownerPort: number,
  sessions: readonly TrustedMcpSessionMetadata[],
  now = Date.now(),
  customPath?: string,
): RegisteredMcpConnection[] {
  if (!Number.isSafeInteger(ownerPort) || ownerPort < 1024 || ownerPort > 65535 ||
      !Array.isArray(sessions) || sessions.length > 64 || !validTimestamp(now, now)) {
    throw new Error("Invalid verified MCP connection inventory");
  }
  const sessionIds = new Set<string>();
  const grouped = new Map<string, { entry: TrustedMcpSessionMetadata; count: number }>();
  for (const session of sessions) {
    if (!session || !CONNECTION_HANDLE.test(session.principalHandle) ||
        !SESSION_HANDLE.test(session.sessionHandle) || sessionIds.has(session.sessionHandle) ||
        !["oauth", "static-bearer"].includes(session.authMode) ||
        !["active", "idle", "retiring"].includes(session.state) ||
        !validTimestamp(session.createdAt, now) || !validTimestamp(session.lastSeenAt, now) ||
        session.lastSeenAt < session.createdAt) {
      throw new Error("Invalid verified MCP connection session");
    }
    sessionIds.add(session.sessionHandle);
    const reportedClientName = safeName(session.claimedClientName, 64);
    const ownerConnectionName = safeName(session.ownerConnectionName ?? null, 64);
    if (session.ownerConnectionName != null &&
        ownerConnectionName !== session.ownerConnectionName)
      throw new Error("Invalid owner MCP connection label");
    const reportedClientVersion = safeName(session.claimedClientVersion, 32);
    const prior = grouped.get(session.principalHandle);
    if (prior && prior.entry.authMode !== session.authMode) {
      throw new Error("Conflicting MCP connection authentication modes");
    }
    if (!prior) {
      grouped.set(session.principalHandle, {
        entry: { ...session, ownerConnectionName, claimedClientName: reportedClientName, claimedClientVersion: reportedClientVersion },
        count: 1,
      });
    } else {
      prior.count++;
      if (session.lastSeenAt >= prior.entry.lastSeenAt) {
        prior.entry = { ...session, ownerConnectionName, claimedClientName: reportedClientName, claimedClientVersion: reportedClientVersion };
      }
    }
  }

  const ledger = readLedger(now, customPath);
  const known = new Map(ledger.connections.map(item =>
    [item.ownerPort + ":" + item.connectionHandle, item]));
  for (const item of ledger.connections) {
    if (item.ownerPort === ownerPort) {
      item.status = "disconnected";
      item.sessionCount = 0;
    }
  }
  for (const [connectionHandle, { entry, count }] of grouped) {
    const key = ownerPort + ":" + connectionHandle;
    const previous = known.get(key);
    const registered: RegisteredMcpConnection = {
      connectionHandle, ownerPort,
      authMode: entry.authMode,
      reportedClientName: entry.claimedClientName ?? previous?.reportedClientName ?? null,
      ownerConnectionName: entry.ownerConnectionName ?? previous?.ownerConnectionName ?? null,
      reportedClientVersion: entry.claimedClientVersion ?? previous?.reportedClientVersion ?? null,
      firstObservedAt: previous?.firstObservedAt ?? now,
      lastObservedAt: now,
      sessionCount: count,
      status: "connected",
    };
    if (previous) Object.assign(previous, registered);
    else ledger.connections.push(registered);
  }
  ledger.connections = ledger.connections.filter(item =>
    item.status === "connected" || now - item.lastObservedAt <= RETENTION_MS);
  ledger.connections.sort((a, b) =>
    Number(b.status === "connected") - Number(a.status === "connected") ||
    b.lastObservedAt - a.lastObservedAt);
  ledger.connections = ledger.connections.slice(0, MAX_CONNECTIONS);
  writeLedger(ledger, customPath);
  return ledger.connections.filter(item => item.ownerPort === ownerPort).map(item => ({ ...item }));
}

/** History is explicitly unverified while live owner status is unavailable. */
export function listLastObservedMcpConnections(
  ownerPort: number,
  now = Date.now(),
  customPath?: string,
): RegisteredMcpConnection[] {
  if (!Number.isSafeInteger(ownerPort) || ownerPort < 1024 || ownerPort > 65535) return [];
  return readLedger(now, customPath).connections
    .filter(item => item.ownerPort === ownerPort && now - item.lastObservedAt <= RETENTION_MS)
    .map(item => ({ ...item, status: "disconnected", sessionCount: 0 }));
}

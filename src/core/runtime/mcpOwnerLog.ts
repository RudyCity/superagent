/**
 * MCP owner lifecycle journal, deliberately separate from the MCP request
 * audit. Write a bounded event allowlist; never persist OAuth credentials,
 * bearer tokens, message bodies, arbitrary error strings or HTTP headers.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EVENT_NAMES = [
  "owner_started",
  "backend_reload_started",
  "backend_reload_succeeded",
  "backend_reload_failed",
  "owner_stopping",
  "bootstrap_rotated",
  "bootstrap_consumed",
  "bootstrap_invalidated_on_crash",
] as const;
export type McpOwnerEventName = typeof EVENT_NAMES[number];

export interface McpOwnerLogEvent {
  at: string;
  event: McpOwnerEventName;
  ownerPid: number;
  backendPid?: number;
  previousBackendPid?: number;
  durationMs?: number;
  code?: string;
}
const MAX_BYTES = 256 * 1024;
const MAX_TAIL = 100;
// Never journal arbitrary error messages, even when they look like codes.
const SAFE_ERROR_CODES = new Set([
  "MCP_BACKEND_RELOAD_FAILED",
  "MCP_RELOAD_FAILED",
  "MCP_RELOAD_BUSY_OR_DRAINING",
  "MCP_RELOAD_NO_BACKEND",
  "MCP_RELOAD_OAUTH_NOT_PERSISTENT",
  "MCP_RELOAD_NEW_BACKEND_OAUTH_NOT_PERSISTENT",
  "MCP_RELOAD_OWNER_DRAINING",
  "MCP_RELOAD_LEGACY_OWNER",
  "MCP_RELOAD_NO_MANAGED_OWNER",
]);

function assertPort(port: number): void {
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
    throw new Error("Invalid MCP lifecycle log port");
  }
}

export function mcpOwnerLogPath(port: number): string {
  assertPort(port);
  return path.join(os.homedir(), ".superagent-r", `mcp-owner-${port}-events.jsonl`);
}

function assertSafeFile(file: string): void {
  if (!fs.existsSync(file)) return;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error("Unsafe MCP owner log file");
  }
}

export function appendMcpOwnerLog(
  port: number,
  event: McpOwnerEventName,
  fields: {
    ownerPid: number;
    backendPid?: number;
    previousBackendPid?: number;
    durationMs?: number;
    code?: string;
  },
): void {
  const file = mcpOwnerLogPath(port);
  if (!EVENT_NAMES.includes(event) || !Number.isSafeInteger(fields.ownerPid) ||
      fields.ownerPid <= 0) throw new Error("Invalid MCP owner lifecycle event");
  const record: McpOwnerLogEvent = {
    at: new Date().toISOString(), event, ownerPid: fields.ownerPid,
  };
  for (const name of ["backendPid", "previousBackendPid", "durationMs"] as const) {
    const value = fields[name];
    if (Number.isSafeInteger(value) && Number(value) >= 0) record[name] = value;
  }
  if (typeof fields.code === "string" && SAFE_ERROR_CODES.has(fields.code)) {
    record.code = fields.code;
  }
  fs.mkdirSync(path.dirname(file), {recursive:true,mode:0o700});
  assertSafeFile(file);
  if (fs.existsSync(file) && fs.statSync(file).size >= MAX_BYTES) {
    const archive = file + ".1";
    assertSafeFile(archive);
    fs.rmSync(archive, {force:true});
    fs.renameSync(file, archive);
  }
  fs.appendFileSync(file, JSON.stringify(record) + "\n", {
    encoding: "utf8", mode:0o600,
  });
}

export function readMcpOwnerLogs(port: number, tail = 20): McpOwnerLogEvent[] {
  const file = mcpOwnerLogPath(port);
  if (!Number.isSafeInteger(tail) || tail < 1 || tail > MAX_TAIL) {
    throw new Error("MCP lifecycle log tail must be 1..100");
  }
  assertSafeFile(file);
  if (!fs.existsSync(file)) return [];
  const stat = fs.statSync(file);
  const length = Math.min(stat.size, MAX_BYTES);
  const fd = fs.openSync(file, "r");
  let raw = "";
  try {
    const buffer = Buffer.alloc(length);
    const bytes = fs.readSync(fd, buffer, 0, length, stat.size - length);
    raw = buffer.toString("utf8", 0, bytes);
  } finally { fs.closeSync(fd); }
  // The beginning may be a partial line when tail-reading a rotated file.
  const lines = raw.split("\n");
  if (stat.size > length) lines.shift();
  const events: McpOwnerLogEvent[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const v = parsed as Record<string, unknown>;
      if (typeof v.at !== "string" || !EVENT_NAMES.includes(v.event as McpOwnerEventName) ||
          !Number.isSafeInteger(v.ownerPid) || Number(v.ownerPid) <= 0) continue;
      const event: McpOwnerLogEvent = {
        at: v.at.slice(0, 40),
        event: v.event as McpOwnerEventName,
        ownerPid: Number(v.ownerPid),
      };
      for (const key of ["backendPid", "previousBackendPid", "durationMs"] as const) {
        if (Number.isSafeInteger(v[key]) && Number(v[key]) >= 0) event[key] = Number(v[key]);
      }
      if (typeof v.code === "string" && SAFE_ERROR_CODES.has(v.code)) {
        event.code = v.code;
      }
      events.push(event);
    } catch { /* ignore malformed/truncated events, never expose raw content */ }
  }
  return events.slice(-tail);
}

export function formatMcpOwnerLogs(port: number, tail = 20): string {
  const events = readMcpOwnerLogs(port, tail);
  if (!events.length) return `MCP lifecycle log (port ${port}): no reloadable-owner events. Legacy owners do not emit this journal.\nUse /mcp tunnel status to inspect its current owner.`;
  return [
    `MCP lifecycle log (port ${port}, latest ${events.length}):`,
    ...events.map(e => [
      e.at, e.event,
      `owner=${e.ownerPid}`,
      e.backendPid !== undefined ? `backend=${e.backendPid}` : "",
      e.previousBackendPid !== undefined ? `previous=${e.previousBackendPid}` : "",
      e.durationMs !== undefined ? `duration=${e.durationMs}ms` : "",
      e.code ? `code=${e.code}` : "",
    ].filter(Boolean).join(" | ")),
    "Private MCP tool-call audit remains separate from this lifecycle log.",
  ].join("\n");
}

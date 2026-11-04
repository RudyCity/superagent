/**
 * Authenticated, read-only desktop Connection Logs provider.
 * Aggregates, parses, filters, searches, and paginates inbound and outbound
 * connection logs across Chrome Delegate WebSocket sessions, MCP tool activities,
 * OAuth handshakes, Cloudflare/OpenAI tunnels, and Core server HTTP requests.
 *
 * Never exposes bearer credentials, session secrets, or full message bodies.
 */

import fs from "node:fs";
import path from "node:path";
import { getRootConfigDir } from "../config/paths.js";

export interface DesktopConnectionLogEntry {
  id: string;
  timestamp: number;
  timestampIso: string;
  source: "delegate" | "mcp" | "oauth" | "tunnel" | "server";
  sourceLabel: string;
  direction: "in" | "out" | "event";
  event: string;
  endpoint: string;
  remoteAddress?: string;
  clientId?: string;
  status: "success" | "info" | "warn" | "error";
  durationMs?: number;
  detail: string;
  rawJson?: string;
}

export interface DesktopConnectionLogsQuery {
  page?: number;
  pageSize?: number;
  search?: string;
  source?: string;
  direction?: string;
  status?: string;
  timeRange?: string;
  sortBy?: "timestamp" | "source" | "direction" | "event" | "endpoint" | "status" | "duration";
  sortOrder?: "asc" | "desc";
}

export interface DesktopConnectionLogsResponse {
  items: DesktopConnectionLogEntry[];
  totalCount: usizeOrNumber;
  page: number;
  pageSize: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
  sourceStats: Record<string, number>;
  directionStats: Record<string, number>;
  statusStats: Record<string, number>;
}

type usizeOrNumber = number;

function readTailLines(filePath: string, maxBytes = 1024 * 1024): string[] {
  if (!fs.existsSync(filePath)) return [];
  try {
    const stats = fs.statSync(filePath);
    const size = stats.size;
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(filePath, "r");
    fs.readSync(fd, buffer, 0, length, start);
    fs.closeSync(fd);

    const str = buffer.toString("utf8");
    const lines = str.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (start > 0 && lines.length > 0) {
      lines.shift();
    }
    return lines;
  } catch {
    return [];
  }
}

export function collectAllConnectionLogs(configDir = getRootConfigDir()): DesktopConnectionLogEntry[] {
  const entries: DesktopConnectionLogEntry[] = [];
  const now = Date.now();

  // 1. Chrome Delegate logs
  const logsDir = path.join(configDir, "logs");
  if (fs.existsSync(logsDir)) {
    try {
      const files = fs.readdirSync(logsDir)
        .filter(n => n.startsWith("delegate-connections-") && n.endsWith(".jsonl"))
        .sort()
        .reverse()
        .slice(0, 7);

      for (const file of files) {
        const lines = readTailLines(path.join(logsDir, file));
        for (const line of lines) {
          try {
            const v = JSON.parse(line);
            const tsStr = String(v.timestamp || "");
            const ts = tsStr ? new Date(tsStr).getTime() : now;
            const event = String(v.event || "unknown");
            const connId = v.connectionId ? String(v.connectionId) : undefined;
            const endpoint = String(v.endpoint || "ws://127.0.0.1:17341");
            const remoteIp = v.remoteAddress ? String(v.remoteAddress) : undefined;
            const remotePort = typeof v.remotePort === "number" ? v.remotePort : undefined;
            const remoteAddr = remoteIp ? (remotePort ? `${remoteIp}:${remotePort}` : remoteIp) : undefined;
            const clientId = v.clientId ? String(v.clientId) : undefined;
            const duration = typeof v.connectedDurationMs === "number" ? v.connectedDurationMs : v.handshakeDurationMs;

            let direction: "in" | "out" | "event" = "event";
            let status: "success" | "info" | "warn" | "error" = "info";
            let detail = `Event: ${event}`;

            switch (event) {
              case "listener_started":
                direction = "event";
                status = "info";
                detail = `WebSocket listener started on port ${v.listenerPort || 17341}`;
                break;
              case "socket_open":
                direction = "in";
                status = "info";
                detail = `Inbound WebSocket opened from ${remoteAddr || "unknown"}`;
                break;
              case "connected":
                direction = "in";
                status = "success";
                detail = `Client authenticated: ${v.profileLabel || "Delegate"} (${clientId || "no-client-id"})`;
                break;
              case "handshake_rejected":
                direction = "in";
                status = "error";
                detail = `Handshake rejected: ${v.reasonCode || "AUTH_FAILED"}`;
                break;
              case "origin_rejected":
                direction = "in";
                status = "warn";
                detail = "Rejected WebSocket handshake due to untrusted origin";
                break;
              case "disconnected":
                direction = "event";
                status = "info";
                detail = `Disconnected: ${v.reasonCode || "CLOSED"} (code ${v.closeCode || 1000})`;
                break;
              case "socket_error":
                direction = "event";
                status = "error";
                detail = `Socket transport error: ${v.transportErrorCode || "UNKNOWN"}`;
                break;
            }

            entries.push({
              id: `del_${ts}_${connId || "evt"}`,
              timestamp: ts,
              timestampIso: tsStr || new Date(ts).toISOString(),
              source: "delegate",
              sourceLabel: "Chrome Delegate",
              direction,
              event,
              endpoint,
              remoteAddress: remoteAddr,
              clientId,
              status,
              durationMs: duration,
              detail,
              rawJson: line,
            });
          } catch {}
        }
      }
    } catch {}
  }

  // 2. MCP Activity
  const mcpActivityFile = path.join(configDir, "mcp-activity.jsonl");
  if (fs.existsSync(mcpActivityFile)) {
    const lines = readTailLines(mcpActivityFile);
    for (const line of lines) {
      try {
        const v = JSON.parse(line);
        const ts = Number(v.ts) || now;
        const pid = Number(v.pid) || 0;
        const evt = v.event || {};
        const evtType = String(evt.type || "event");
        const toolName = String(evt.tool || "");
        const ok = evt.ok !== false;
        const duration = typeof evt.durationMs === "number" ? evt.durationMs : undefined;
        const chatLine = String(v.chatLine || "");

        const isToolCall = evtType === "tool_call";
        const direction: "in" | "out" | "event" = isToolCall ? "out" : "event";
        const status: "success" | "info" | "warn" | "error" = isToolCall ? (ok ? "success" : "error") : "info";
        const endpoint = isToolCall ? `mcp://tools/${toolName}` : `mcp://pid/${pid}`;
        const eventName = isToolCall ? `tool_call:${toolName}` : evtType;
        const detail = isToolCall
          ? (chatLine ? chatLine.split("\n")[0] : `Invoked tool ${toolName}`)
          : "MCP event dispatched";

        entries.push({
          id: `mcp_${ts}_${toolName}`,
          timestamp: ts,
          timestampIso: new Date(ts).toISOString(),
          source: "mcp",
          sourceLabel: "MCP Activity",
          direction,
          event: eventName,
          endpoint,
          clientId: `pid:${pid}`,
          status,
          durationMs: duration,
          detail,
          rawJson: line,
        });
      } catch {}
    }
  }

  // 3. MCP OAuth
  const mcpOAuthFile = path.join(configDir, "mcp-oauth-audit.jsonl");
  if (fs.existsSync(mcpOAuthFile)) {
    const lines = readTailLines(mcpOAuthFile);
    for (const line of lines) {
      try {
        const v = JSON.parse(line);
        const tsStr = String(v.timestamp || "");
        const ts = tsStr ? new Date(tsStr).getTime() : now;
        const pid = Number(v.pid) || 0;
        const stage = String(v.stage || "oauth_stage");
        const method = String(v.method || "POST");
        const statusCode = Number(v.statusCode) || 200;
        const duration = typeof v.durationMs === "number" ? v.durationMs : undefined;

        entries.push({
          id: `oauth_${ts}_${pid}`,
          timestamp: ts,
          timestampIso: tsStr || new Date(ts).toISOString(),
          source: "oauth",
          sourceLabel: "OAuth Flow",
          direction: "in",
          event: stage,
          endpoint: `${method} /${stage}`,
          clientId: `pid:${pid}`,
          status: statusCode < 400 ? "success" : "error",
          durationMs: duration,
          detail: `HTTP ${statusCode} - ${stage} (${duration || 0}ms)`,
          rawJson: line,
        });
      } catch {}
    }
  }

  // 4. Server log
  const serverLogFile = path.join(configDir, "superagent-server.log");
  if (fs.existsSync(serverLogFile)) {
    const lines = readTailLines(serverLogFile);
    for (const line of lines) {
      if (line.startsWith("[")) {
        const closeIdx = line.indexOf("]");
        if (closeIdx > 0) {
          const tsStr = line.slice(1, closeIdx);
          const ts = new Date(tsStr).getTime() || now;
          const rest = line.slice(closeIdx + 1).trim();

          if (rest.startsWith("[Request]")) {
            const reqText = rest.replace("[Request]", "").trim();
            const parts = reqText.split(/\s+/);
            const method = parts[0] || "GET";
            const pathName = parts[1] || "/";

            entries.push({
              id: `req_${ts}_${pathName.replace(/\//g, "_")}`,
              timestamp: ts,
              timestampIso: tsStr,
              source: "server",
              sourceLabel: "Core Server",
              direction: "in",
              event: "http_request",
              endpoint: `${method} ${pathName}`,
              remoteAddress: "127.0.0.1",
              status: "info",
              detail: `Inbound HTTP request: ${method} ${pathName}`,
              rawJson: line,
            });
          } else if (rest.startsWith("[Response]")) {
            const respText = rest.replace("[Response]", "").trim();
            const statusMatch = respText.match(/Status:\s*(\d+)/);
            const statusCode = statusMatch ? Number(statusMatch[1]) : 200;

            entries.push({
              id: `resp_${ts}_${statusCode}`,
              timestamp: ts,
              timestampIso: tsStr,
              source: "server",
              sourceLabel: "Core Server",
              direction: "out",
              event: "http_response",
              endpoint: `Status ${statusCode}`,
              remoteAddress: "127.0.0.1",
              status: statusCode >= 400 ? "error" : "success",
              detail: `Outbound HTTP response status: ${statusCode}`,
              rawJson: line,
            });
          }
        }
      }
    }
  }

  // 5. Bridge log
  const bridgeLogFile = path.join(configDir, "bridge.log");
  if (fs.existsSync(bridgeLogFile)) {
    const lines = readTailLines(bridgeLogFile);
    for (const line of lines) {
      if (line.startsWith("[")) {
        const closeIdx = line.indexOf("]");
        if (closeIdx > 0) {
          const tsStr = line.slice(1, closeIdx);
          const ts = new Date(tsStr).getTime() || now;
          const rest = line.slice(closeIdx + 1).trim();

          if (rest.includes("[BRIDGE]")) {
            const msg = rest.replace("[BRIDGE]", "").trim();
            const isWarn = msg.includes("Exit Hook") || msg.includes("Closed");
            const isSuccess = msg.includes("Listening") || msg.includes("Started");

            entries.push({
              id: `bridge_${ts}`,
              timestamp: ts,
              timestampIso: tsStr,
              source: "tunnel",
              sourceLabel: "Tunnel Bridge",
              direction: "event",
              event: "bridge_lifecycle",
              endpoint: "ws://127.0.0.1:9223",
              status: isWarn ? "warn" : isSuccess ? "success" : "info",
              detail: msg,
              rawJson: line,
            });
          }
        }
      }
    }
  }

  return entries;
}

export function queryConnectionLogs(
  query: DesktopConnectionLogsQuery = {},
  configDir = getRootConfigDir(),
): DesktopConnectionLogsResponse {
  let all = collectAllConnectionLogs(configDir);
  const now = Date.now();

  const sourceStats: Record<string, number> = {};
  const directionStats: Record<string, number> = {};
  const statusStats: Record<string, number> = {};

  for (const item of all) {
    sourceStats[item.source] = (sourceStats[item.source] || 0) + 1;
    directionStats[item.direction] = (directionStats[item.direction] || 0) + 1;
    statusStats[item.status] = (statusStats[item.status] || 0) + 1;
  }

  // Filter: Source
  if (query.source && query.source !== "all") {
    all = all.filter(item => item.source.toLowerCase() === query.source!.toLowerCase());
  }

  // Filter: Direction
  if (query.direction && query.direction !== "all") {
    all = all.filter(item => item.direction.toLowerCase() === query.direction!.toLowerCase());
  }

  // Filter: Status
  if (query.status && query.status !== "all") {
    all = all.filter(item => item.status.toLowerCase() === query.status!.toLowerCase());
  }

  // Filter: Time Range
  if (query.timeRange) {
    if (query.timeRange === "1h") {
      const threshold = now - 3600 * 1000;
      all = all.filter(item => item.timestamp >= threshold);
    } else if (query.timeRange === "24h") {
      const threshold = now - 86400 * 1000;
      all = all.filter(item => item.timestamp >= threshold);
    } else if (query.timeRange === "7d") {
      const threshold = now - 7 * 86400 * 1000;
      all = all.filter(item => item.timestamp >= threshold);
    }
  }

  // Filter: Text Search
  if (query.search && query.search.trim()) {
    const needle = query.search.trim().toLowerCase();
    all = all.filter(item => (
      item.event.toLowerCase().includes(needle) ||
      item.endpoint.toLowerCase().includes(needle) ||
      item.detail.toLowerCase().includes(needle) ||
      item.sourceLabel.toLowerCase().includes(needle) ||
      (item.clientId && item.clientId.toLowerCase().includes(needle)) ||
      (item.remoteAddress && item.remoteAddress.toLowerCase().includes(needle))
    ));
  }

  // Sorting
  const sortBy = query.sortBy || "timestamp";
  const isAsc = query.sortOrder === "asc";

  all.sort((a, b) => {
    let cmp = 0;
    if (sortBy === "source") cmp = a.source.localeCompare(b.source);
    else if (sortBy === "direction") cmp = a.direction.localeCompare(b.direction);
    else if (sortBy === "event") cmp = a.event.localeCompare(b.event);
    else if (sortBy === "endpoint") cmp = a.endpoint.localeCompare(b.endpoint);
    else if (sortBy === "status") cmp = a.status.localeCompare(b.status);
    else if (sortBy === "duration") cmp = (a.durationMs || 0) - (b.durationMs || 0);
    else cmp = a.timestamp - b.timestamp;

    return isAsc ? cmp : -cmp;
  });

  const totalCount = all.length;
  const pageSize = Math.min(Math.max(Number(query.pageSize) || 25, 1), 100);
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const page = Math.min(Math.max(Number(query.page) || 1, 1), totalPages);

  const start = (page - 1) * pageSize;
  const end = Math.min(start + pageSize, totalCount);
  const items = all.slice(start, end);

  return {
    items,
    totalCount,
    page,
    pageSize,
    totalPages,
    hasNext: page < totalPages,
    hasPrev: page > 1,
    sourceStats,
    directionStats,
    statusStats,
  };
}

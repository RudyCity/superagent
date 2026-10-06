/**
 * mcpHttpTransport.ts - MCP over Streamable HTTP (tunnel mode).
 *
 * Exposes the Superagent MCP server over HTTP so it can be reached through
 * a Cloudflare quick tunnel by remote MCP clients.
 *
 * SECURITY MODEL (read before changing):
 * - Binds ONLY to 127.0.0.1. The tunnel is the sole network exposure.
 * - Every request requires `Authorization: Bearer <token>` (constant-time
 *   comparison). Tokens are NEVER accepted via query params (they leak into
 *   logs) and NEVER written to disk/logs by this module.
 * - Tool allowlist: by default only read-only ("safe") tools are exposed.
 *   Dangerous tools (command execution, file writes, agent control, ...)
 *   require explicit opt-in (`allowDangerous: true`, i.e. `--allow-dangerous`).
 * - Every tool invocation is appended to an audit log (JSONL).
 * - Treat the tunnel URL as PUBLIC. Security comes solely from the bearer.
 */

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  createSuperagentMcpServer,
  type McpServerOptions,
} from "./superagentMcpServer.js";

/**
 * Tool classification for the tunnel allowlist.
 * "safe"      = read-only observability; exposed by default.
 * "dangerous" = can execute commands, mutate files/state, control agents;
 *               requires explicit opt-in.
 */
export const MCP_TOOL_CLASSIFICATION: Record<string, "safe" | "dangerous"> = {
  // ---- safe: read-only ----
  superagent_list_active: "safe",
  superagent_get_process_status: "safe",
  superagent_get_status: "safe",
  superagent_get_logs: "safe",
  superagent_read_file: "safe",
  superagent_list_files: "safe",
  superagent_grep_search: "safe",
  superagent_find_files: "safe",
  superagent_get_config: "safe",
  superagent_get_workspace: "safe",
  superagent_get_current_task: "safe",
  superagent_get_instance_task: "safe",
  superagent_get_plan_and_tasks: "safe",
  superagent_memory_search: "safe",
  superagent_query_history: "safe",
  superagent_get_token_usage: "safe",
  superagent_server_health: "safe",
  superagent_export_session: "safe",
  // ---- dangerous: mutation / execution / control ----
  superagent_exec_command: "dangerous", // arbitrary command execution (RCE)
  superagent_write_file: "dangerous",
  superagent_interrupt: "dangerous",
  superagent_pause: "dangerous",
  superagent_resume: "dangerous",
  superagent_send_message: "dangerous",
  superagent_run_task: "dangerous",
  superagent_spawn_subagent: "dangerous",
  superagent_invoke: "dangerous",
  superagent_cli_bridge: "dangerous",
  superagent_await: "dangerous",
  superagent_merge: "dangerous",
  superagent_manage: "dangerous",
  superagent_manage_worktrees: "dangerous",
  superagent_update_tasks: "dangerous",
  superagent_memory_save: "dangerous", // persistent memory poisoning risk
  superagent_switch_preset: "dangerous",
  superagent_switch_provider: "dangerous",
  superagent_switch_workspace: "dangerous",
  superagent_compact_context: "dangerous",
  superagent_remote_chrome: "dangerous",
};

export function getDefaultSafeTools(): string[] {
  return Object.entries(MCP_TOOL_CLASSIFICATION)
    .filter(([, level]) => level === "safe")
    .map(([name]) => name);
}

/** 256-bit bearer token (64 hex chars). Generate fresh per tunnel session. */
export function generateMcpBearerToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function isAuthorized(req: http.IncomingMessage, expectedToken: string): boolean {
  const header = req.headers["authorization"];
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const provided = Buffer.from(header.slice(7), "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
}

function summarizeArgs(args: unknown): string {
  try {
    const s = JSON.stringify(args) ?? "<undefined>";
    return s.length > 500 ? s.slice(0, 500) + "\u2026(truncated)" : s;
  } catch {
    return "<unserializable>";
  }
}
export type McpAuditInfo = {
  tool: string;
  args: unknown;
  ok: boolean;
  error?: string;
  durationMs?: number;
};

/** Append-only JSONL audit logger. Never throws (must not break tool calls). */
export function createMcpAuditLogger(logPath: string): (info: McpAuditInfo) => void {
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
  } catch {
    /* ignore */
  }
  return (info: McpAuditInfo) => {
    try {
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        tool: info.tool,
        args: summarizeArgs(info.args),
        ok: info.ok,
        error: info.error,
        durationMs: info.durationMs,
      });
      fs.appendFileSync(logPath, line + "\n", "utf8");
    } catch {
      /* audit logging must never break tool execution */
    }
  };
}

function readJsonBody(req: http.IncomingMessage, maxBytes = 16 * 1024 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

export interface McpHttpServerOptions {
  port: number;
  bearerToken: string;
  allowDangerous: boolean;
  auditLogPath?: string;
}

export interface McpHttpServerHandle {
  /** Local URL of the MCP endpoint, e.g. http://127.0.0.1:9227/mcp */
  url: string;
  /** Actual bound port (useful when port 0 was requested). */
  port: number;
  close: () => Promise<void>;
}

export const MCP_HTTP_PATH = "/mcp";

export async function startMcpHttpServer(opts: McpHttpServerOptions): Promise<McpHttpServerHandle> {
  if (!opts.bearerToken || opts.bearerToken.length < 32) {
    throw new Error("MCP bearer token must be at least 32 characters (use generateMcpBearerToken()).");
  }
  const allowedTools = opts.allowDangerous ? undefined : getDefaultSafeTools();
  const auditLogPath = opts.auditLogPath || path.join(os.homedir(), ".superagent-r", "mcp-audit.log");
  const audit = createMcpAuditLogger(auditLogPath);

  const mcpServer = createSuperagentMcpServer({ allowedTools, onToolCall: audit } as McpServerOptions);
  // Stateful mode: the SDK requires a fresh transport per request in stateless
  // mode, so we use session IDs (standard MCP flow). The Bearer token remains
  // the access control - a session ID alone grants nothing without it.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
  });
  await mcpServer.connect(transport);

  const httpServer = http.createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url || "/", "http://127.0.0.1").pathname;
      if (pathname !== MCP_HTTP_PATH) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }
      if (req.method !== "POST" && req.method !== "GET" && req.method !== "DELETE") {
        res.writeHead(405, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "method not allowed" }));
        return;
      }
      if (!isAuthorized(req, opts.bearerToken)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32000, message: "Unauthorized: valid Bearer token required" },
          })
        );
        return;
      }
      let body: unknown = undefined;
      if (req.method === "POST") {
        try {
          body = await readJsonBody(req);
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid JSON body" }));
          return;
        }
      }
      await transport.handleRequest(req, res, body);
    } catch {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "internal server error" }));
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    // SECURITY: bind loopback only. The Cloudflare tunnel is the sole network exposure.
    httpServer.listen(opts.port, "127.0.0.1", () => {
      httpServer.removeListener("error", reject);
      resolve();
    });
  });

  const boundPort = (httpServer.address() as any)?.port ?? opts.port;
  return {
    url: `http://127.0.0.1:${boundPort}${MCP_HTTP_PATH}`,
    port: boundPort,
    close: () =>
      new Promise<void>((resolve) => {
        transport.close().finally(() => {
          httpServer.close(() => resolve());
        });
      }),
  };
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_AUDIT_LOG_BYTES = 5 * 1024 * 1024;
const ROTATED_AUDIT_LOG_COUNT = 1;

/**
 * OAuth diagnostics intentionally persist only a small allow-list of fields.
 * Request URLs, query strings, request bodies, client IDs, state, codes, and
 * credentials must never be passed through to this logger.
 */
export type McpOAuthAuditStage =
  | "oauth.protected_resource_metadata"
  | "oauth.authorization_server_metadata"
  | "oauth.client_registration"
  | "oauth.authorization_request"
  | "oauth.authorization_decision"
  | "oauth.token_request"
  | "mcp.endpoint_probe"
  | "mcp.initialize"
  | "mcp.tools_list"
  | "mcp.tools_call";

export interface McpOAuthAuditEvent {
  stage: McpOAuthAuditStage;
  method: "GET" | "POST" | "HEAD" | "DELETE";
  statusCode: number;
  durationMs?: number;
}

const ALLOWED_STAGES = new Set<McpOAuthAuditStage>([
  "oauth.protected_resource_metadata",
  "oauth.authorization_server_metadata",
  "oauth.client_registration",
  "oauth.authorization_request",
  "oauth.authorization_decision",
  "oauth.token_request",
  "mcp.endpoint_probe",
  "mcp.initialize",
  "mcp.tools_list",
  "mcp.tools_call",
]);

export function createMcpOAuthAuditLogger(
  logPath = path.join(os.homedir(), ".superagent-r", "mcp-oauth-audit.jsonl"),
): (event: McpOAuthAuditEvent) => void {
  return (event) => {
    try {
      if (!ALLOWED_STAGES.has(event.stage)) return;
      const method = event.method;
      if (!["GET", "POST", "HEAD", "DELETE"].includes(method)) return;
      if (!Number.isInteger(event.statusCode) || event.statusCode < 100 || event.statusCode > 599) return;
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      const safeEvent = {
        timestamp: new Date().toISOString(),
        pid: process.pid,
        stage: event.stage,
        method,
        statusCode: event.statusCode,
        ...(typeof event.durationMs === "number" && Number.isFinite(event.durationMs)
          ? { durationMs: Math.max(0, Math.round(event.durationMs)) }
          : {}),
      };
      try {
        if (fs.statSync(logPath).size >= MAX_AUDIT_LOG_BYTES) {
          for (let i = ROTATED_AUDIT_LOG_COUNT; i >= 1; i--) {
            const target = `${logPath}.${i}`;
            if (i === ROTATED_AUDIT_LOG_COUNT) {
              try { fs.rmSync(target, { force: true }); } catch { /* best effort */ }
            } else {
              const previous = `${logPath}.${i - 1}`;
              if (fs.existsSync(previous)) fs.renameSync(previous, target);
            }
          }
          fs.renameSync(logPath, `${logPath}.1`);
          try { fs.chmodSync(`${logPath}.1`, 0o600); } catch { /* best effort */ }
        }
      } catch {
        // Rotation is best effort. Preserve diagnostics even if rename fails.
      }
      fs.appendFileSync(logPath, JSON.stringify(safeEvent) + "\n", { encoding: "utf8", mode: 0o600 });
      try { fs.chmodSync(logPath, 0o600); } catch { /* best effort on non-POSIX filesystems */ }
    } catch {
      // Diagnostics must never disrupt authentication or tool execution.
    }
  };
}

export const recordMcpOAuthAudit = createMcpOAuthAuditLogger();

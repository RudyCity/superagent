/**
 * Typed, non-mutating T-Line inspection projections.
 * No credential, config-env, raw tool argument schema or task transcript leaves
 * this endpoint. Callers must supply a workspace-validated active T-Line session.
 */
import path from "node:path";

export const TLINE_INSPECTION_ACTIONS = [
  { id: "mcp.status", method: "GET", path: "/api/tline/inspect/mcp.status", access: "read" },
  { id: "tools.catalog", method: "GET", path: "/api/tline/inspect/tools.catalog", access: "read" },
  { id: "selfdev.status", method: "GET", path: "/api/tline/inspect/selfdev.status", access: "read" },
  { id: "muse.status", method: "GET", path: "/api/tline/inspect/muse.status", access: "read" },
] as const;

export function summarizeMcpServers(
  configured: Record<string, { transport?: string; disabled?: boolean }>,
  connected: Map<string, { status?: string; tools?: string[] }>
) {
  const servers = Object.entries(configured).slice(0, 100).map(([name, cfg]) => {
    const live = connected.get(name.trim().toLowerCase());
    return {
      name: name.slice(0, 100),
      transport: ["stdio", "http", "streamable-http", "sse"].includes(cfg.transport || "") ? cfg.transport : "unknown",
      disabled: cfg.disabled === true,
      status: (live?.status || "not-connected").slice(0, 50),
      toolCount: Array.isArray(live?.tools) ? live.tools.length : 0,
    };
  });
  return { success: true, scope: "runtime-global", total: servers.length, servers };
}

export function summarizeTools(definitions: Array<{ name: string }>) {
  const tools = definitions.slice(0, 250).map(def => String(def.name).slice(0, 120));
  return { success: true, scope: "runtime-catalog", count: tools.length,
    truncated: definitions.length > tools.length, tools };
}

export function sameMuseWorkspace(left: string, right: string): boolean {
  if (!left || !right) return false;
  if (/^(ssh:|chain:)/i.test(left) || /^(ssh:|chain:)/i.test(right)) return left === right;
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function summarizeMuse(
  workspace: string,
  cfg: { transport?: string; asRunner?: boolean },
  active: { taskId: string; sessionId: string; workspace: string; startedAt: number } | null,
  watcherActive: boolean
) {
  const visible = active && sameMuseWorkspace(workspace, active.workspace) ? active : null;
  return { success: true, scope: "workspace", transport: cfg.transport || "telegram",
    runnerEnabled: cfg.asRunner === true, watcherActive,
    activeTask: visible ? { taskId: visible.taskId, sessionId: visible.sessionId,
      startedAt: visible.startedAt, status: "running", evidence: "unverified" } : null };
}

export function summarizeSelfdev(report: {
  enabled: boolean; userOptOut: boolean; configVersion: number;
  eventCount: number; lessonCounts: { candidate: number; active: number; retired: number };
  storageAvailable: boolean;
}) {
  return { success: true, scope: "workspace", enabled: report.enabled,
    userOptOut: report.userOptOut, configVersion: report.configVersion,
    storageAvailable: report.storageAvailable,
    eventCount: report.eventCount, lessonCounts: report.lessonCounts };
}

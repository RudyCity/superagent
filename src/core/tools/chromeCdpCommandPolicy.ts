/** Explicit fail-closed Chrome CDP command classification.
 * Unknown commands must not bypass the per-target write lock. */
export type CdpCommandClass = "read" | "write" | "admin";
const admin = new Set([
  "list_targets", "discover_desktop_targets", "claim_target", "recover_session",
  "recover_target", "release_target", "coordinator_status", "list_sessions",
  "new_tab", "share_target", "stop_sharing", "invite_agent", "join_target",
  "leave_target", "revoke_agent", "handover_target", "session_participants", "heartbeat_session",
]);
const reads = new Set([
  "snapshot", "shared_snapshot", "read_page", "extract_links", "wait_for",
  "check_form", "read_terminal", "read_terminal_delta", "list_terminal_sessions",
  "monitor_terminal_agents", "watch_terminal", "get_dialogs", "screenshot", "pdf",
  "get_cursor", "get_cookies", "page_audit", "accessibility_audit", "seo_audit",
  "responsive_audit", "performance_metrics", "read_debug_capture",
]);
export function classifyCdpCommand(command: string, payload: Record<string, unknown> = {}): CdpCommandClass {
  if (admin.has(command)) return "admin";
  // get_dialogs may clear native prompt records; this mutation is serialized.
  if (command === "get_dialogs" && payload.clear === true) return "write";
  if (reads.has(command)) return "read";
  return "write"; // including clear_terminal_sessions and unknown aliases
}

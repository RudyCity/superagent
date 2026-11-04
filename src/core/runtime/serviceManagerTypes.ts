/** Pure service catalog shared by runtime, MCP schemas and agent toolsets. */
export const MANAGED_SERVICE_NAMES = [
  "core", "mcp", "transport", "channel_host", "muse", "telegram",
  "vision", "guardian", "daemon", "tray", "rest_tunnel",
  "muse_tunnel", "process_supervisor",
] as const;
export type ManagedServiceName = typeof MANAGED_SERVICE_NAMES[number];

/**
 * toolAliases.ts — Centralized tool aliases and normalization helpers.
 */

export const TOOL_ALIASES: Record<string, string> = {
  get_remote_service_status: "get_remote_service_status",
  get_remote_status: "get_remote_service_status",
  remote_status: "get_remote_service_status",
  remote_service_status: "get_remote_service_status",
  check_remote_services: "get_remote_service_status",
  get_tunnel_status: "get_remote_service_status",
  tunnel_status: "get_remote_service_status",
  mcp_status: "get_remote_service_status",
  telegram_status: "get_remote_service_status",
  background_process: "run_background_process",
  run_background: "run_background_process",
  background: "run_background_process",
  bg_process: "run_background_process",
  run_bg_process: "run_background_process",
  manage_background: "manage_background_process",
  kill_background: "manage_background_process",
  inspect_background_log: "inspect_background_log",
  grep_background_log: "inspect_background_log",
  tail_background_log: "inspect_background_log",
  search_background_log: "inspect_background_log",
  read_background_log: "inspect_background_log",
  view_background_log: "inspect_background_log",
  cmd: "run_command",
  exec: "run_command",
  shell: "run_command",
  terminal: "run_command",
  read_file: "read",
  write_file: "write_to_file",
  edit_file: "edit",
  check_port: "inspect_port",
  port_inspect: "inspect_port",
  port_status: "inspect_port",
  check_port_status: "inspect_port",
  kill_port: "free_port",
  release_port: "free_port",
  clear_port: "free_port",
  search_process: "find_process",
  find_processes: "find_process",
  search_processes: "find_process",
  ps_search: "find_process",
  terminate_process: "kill_process",
  stop_process: "kill_process",
  get_tools: "list_tools",
  get_tool: "describe_tool",
  describe_tools: "describe_tool",
  tools_list: "list_tools",
  tools_describe: "describe_tool",
  cdp: "control_chrome_cdp",
  chrome_cdp: "control_chrome_cdp",
  emulate_device: "control_chrome_cdp",
  set_device: "control_chrome_cdp",
  set_viewport: "control_chrome_cdp",
  drag_and_drop: "control_chrome_cdp",
  select_option: "control_chrome_cdp",
  select_dropdown: "control_chrome_cdp",
  check_form: "control_chrome_cdp",
  check_form_readiness: "control_chrome_cdp",
  mock_display_media: "control_chrome_cdp",
  mock_screen_share: "control_chrome_cdp",
  bypass_screen_share: "control_chrome_cdp",
  handle_screen_share: "control_chrome_cdp",
  accept_screen_share: "control_chrome_cdp",
  dismiss_screen_share: "control_chrome_cdp",
};

export function canonicalizeToolName(name: string): string {
  if (!name || typeof name !== "string") return "";
  const clean = name.trim().replace(/^['"`]+|['"`]+$/g, "");
  if (!clean) return "";
  const lower = clean.toLowerCase();
  const norm = lower.replace(/[-_]/g, "_");
  return TOOL_ALIASES[norm] || TOOL_ALIASES[lower] || clean;
}

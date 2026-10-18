export const PROJECT_REGISTRY_TOOL_NAMES = new Set([
  "superagent_list_projects", "superagent_get_project", "superagent_register_project",
  "superagent_update_project", "superagent_remove_project",
  "superagent_list_project_access", "superagent_grant_project_access", "superagent_revoke_project_access",
]);

export const WORKSPACE_SCOPED_MCP_TOOLS = new Set([
  "superagent_get_workspace", "superagent_exec_command", "superagent_read_file", "superagent_write_file",
  "superagent_read_files", "superagent_write_files", "superagent_unlock_file", "superagent_list_files",
  "superagent_grep_search", "superagent_find_files", "superagent_manage_worktrees",
  "superagent_get_current_task", "superagent_get_instance_task", "superagent_get_plan_and_tasks",
  "superagent_update_tasks", "superagent_manage_plan", "superagent_manage_tasks", "superagent_replace_file_content",
  "superagent_apply_patch", "superagent_git_action", "superagent_read_document", "superagent_office_cli", "superagent_list_workspace_chains",
  "superagent_manage_workspace_chain", "superagent_cross_workspace_exec",
]);

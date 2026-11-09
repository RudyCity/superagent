---
name: Superagent MCP Tools
description: Comprehensive operational guide and complete catalog for Superagent's Model Context Protocol (MCP) server. Covers dynamic tool gateway discovery, multi-agent orchestration, workspace operations, Delegate Chrome bridge, browser CDP automation, Set-of-Mark (SoM) vision perception, runtime service management, and cross-device mesh.
when_to_use: when connecting to or operating Superagent via MCP; when invoking or discovering superagent_* tools; when orchestrating 3-tier agents, managing projects, controlling browsers, or automating tasks through the Superagent MCP server.
version: 1.0.0
author: Superagent
category: MCP & Tooling
mode: all
---

# Superagent MCP Tools & Capabilities

## Overview

Superagent provides a complete 3-pillar (**Tools**, **Resources**, **Prompts**) Model Context Protocol (MCP) server. It enables external AI clients (such as Antigravity, Claude Code, Claude Desktop, ChatGPT, t-line desktop client, or automated scripts) to programmatically interact with Superagent's entire runtime:
- **Multi-Agent Orchestration**: 3-tier agent hierarchy (Master Agent $\rightarrow$ Superagent $\rightarrow$ Subagent) with isolated Git feature worktrees.
- **Dynamic Tool Gateway**: High-efficiency catalog search, schema inspection, and gated tool execution.
- **Workspace & File System**: Batch file read/write, AST/regex search, patch application, and shell commands.
- **Delegate Chrome Bridge**: Deep automation and two-way messaging with browser-hosted AI assistants (ChatGPT, Claude).
- **Chrome CDP & Vision AI**: DevTools Protocol automation and Set-of-Mark (SoM) RF-DETR visual perception.
- **Runtime Service & Core Lifecycle**: Blue-green restarts, rollbacks, and unified status across 19 managed background services.
- **Cross-Device & LAN Mesh**: Android device automation, secure LAN command execution, and encrypted P2P file transfers.
- **Persistent Brain & Memory**: SQLite FTS5 session search, token analytics, and long-term knowledge storage.

---

## Architecture & Security Model

### 1. Dual MCP Exposure Modes

Superagent supports two operational exposure modes configured via `~/.superagent-r/mcp-tool-exposure.json` or the `SUPERAGENT_MCP_TOOL_EXPOSURE` environment variable (`gateway` | `full`):

| Exposure Mode | Advertised Tools | Behavior & Benefits |
|---|---|---|
| **`gateway` (Default)** | Curated core set (~20 tools) | Eagerly advertises gateway discovery tools (`superagent_tool_search`, `superagent_tool_describe`, `superagent_tool_execute`, `superagent_tool_status`), core project/workspace tools, and delegate chat readers. Prevents context window explosion while granting access to the full catalog on-demand. |
| **`full`** | Entire catalog (80+ tools) | Directly advertises all registered tools across all domains. Best suited for high-context models or specialized single-agent setups. |

### 2. YOLO Modes & Safety Guardrails

Every MCP tool call is subjected to Superagent's unified security boundary:

- **YOLO OFF**: Denies all tools classified as `dangerous` (e.g., shell command execution, file modifications, service restarts) regardless of arguments or OAuth grants. Safe inspection tools remain active.
- **Scoped YOLO**: Permits dangerous operations strictly constrained within the active workspace root or designated project boundary. Access outside the workspace boundary is blocked.
- **Full YOLO**: Allows broad local filesystem and command execution, but strictly enforces protected file boundaries:
  - `.env` and credential files are protected.
  - Model configurations and OAuth stores cannot be maliciously tampered with.
  - Known legacy system ports (e.g., `6759`, `6789`, `7888`, `9877`) and authenticated process ownership are protected.

---

## 1. Gateway & Dynamic Tool Discovery

When operating in `gateway` mode, clients discover and invoke specialized tools dynamically without loading large schemas upfront.

### Gateway Tools Reference

| Tool Name | Purpose | Key Parameters |
|---|---|---|
| `superagent_tool_search` | Search available MCP tools by keyword, intent, or regex | `query` (string), `limit` (optional integer) |
| `superagent_tool_describe` | Retrieve complete inputSchema and documentation for tools | `names` (array of strings) |
| `superagent_tool_execute` | Safely execute a discovered tool through the gateway | `name` (string), `arguments` (object) |
| `superagent_tool_status` | Inspect gateway state, active exposure mode, and catalog size | None |

#### Discovery Protocol Flow
```text
1. Search catalog:   superagent_tool_search({ query: "chrome cdp" })
2. Inspect schema:   superagent_tool_describe({ names: ["superagent_chrome_cdp"] })
3. Execute tool:     superagent_tool_execute({ name: "superagent_chrome_cdp", arguments: { command: "screenshot" } })
```

---

## 2. Multi-Agent Orchestration & Lifecycle

Superagent implements an isolated 3-tier hierarchy where Master Agent delegates features to Superagents running in isolated Git feature worktrees (`~/.superagent-r/worktrees/<name>`).

### Multi-Agent Tools Reference

| Tool Name | Tier / Role | Description |
|---|---|---|
| `superagent_invoke` | Master Tier | Spawn a feature-level Superagent with role, task prompt, and isolated git worktree branch. |
| `superagent_await` | Master Tier | Wait for spawned Superagents to complete their tasks, with optional timeout. |
| `superagent_merge` | Master Tier | Verify acceptance criteria and merge an isolated Superagent's worktree branch into the main branch. |
| `superagent_manage` | Lifecycle | High-level management: `status`, `logs`, `report`, `violations`, `kill`, or `retry_failed`. |
| `superagent_manage_worktrees` | Git Worktrees | Manage Git feature worktrees (`list`, `create`, `prune`, `inspect`). |
| `superagent_list_active` | Inventory | List all active Master Agents, Superagents, Subagents, and background processes. |
| `superagent_get_process_status` | Diagnostics | Real-time process details: iterations, thinking logs, tool streams, and token usage. |
| `superagent_get_status` | Inspection | Detailed status, worktree paths, violation logs, and final completion reports. |
| `superagent_get_logs` | Logs | Retrieve recent execution logs, shell outputs, and thinking blocks for an instance. |
| `superagent_send_message` | Multi-turn | Send mid-flight guidance or corrective feedback to an active Superagent instance. |
| `superagent_interrupt` | Control | Immediately interrupt current agent iteration. |
| `superagent_pause` / `superagent_resume` | Control | Pause an active agent session and resume execution when ready. |
| `superagent_run_task` | One-shot | Execute an ad-hoc prompt or task headless without opening the terminal UI. |
| `superagent_cli_bridge` | Bridge | Delegate tasks to external CLI assistants (Claude Code, Codex, AGY) with persistent sessions. |

---

## 3. Workspace, File Operations & Code Editing

Superagent provides batch-capable, boundary-checked file tools with auto-normalization for stringified arrays and Windows path backslashes.

### File & Workspace Tools Reference

| Tool Name | Classification | Description |
|---|---|---|
| `superagent_get_workspace` | Safe | Returns root workspace path, active Git branch, and status. |
| `superagent_switch_workspace` | Dangerous | Switch the active root workspace to a target directory path. |
| `superagent_read_file` | Safe | Read file content with optional `startLine` and `endLine`. |
| `superagent_read_files` | Safe | Concurrent batch reading of multiple files (`filePaths: ["path1", "path2"]`). |
| `superagent_write_file` | Dangerous | Create or overwrite a file with given content. |
| `superagent_write_files` | Dangerous | Batch create or update multiple files in a single turn. |
| `superagent_list_files` | Safe | Recursively list directory contents with ignore patterns. |
| `superagent_grep_search` | Safe | Fast regex or text search across codebase files. |
| `superagent_find_files` | Safe | Find files matching glob patterns (e.g., `**/*.test.ts`). |
| `superagent_replace_file_content`| Dangerous | Precise string or block replacement within a file. |
| `superagent_apply_patch` | Dangerous | Apply unified diff patches directly to files. |
| `superagent_unlock_file` | Dangerous | Remove read-only flags or file locks. |
| `superagent_exec_command` | Dangerous | Execute shell commands safely in target directory with output capture. |
| `superagent_git_action` | Dangerous | Guarded Git actions (`status`, `diff`, `branch`, `commit`, `push`). |

---

## 4. Multi-Project Management & Workspace Chains

Manage multi-repository setups, remote SSH projects, and cross-project dependency chains.

### Project & Chain Tools Reference

| Tool Name | Description |
|---|---|
| `superagent_list_projects` | List all registered projects across local and SSH providers. |
| `superagent_get_project` | Get project metadata, root directory, target, and provider kind. |
| `superagent_discover_projects` | Scan directory trees to discover existing Git or Node repositories. |
| `superagent_import_discovered_project` | Import an auto-discovered project into the registry. |
| `superagent_sync_projects` | Sync project registry with filesystem state. |
| `superagent_check_project_health` | Probe project root existence, Git repository status, and SSH connectivity. |
| `superagent_register_project` | Register a new local or SSH project root. |
| `superagent_update_project` | Update project configuration, description, or enabled status. |
| `superagent_remove_project` | Unregister project from registry. |
| `superagent_list_project_access` | List principal identities and granted access capabilities. |
| `superagent_grant_project_access` | Grant project capability (`read`, `write`, `admin`, `system`) to an identity. |
| `superagent_revoke_project_access`| Revoke access capability from an identity. |
| `superagent_list_workspace_chains` | List multi-repo workspace chains and cross-repository dependencies. |
| `superagent_manage_workspace_chain`| Configure, link, or unlink workspace dependencies. |
| `superagent_cross_workspace_exec` | Execute commands or tools across connected workspace chains. |

---

## 5. Task Checklists, Implementation Plans & Skills

Superagent tracks tasks and implementation plans using Markdown checklist conventions (`[ ]`, `[/]`, `[x]`).

### Planning & Skills Tools Reference

| Tool Name | Description | Key Parameters |
|---|---|---|
| `superagent_get_current_task` | Get active checklist item, progress %, and instance status | `instanceId` (optional), `currentOnly` (optional boolean) |
| `superagent_get_plan_and_tasks` | Parse implementation plan document and task checklist | `superagentId` or `workspace` path |
| `superagent_update_tasks` | Update checklist status (`mark_completed`, `mark_in_progress`, `add_task`) | `action`, `taskText`, `superagentId` (optional) |
| `superagent_manage_plan` | Create, update, or retrieve structured implementation plans | `action` ("get" \| "set"), `content` |
| `superagent_manage_tasks` | Detailed task checklist operations | `action`, `tasks` |
| `superagent_get_skills` | List all available installed, workspace, and synthesized skills | None |
| `superagent_use_skill` | Load detailed instructions and context from a specific skill | `skillName` (string) |
| `superagent_synthesize_skill` | Synthesize a new autonomous skill from successful session trajectories | `skillName`, `description`, `trajectoryId` |

---

## 6. Delegate Chrome Bridge (ChatGPT / Claude Remote Automation)

Superagent features a host-owned Delegate Chrome Bridge that directly connects to browser-hosted ChatGPT or Claude sessions without opening additional ports or sending duplicate requests.

### Delegate Tools Reference

| Tool Name | Safe / Write | Description |
|---|---|---|
| `superagent_delegate_read_chat` | Safe | Read recent messages, connection status, and active profile metadata. |
| `superagent_delegate_list_chats` | Safe | List conversation threads available in the connected browser profile. |
| `superagent_delegate_read_chat_full` | Safe | Read complete chat transcript, including tool calls and model thinking blocks. |
| `superagent_delegate_search_history` | Safe | Search past browser chat conversations by keyword. |
| `superagent_delegate_sync_history` | Safe | Trigger synchronization of chat history with local SQLite cache. |
| `superagent_delegate_search_index` | Safe | Full-text search over indexed browser conversation transcripts. |
| `superagent_delegate_doctor` | Safe | Run diagnostic checks on extension connection, profile health, and tabs. |
| `superagent_delegate_run_until_done`| Safe | Wait autonomously until ongoing model generation is completely finished. |
| `superagent_delegate_inspect_chat_config` | Safe | Inspect active model settings, profile parameters, and limits. |
| `superagent_delegate_configure_chat` | Write | Set parameters (model, temperature, plugins) for target chat. |
| `superagent_delegate_create_chat` | Write | Start a fresh chat thread in the connected browser. |
| `superagent_delegate_send_message` | Write | Send prompt or instruction to ChatGPT/Claude with optional idempotency key. |
| `superagent_delegate_stop_generation` | Write | Stop ongoing generation immediately. |

---

## 7. Chrome DevTools Protocol (CDP) & Set-of-Mark Vision

Full headless or headful Chrome browser control with unified Set-of-Mark (SoM) visual perception.

### Chrome & Vision Tools Reference

| Tool Name | Key Capabilities |
|---|---|
| `superagent_chrome_cdp` | Direct CDP automation: `click`, `type`, `navigate`, `evaluate`, `screenshot`, `cookies`, `storage`, `network`, `emulate_device` (mobile/tablet/desktop), `mock_display_media` (screen share bypass), `handle_screen_share` (accept/dismiss picker dialogs), `drag_and_drop` with Bezier smoothing. |
| `superagent_chrome_vision` | Set-of-Mark (SoM) RF-DETR vision AI: `perceive_page` (labels interactive elements with numeric badges `[1]`, `[2]`), `click_id` / `type_id` (direct coordinate targeting bypassing DOM/shadow-DOM/canvas), `audit_layout` (collision/tap-target defect detection), `verify_visual_state` (pixel diffing). |
| `superagent_list_running_chrome` | Multi-window enumeration, profile display names from Local State, and tab lists via Windows UI Automation. |
| `superagent_close_chrome_profile` | Terminate Chrome processes matching exact `--profile-directory`. |
| `superagent_close_chrome_window` | Close a specific Chrome window by handle/title. |
| `superagent_launch_chrome` | Launch Chrome with debugging flags and dedicated profile. |
| `superagent_list_chrome_profiles` | List installed Chrome user profiles on the host machine. |
| `superagent_remote_chrome` | Interact with remote Chrome instances via serverless WebSocket bridge (port 9223). |

---

## 8. Desktop UI Automation

Native OS desktop automation for windows, mouse, and keyboard interactions.

| Tool Name | Actions & Parameters |
|---|---|
| `superagent_desktop_ui` | Native desktop control: `action: "screenshot"` (full or window capture), `action: "click"` (coordinate or element click), `action: "type"` (keystroke typing), `action: "key_combo"` (hotkeys), `action: "list_windows"` (enumerate top-level windows), `action: "focus_window"` (bring window to foreground). |

---

## 9. Core Lifecycle & Service Management

Enforces the R0-R7 single-runtime deployment contract. Protects authenticated process owners from accidental termination while providing blue-green lifecycle mutations.

### Core Lifecycle Tools

| Tool Name | Classification | Purpose |
|---|---|---|
| `superagent_core_status` | Safe | Read-only supervised API Core status, generation, and health. |
| `superagent_core_plan` | Safe | Preflight check for mutations: generates stable `operationId` and `expectedBuildDigest`. |
| `superagent_core_restart` | Dangerous | Blue-green verified restart of development Core. Requires `confirm: true`, `operationId`, and `expectedBuildDigest`. |
| `superagent_core_rollback` | Dangerous | Roll back Core to retained previous generation. |
| `superagent_core_drain` | Dangerous | Gracefully retire idle retained Core generations while preserving active sessions. |

### Service Manager Tool: `superagent_manage_services`

Unified controller covering 19 Superagent runtime services (`core`, `mcp`, `tray`, `tunnels`, `muse`, `telegram`, `vision`, `guardian`, `daemon`, etc.):
- **Inspection**: `inventory`, `status`, `doctor`, `health`, `dashboard`, `logs`, `profile`.
- **Preflight & Planning**: `plan` (generates preflight digests and operation IDs).
- **Mutations (Requires `confirm: true`)**: `start`, `stop`, `restart`, `rollback`, `drain`, `reload`, `upgrade`, `recycle`.

---

## 10. Remote Agent, Muse, Tunnels & Telegram

Connect Superagent to remote agents, WebSocket tunnels, and Telegram messaging channels.

| Tool Name | Purpose |
|---|---|
| `superagent_muse_chat_status` | Check if active WebSocket tunnel supports two-way chat. |
| `superagent_muse_chat` | Send a message to remote Muse agent and await correlated reply. |
| `superagent_muse_tunnel_start` | Start Cloudflare tunnel / WebSocket tunnel. |
| `superagent_muse_tunnel_restart` | Re-establish tunnel connection. |
| `superagent_muse_send_file` | Enqueue and transfer a file to Muse workspace. |
| `superagent_muse_file_status` | Check file transfer queue and progress. |
| `superagent_muse_file_cancel` | Cancel an in-flight file transfer. |
| `superagent_telegram_send_file` | Send file to configured Telegram chat/bot. |
| `superagent_telegram_send_to_muse` | Bridge a Telegram message to remote Muse listener. |
| `superagent_get_remote_status` | Inspect status of all remote bridge endpoints. |

---

## 11. Cross-Device LAN Mesh (Android & Devices)

Autonomous local network mesh discovering nearby Superagent nodes and controlling Android devices.

| Tool Name | Sub-Domain | Description |
|---|---|---|
| `superagent_lan_discover` | Mesh | Discover nearby LAN Superagent nodes and paired devices. |
| `superagent_lan_list_devices` | Mesh | List paired or remembered devices. |
| `superagent_lan_capabilities` | Mesh | Query capabilities of a target LAN node. |
| `superagent_lan_pair_*` | Pairing | Request, check, verify PIN, or cancel LAN pairing (`pair_request`, `pair_status`, `pair`, `pair_cancel`). |
| `superagent_lan_session_*` | Session | Open or close encrypted peer-to-peer session (`session_open`, `session_close`). |
| `superagent_lan_device_exec` | Exec | Execute non-interactive shell command on remote LAN device. |
| `superagent_lan_terminal_exec`| Exec | Interactive streaming terminal session on LAN device. |
| `superagent_lan_android_*` | Android | Android automation: `diagnostic`, `ui_schema`, `ui_click`, `screen`, `input`. |
| `superagent_lan_file_*` | Transfer | End-to-end encrypted LAN file transfer (`file_offer`, `file_put`, `file_get`, `file_finish`, `file_abort`). |
| `superagent_device_tunnel_*` | Tunnels | Manage direct P2P device tunnels (`list`, `pair_request`, `revoke`). |

---

## 12. Remotion Motion Graphics Engine

Programmatic video and motion graphics engine driven by Remotion.

| Tool Name | Description |
|---|---|
| `superagent_motion_generate` | Generate motion composition from brief or script. |
| `superagent_motion_revise` | Apply revisions to an existing motion composition. |
| `superagent_motion_create` / `_edit`| Direct composition creation and frame editing. |
| `superagent_motion_import_*` | Import image or audio assets into the composition. |
| `superagent_motion_render` | Render composition to MP4 or WebM video. |
| `superagent_motion_status` / `_jobs`| Check rendering queue and job statuses. |
| `superagent_motion_cancel` | Cancel an active rendering job. |

---

## 13. Brain, Memory, Analytics & History

Persistent knowledge base, token tracking analytics, and full-text session search.

| Tool Name | Purpose |
|---|---|
| `superagent_brain` | Query persistent vector store / knowledge brain. |
| `superagent_brain_publish` | Index code artifacts or documentation into brain. |
| `superagent_memory_search` | Search pinned facts and long-term memories. |
| `superagent_memory_save` | Save new permanent knowledge or project conventions to memory. |
| `superagent_query_history` | Query SQLite history database (`history.db`) using FTS5 full-text search. |
| `superagent_get_config` | Inspect active model configurations, API keys (masked), and presets. |
| `superagent_switch_preset` | Switch active model preset dynamically. |
| `superagent_switch_provider` | Switch active provider (Anthropic, OpenAI, Gemini, Ollama, DeepSeek). |
| `superagent_export_session` | Export full conversation transcript to Markdown or JSON. |
| `superagent_compact_context` | Manually trigger context compaction to free tokens. |
| `superagent_get_token_usage` | Inspect exact prompt, completion, and tool token metrics. |

---

## 14. Standard MCP Resources & Prompts

### Resources Reference

| Resource URI | Description |
|---|---|
| `superagent://status/live` | Real-time JSON: Master Agent state, active Superagents, subagents, and token analytics. |
| `superagent://workspace/info` | Root workspace path, active Git branch, and list of registered feature worktrees. |
| `superagent://config/current` | Active provider, loaded presets, and tier model assignments. |
| `superagent://history/sessions` | List of recent chat sessions, message counts, and timestamps. |
| `superagent://memory/pinned` | Permanent pinned knowledge and project memories. |
| `superagent://instructions/agentic-mcp` | Embedded agentic execution instructions for connecting models. |

### Prompts Reference

| Prompt Name | Arguments | Purpose |
|---|---|---|
| `superagent_orchestrate` | `feature` (string), `acceptanceCriteria` (string) | Template to orchestrate multi-agent feature implementation. |
| `superagent_debug` | `error` (string), `file` (string) | Structured root-cause investigation and debugging prompt. |
| `superagent_review` | `targetBranch` (string) | Pre-merge code review against plan and safety rules. |
| `superagent_agentic_mcp` | `task` (string), `targetWorkspace` (string), `constraints` (string) | Strict `TOOL_FIRST` execution contract for MCP clients. |

---

## End-to-End Workflow Recipes

### Recipe 1: Dynamic Gateway Discovery & Execution
```text
Goal: Search for a file tool and read a configuration file.
1. Call superagent_tool_search({ query: "read file" })
   -> Returns superagent_read_file and superagent_read_files.
2. Call superagent_tool_describe({ names: ["superagent_read_file"] })
   -> Returns inputSchema: { filePath: string, startLine?: number, endLine?: number }
3. Call superagent_tool_execute({
     name: "superagent_read_file",
     arguments: { filePath: "package.json", startLine: 1, endLine: 30 }
   })
```

### Recipe 2: Spawning and Monitoring a Feature Superagent
```text
Goal: Implement an isolated feature without affecting the main working tree.
1. Call superagent_invoke({
     role: "auth-specialist",
     task: "Implement OAuth2 PKCE callback handler with vitest tests",
     branch: "feature-oauth-pkce"
   })
   -> Returns superagentId: "agent-xyz-881"
2. Periodically inspect progress:
   Call superagent_get_plan_and_tasks({ superagentId: "agent-xyz-881" })
3. Review logs when completed:
   Call superagent_get_logs({ id: "agent-xyz-881", limit: 50 })
4. Merge worktree into main:
   Call superagent_merge({ superagentId: "agent-xyz-881" })
```

### Recipe 3: Set-of-Mark (SoM) Web Automation
```text
Goal: Perceive a web page and click a specific button by its visual numeric tag.
1. Call superagent_chrome_vision({ action: "perceive_page" })
   -> Labels all elements with numeric badges ([1], [2], [3]...) and returns screenshot + metadata.
2. Inspect metadata: Badge [4] corresponds to "Submit Order".
3. Call superagent_chrome_vision({ action: "click_id", id: 4 })
   -> Dispatches native CDP click directly to the center coordinates of element [4].
```

### Recipe 4: Supervised Core Lifecycle Rolling Restart
```text
Goal: Safely restart the API Core without killing active sessions or MCP tunnels.
1. Preflight plan:
   Call superagent_core_plan({ action: "restart" })
   -> Returns { operationId: "op-7848-abcd", expectedBuildDigest: "a1b2c3..." }
2. Execute verified mutation:
   Call superagent_core_restart({
     confirm: true,
     operationId: "op-7848-abcd",
     expectedBuildDigest: "a1b2c3..."
   })
   -> Verified blue-green switchover occurs with zero socket disruption.
```

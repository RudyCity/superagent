/**
 * superagentMcpServer.ts — Complete 3-Pillar (Tools, Resources, Prompts) MCP Server for Superagent.
 *
 * Exposes full AI process inspection, live interruption/control, subagent delegation,
 * CLI bridge, workspace switching, file tools, search, command execution, presets,
 * task checklists, persistent memory, token analytics, session export, context compaction,
 * remote browser control, and standard MCP Resources & Prompts.
 */

import fs from "fs";
import { blockedYoloToolCall } from "../yoloBlocklist.js";
import path from "path";
import os from "os";
import crypto from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { summarizeArgs } from "./mcpLogSanitizer.js";
import { CrossIdeCdpGateway } from "../tools/crossIdeCdpGateway.js";
import { emitMcpActivity } from "./mcpActivityBus.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { getSuperAgentVersion } from "../config/paths.js";
import { MAX_DELEGATE_TIMEOUT_MS, MIN_DELEGATE_TIMEOUT_MS } from "../tools/cliBridgeTimeouts.js";
import {
  getYoloModeState,
  isFullYoloMode,
  isToolCallWithinYoloScope,
  isPathWithinYoloScope,
  getYoloAllowedRoot,
  isModelConfigAccess,
  isSensitiveEnvFileAccess,
} from "../permissions.js";
import { registerResourcesAndPrompts } from "./resourcesAndPrompts.js";
import {
  isRemoteWorkspaceTarget,
  resolveMcpChildWorkspacePath,
  runWithMcpWorkspace,
} from "./tools/workspaceContext.js";
import {
  handleListActive,
  handleGetProcessStatus,
  handleInterrupt,
  handlePause,
  handleResume,
  handleGetLogs,
} from "./tools/processTools.js";
import {
  handleSendMessage,
  handleInvoke,
  handleAwait,
  handleMerge,
  handleManage,
  handleGetStatus,
  handleCliBridge,
} from "./tools/executionTools.js";
import {
  handleSwitchWorkspace,
  handleExecCommand,
  handleReadFile,
  handleReadFiles,
  handleWriteFile,
  handleWriteFiles,
  handleListFiles,
  handleGrepSearch,
  handleFindFiles,
  handleUpdateTasks,
  handleUnlockFile,
  UNLOCK_FILE_MCP_TOOL_DEF,
} from "./tools/workspaceTools.js";
import { handleManageWorktrees } from "./tools/worktreeTools.js";
import { handleGetWorkspace, handleGetCurrentTask } from "./tools/workspaceStatusTools.js";
import { handleGetPlanAndTasks } from "./tools/taskChecklistMcpTools.js";
import {
  handleGetConfig,
  handleSwitchPreset,
  handleSwitchProvider,
  handleMemorySearch,
  handleMemorySave,
  handleQueryHistory,
  handleGetTokenUsage,
  handleRemoteChrome,
  handleExportSession,
  handleCompactContext,
  handleServerHealth,
  handleGetRemoteStatus,
} from "./tools/configTools.js";
import {
  CHROME_MCP_TOOL_DEFS,
  dispatchChromeMcpTool,
} from "./tools/chromeMcpTools.js";
import {
  DIAGNOSTICS_MCP_TOOL_DEFS,
  dispatchDiagnosticsMcpTool,
} from "./tools/diagnosticsMcpTools.js";
import {
  PLAN_SKILLS_MCP_TOOL_DEFS,
  dispatchPlanSkillsMcpTool,
} from "./tools/planSkillsMcpTools.js";
import {
  NETWORK_CONTENT_MCP_TOOL_DEFS,
  dispatchNetworkContentMcpTool,
} from "./tools/networkContentMcpTools.js";
import {
  REMOTE_AGENT_MCP_TOOL_DEFS,
  dispatchRemoteAgentMcpTool,
} from "./tools/remoteAgentMcpTools.js";
import {
  PROJECT_MCP_TOOL_DEFS,
  dispatchProjectMcpTool,
} from "./tools/projectTools.js";
import { resolveProjectTarget } from "../project/projectRouter.js";
import { getProject } from "../project/projectRegistry.js";
import type { ResolvedProjectTarget } from "../project/projectRouter.js";
import { LocalProjectProvider } from "../project/providers/localProjectProvider.js";
import type { ProjectProvider, ProjectProviderKind, ResolvedProjectContext } from "../project/providers/types.js";
import { getProjectCapabilityForTool, hasProjectAccess } from "../project/projectAccessPolicy.js";
import { standaloneSshProjectProvider } from "./tools/standaloneSshProjectTools.js";

const localProjectProvider = new LocalProjectProvider();
const projectProviders: Record<ProjectProviderKind, ProjectProvider> = {
  local: localProjectProvider,
  ssh: standaloneSshProjectProvider,
};

function resolveMcpProjectTarget(
  toolName: string,
  input: Parameters<typeof resolveProjectTarget>[0],
): ResolvedProjectTarget {
  if (toolName !== "superagent_check_project_health") return resolveProjectTarget(input);
  const id = typeof input.projectId === "string" ? input.projectId.trim() : "";
  if (!id) throw new Error("projectId is required for project health checks.");
  const project = getProject(id, input.registryPath);
  if (!project || !project.enabled || project.type === "chain") {
    throw new Error("Project health check is unavailable for this project or the current identity is not authorized.");
  }
  const target = project.type === "local" ? project.root : project.target;
  if (!target) throw new Error("Project health check is unavailable for this project or the current identity is not authorized.");
  // Health diagnostics must still work when a registered local root has been deleted.
  return { projectId: project.id, project, workspace: target, source: "projectId", explicit: true };
}

type McpRequestAuditContext = {
  correlationId: string;
  principalHash?: string;
  projectId?: string | null;
  providerKind?: string | null;
  requiredCapability?: string;
  authorizationDecision?: "allowed" | "denied" | "not_applicable";
  errorCode?: string;
};

function classifyMcpAuditError(error?: string): string | undefined {
  if (!error) return undefined;
  const message = error.toLowerCase();
  if (message.includes("health probe exceeded its deadline") || message.includes("timed out")) return "provider_timeout";
  if (message.includes('"status": "unavailable"') || message.includes("could not verify the registered root")) return "provider_unavailable";
  if (message.includes(".env") || message.includes("protected config") || message.includes("protected path")) return "protected_path";
  if (message.includes("not found") || message.includes("unknown project")) return "unknown_project";
  if (message.includes("disabled")) return "project_disabled";
  if (message.includes("grant_missing") || message.includes("grant")) return "grant_missing";
  if (message.includes("not authorized") || message.includes("outside the allowed workspace scope") || message.includes("capability")) return "capability_denied";
  if (message.includes("not implemented") || message.includes("unsupported operation") || message.includes("not supported by the ssh")) return "unsupported_operation";
  if (message.includes("timeout") || message.includes("timed out")) return "provider_timeout";
  if (message.includes("ssh") || message.includes("sftp") || message.includes("remote root") || message.includes("connection")) return "provider_unavailable";
  if (message.includes("allowlist") || message.includes("scope")) return "tool_blocked";
  return "internal_error";
}

function toResolvedProjectContext(target: ResolvedProjectTarget | null): ResolvedProjectContext | null {
  if (!target?.projectId || !target.project || !target.project.enabled
    || (target.project.type !== "local" && target.project.type !== "ssh")) return null;
  return {
    projectId: target.projectId,
    providerKind: target.project.type,
    project: target.project,
    workspace: target.workspace,
    selectionSource: target.source,
    explicit: target.explicit,
  };
}
import { PROJECT_REGISTRY_TOOL_NAMES, WORKSPACE_SCOPED_MCP_TOOLS } from "./mcpWorkspacePolicy.js";
import { BRAIN_MCP_TOOL_DEFS, dispatchBrainMcpTool, dispatchBrainPublishMcpTool } from "./tools/brainMcpTools.js";
import { MOTION_MCP_TOOL_DEFS, dispatchMotionMcpTool } from "./tools/motionMcpTools.js";
import {
  MCP_GATEWAY_TOOL_DEFS,
  MCP_GATEWAY_TOOL_NAMES,
  MCP_GATEWAY_EAGER_PROJECT_WORKSPACE_TOOL_NAMES,
  getGatewayInitiallyAdvertisedTools,
  getGatewayVisibleCatalog,
  searchGatewayTools,
  describeGatewayTool,
  validateGatewayExecuteTarget,
  gatewayTextResult,
} from "./mcpToolGateway.js";
import { getMcpToolExposure } from "./mcpToolExposure.js";
import { canUnlockMcpDangerousTools, isR1OwnerToolCallAllowed } from "./mcpSafeOwnerPolicy.js";
import { MCP_TOOL_CLASSIFICATION, DISABLED_MCP_TOOLS, PRIVILEGED_MCP_TOOLS, getToolAnnotations, getToolSecuritySchemes } from "./mcpToolPolicy.js";
import type { McpServerOptions } from "./mcpToolPolicy.js";
export type { McpServerOptions } from "./mcpToolPolicy.js";
export { MCP_TOOL_CLASSIFICATION, DISABLED_MCP_TOOLS, getToolAnnotations, getToolSecuritySchemes } from "./mcpToolPolicy.js";
export type { McpToolAnnotations, McpToolSecurityScheme } from "./mcpToolPolicy.js";
import {
  WORKSPACE_CHAIN_MCP_TOOL_DEFS,
  dispatchWorkspaceChainMcpTool,
} from "./tools/workspaceChainMcpTools.js";

const MCP_LOG_FILE = path.join(os.homedir(), ".superagent-r", "superagent-mcp.log");

function logMcp(message: string): void {
  try {
    const timestamp = new Date().toISOString();
    const dir = path.dirname(MCP_LOG_FILE);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(MCP_LOG_FILE, `[${timestamp}] ${message}\n`, "utf-8");
  } catch {}
}

export const MCP_TOOL_DEFINITIONS = [
    {
      name: "superagent_list_active",
      description: "List all currently active Superagents, subagents, and background processes in Superagent.",
      inputSchema: { type: "object", properties: { includeCompleted: { type: "boolean" } } },
    },
    {
      name: "superagent_get_process_status",
      description: "Get real-time process details of Superagent AI: Master Agent status, iterations, thinking logs, tool streams, tokens, and child hierarchy.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "superagent_get_status",
      description: "Get detailed status, worktree paths, violation logs, acceptance criteria, and completion reports.",
      inputSchema: { type: "object", properties: { superagentIds: { type: "array", items: { type: "string" } } } },
    },
    {
      name: "superagent_get_logs",
      description: "Get recent execution logs from an active or completed Superagent, Subagent, or background task.",
      inputSchema: { type: "object", properties: { id: { type: "string" }, limit: { type: "number" } }, required: ["id"] },
    },
    {
      name: "superagent_send_message",
      description: "Send a follow-up instruction, message, feedback, or command to a running or paused Superagent (two-way communication).",
      inputSchema: { type: "object", properties: { superagentId: { type: "string" }, message: { type: "string" }, wait: { type: "boolean" } }, required: ["superagentId", "message"] },
    },
    {
      name: "superagent_interrupt",
      description: "Interrupt / abort AI processing immediately. Stops running loops and cleans up tasks safely.",
      inputSchema: { type: "object", properties: { target: { type: "string", enum: ["all", "master", "superagent", "subagent", "task"] }, id: { type: "string" } } },
    },
    {
      name: "superagent_pause",
      description: "Pause a running Superagent to halt execution until resumed.",
      inputSchema: { type: "object", properties: { superagentId: { type: "string" } }, required: ["superagentId"] },
    },
    {
      name: "superagent_resume",
      description: "Resume a paused Superagent with an optional new instruction/prompt.",
      inputSchema: { type: "object", properties: { superagentId: { type: "string" }, message: { type: "string" }, wait: { type: "boolean" } }, required: ["superagentId"] },
    },
    {
      name: "superagent_run_task",
      description: "Delegate a task to Superagent to execute as a powerful subagent for Antigravity, and return complete generated results and file modifications.",
      inputSchema: { type: "object", properties: { task: { type: "string" }, role: { type: "string" }, mode: { type: "string", enum: ["single", "multi"] }, workspace: { type: "string" } }, required: ["task"] },
    },
    {
      name: "superagent_cli_bridge",
      description: "Delegate tasks to installed AI CLIs via short synchronous runs, pollable long background jobs or interactive sessions. Supports status, log tail, verification and cancellation. For autonomous background tasks requiring shell execution, set permissionMode='full-auto' to avoid headless permission_blocked errors.",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: [
            "list", "profile.list", "role.list", "delegate", "delegate.start", "delegate.jobs", "delegate.get",
            "delegate.tail", "delegate.read", "delegate.cancel", "delegate.claims", "delegate.recovery",
            "delegate.slots", "delegate.recover-slot", "delegate.retry", "delegate.health",
            "dag.create", "dag.start", "dag.get", "dag.list", "dag.cancel",
            "speculative.run", "consensus.review",
            "session.create", "session.send", "session.list", "session.kill", "session.get",
            "session.resume", "session.respond", "session.export", "session.config",
            "session.tail", "session.read", "session.detach",
          ], description: "Use delegate.start for long tasks; delegate.get/tail require jobId." },
          cli: { type: "string", description: "Installed CLI alias (agy, claude, codex or custom)." },
          binary: { type: "string", description: "Absolute binary path for custom CLI." },
          prompt: { type: "string", description: "Instruction for delegate/delegate.start." },
          message: { type: "string", description: "Message for interactive sessions." },
          initialMessage: { type: "string", description: "Initial interactive session prompt." },
          system: { type: "string", description: "Optional system instructions." },
          cwd: { type: "string", description: "Child directory inside the authorized workspace." },
          projectId: { type: "string", description: "Authorized registered project ID." },
          workspace: { type: "string", description: "Optional workspace path." },
          jobId: { type: "string", description: "Job ID for delegate.get/tail/cancel/recovery/retry." },
          slot: { type: "number", minimum: 0, maximum: 11, description: "Host capacity slot index for delegate.recover-slot." },
          idempotencyKey: { type: "string", description: "Optional safe identifier to prevent duplicate background dispatch within an authorized workspace." },
          sessionId: { type: "string", description: "Session ID for session.* operations." },
          args: { type: "array", items: { type: "string" }, description: "CLI flags; AGY permission flags are controlled by permissionMode." },
          skills: { type: "array", items: { type: "string" } },
          skillAutoDetect: { type: "boolean" },
          injectArtifacts: { type: "boolean" },
          taskPath: { type: "string" },
          planPath: { type: "string" },
          walkthroughPath: { type: "string" },
          expectedArtifacts: { type: "array", items: { type: "string" }, description: "1–12 relative workspace artifact paths checked by SHA-256 on completion." },
          timeoutMs: { type: "number", minimum: MIN_DELEGATE_TIMEOUT_MS, maximum: MAX_DELEGATE_TIMEOUT_MS },
          wait: { type: "boolean", description: "For delegate only: false starts a pollable job; true waits for CLI exit." },
          permissionMode: { type: "string", enum: ["accept-edits", "plan", "auto", "full-auto"], description: "AGY permission policy: 'accept-edits' (default, prompts for shell commands which causes headless background jobs to be permission_blocked), 'plan', 'auto', or 'full-auto' (passes --dangerously-skip-permissions to allow unrestricted autonomous shell execution in background jobs)." },
          conversationId: { type: "string" },
          idleTimeoutMs: { type: "number", minimum: 0 },
          setIdleTimeoutMs: { type: "number", minimum: 0 },
          maxBufferLines: { type: "number" },
          autoSendInitial: { type: "boolean" },
          since: { type: "number" },
          tailLimit: { type: "number", minimum: 1, maximum: 2000 },
          offsetBytes: { type: "number", description: "Cursor for delegate.read/session.read." },
          maxBytes: { type: "number", description: "Page size, 256-32000 bytes (default 12000)." },
          tailLines: { type: "number" },
          answer: { type: "string" },
          interactive: { type: "boolean" },
          skipSystem: { type: "boolean" },
          env: { type: "object", additionalProperties: { type: "string" } },
          priority: { type: "number", description: "Priority score (1-100, default 50)." },
          resourceClass: { type: "string", enum: ["light", "normal", "heavy", "exclusive"], description: "Resource intensity class." },
          role: { type: "string", description: "Agent role profile alias (e.g. architect, coder, tester, reviewer, researcher)." },
          worktree: { type: "boolean", description: "If true, executes the job in an isolated Git worktree." },
          baseCommitSha: { type: "string", description: "Base commit SHA for creating the isolated worktree." },
          branchName: { type: "string", description: "Optional custom branch name for the isolated worktree." },
          acceptanceContract: { type: "object", description: "Acceptance criteria for delegate.start." },
          resourceClaims: { type: "array", items: { type: "string" }, description: "Relative file paths to lock." },
          queueIfBusy: { type: "boolean", description: "If true, queues the job in durable priority queue." },
          graphId: { type: "string", description: "DAG graph ID for action=dag.start / dag.get / dag.cancel." },
          dag: { type: "object", description: "DAG definition object for action=dag.create." },
          candidates: { type: "array", description: "Candidate specifications array for action=speculative.run." },
          reviewers: { type: "array", description: "Reviewer specifications array for action=consensus.review." },
          diff: { type: "string", description: "Diff or patch string to review for action=consensus.review." },
        },
        required: ["action"],
      },
    },
    {
      name: "superagent_switch_workspace",
      description: "Switch active working directory / workspace of Superagent.",
      inputSchema: { type: "object", properties: { workspacePath: { type: "string" }, projectId: { type: "string", description: "Select an enabled, registered project by stable ID." } } },
    },
    {
      name: "superagent_get_workspace",
      description: "Get current workspace directory, active Git branch, and feature worktree information.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, workspace: { type: "string" } } },
    },
    {
      name: "superagent_exec_command",
      description: "Run a command with bounded output preview and persistent complete log; pass commandId with offsetBytes/maxBytes to retrieve any page.",
      inputSchema: { type: "object", properties: { command: { type: "string" }, commandId: { type: "string", description: "Saved command ID to read." }, offsetBytes: { type: "number", description: "Byte offset to resume saved output." }, maxBytes: { type: "number", description: "Page size, 256-32000 bytes (default 12000)." }, cwd: { type: "string" }, workspace: { type: "string" }, projectId: { type: "string" }, timeoutMs: { type: "number" } } },
    },
    {
      name: "superagent_read_file",
      description: "Legacy single-file read endpoint. Disabled on MCP; use superagent_read_files with a files or filePaths array.",
      inputSchema: { type: "object", properties: { filePath: { type: "string" }, startLine: { type: "number" }, endLine: { type: "number" }, cwd: { type: "string" } }, required: ["filePath"] },
    },
    {
      name: "superagent_write_file",
      description: "Legacy single-file write endpoint. Disabled on MCP; use superagent_write_files with a files array.",
      inputSchema: { type: "object", properties: { filePath: { type: "string" }, content: { type: "string" }, overwrite: { type: "boolean" }, cwd: { type: "string" } }, required: ["filePath", "content"] },
    },
    {
      name: "superagent_read_files",
      description: "Read multiple files in one MCP call. Provide files as path strings or objects { filePath, startLine?, endLine? }; optional global startLine/endLine and cwd. Maximum 50 files.",
      inputSchema: {
        type: "object",
        properties: {
          files: { type: "array", items: { anyOf: [
            { type: "string" },
            { type: "object", properties: { filePath: { type: "string" }, path: { type: "string" }, startLine: { type: "number" }, endLine: { type: "number" } } },
          ] } },
          filePaths: { type: "array", items: { anyOf: [
            { type: "string" },
            { type: "object", properties: { filePath: { type: "string" }, path: { type: "string" }, startLine: { type: "number" }, endLine: { type: "number" } } },
          ] } },
          startLine: { type: "number" },
          endLine: { type: "number" },
          cwd: { type: "string" },
          workspace: { type: "string" },
          projectId: { type: "string", description: "Registered project ID. Takes precedence over implicit session workspace." },
        },
      },
    },
    {
      name: "superagent_write_files",
      description: "Write or create multiple files in one MCP call using { filePath, content, overwrite? } entries. Preserves per-file scope, protected-file, overwrite, and lock checks. Maximum 50 files. Requires dangerous-tool permission over tunnel.",
      inputSchema: {
        type: "object",
        properties: {
          files: { type: "array", items: { type: "object", properties: { filePath: { type: "string" }, path: { type: "string" }, content: { type: "string" }, overwrite: { type: "boolean" } }, required: ["filePath", "content"] } },
          overwrite: { type: "boolean" },
          cwd: { type: "string" },
          workspace: { type: "string" },
          projectId: { type: "string", description: "Registered project ID. Takes precedence over implicit session workspace." },
        },
        required: ["files"],
      },
    },
    UNLOCK_FILE_MCP_TOOL_DEF,
    {
      name: "superagent_list_files",
      description: "List files and directories in the workspace or a specific subfolder.",
      inputSchema: { type: "object", properties: { dirPath: { type: "string" }, workspace: { type: "string" }, projectId: { type: "string" } } },
    },
    {
      name: "superagent_grep_search",
      description: "Pattern search with deterministic, paged results. Pass offset from More matches and limit to get later results without losing matches.",
      inputSchema: { type: "object", properties: { query: { type: "string" }, path: { type: "string" }, include: { type: "string" }, exclude: { type: "string" }, isRegex: { type: "boolean" }, caseSensitive: { type: "boolean" }, offset: { type: "number", description: "Zero-based match offset (default 0)." }, limit: { type: "number", description: "Maximum matches (default 100, max 200)." }, workspace: { type: "string" }, cwd: { type: "string" }, projectId: { type: "string" } }, required: ["query"] },
    },
    {
      name: "superagent_find_files",
      description: "Search for files and directories by name glob or extension.",
      inputSchema: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" }, extension: { type: "string" }, maxDepth: { type: "number" }, workspace: { type: "string" }, cwd: { type: "string" }, projectId: { type: "string" } } },
    },
    {
      name: "superagent_manage_worktrees",
      description: "List, inspect, and remove Git feature worktrees.",
      inputSchema: { type: "object", properties: { action: { type: "string", enum: ["list", "remove"] }, id: { type: "string" }, workspace: { type: "string" }, projectId: { type: "string" } }, required: ["action"] },
    },
    {
      name: "superagent_get_current_task",
      description: "Get the current active task, in-progress checklist step, and progress for a Superagent instance, Subagent, or running process.",
      inputSchema: {
        type: "object",
        properties: {
          instanceId: { type: "string", description: "Optional instance ID (Superagent ID, Subagent ID, or process PID). If omitted, resolves the current active instance." },
          superagentId: { type: "string", description: "Optional alias for instanceId." },
          workspace: { type: "string", description: "Optional workspace or worktree path." },
          projectId: { type: "string", description: "Registered project ID for this lookup." },
          currentOnly: { type: "boolean", description: "If true, returns only the current task description string." },
        },
      },
    },
    {
      name: "superagent_get_plan_and_tasks",
      description: "Read the current implementation plan objective and task checklist for the workspace or a specific Superagent instance.",
      inputSchema: {
        type: "object",
        properties: {
          workspace: { type: "string", description: "Optional workspace or worktree path to inspect." },
          projectId: { type: "string", description: "Registered project ID for this lookup." },
          superagentId: { type: "string", description: "Optional Superagent instance ID to automatically inspect its worktree." },
          currentOnly: { type: "boolean", description: "Optional: if true, returns only the current active task and progress." },
        },
      },
    },
    {
      name: "superagent_update_tasks",
      description: "Update, check, or add items to the task checklist for the workspace or a specific Superagent instance.",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["mark_completed", "mark_in_progress", "add_task", "get_status", "get_current_task"] },
          taskText: { type: "string", description: "Task description text to mark or add." },
          workspace: { type: "string", description: "Optional workspace or worktree path." },
          projectId: { type: "string", description: "Registered project ID for this update." },
          superagentId: { type: "string", description: "Optional Superagent instance ID to update its isolated worktree checklist." },
        },
        required: ["action"],
      },
    },
    {
      name: "superagent_get_config",
      description: "Retrieve Superagent configuration: active provider, model presets, tier models, and system settings.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "superagent_switch_preset",
      description: "Switch the active model preset for Superagent.",
      inputSchema: { type: "object", properties: { presetId: { type: "string" }, mode: { type: "string", enum: ["single", "multi", "auto"] } }, required: ["presetId"] },
    },
    {
      name: "superagent_switch_provider",
      description: "Switch the active AI provider profile.",
      inputSchema: { type: "object", properties: { providerName: { type: "string" } }, required: ["providerName"] },
    },
    {
      name: "superagent_memory_search",
      description: "Search persistent knowledge, facts, and memories stored in Superagent.",
      inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"] },
    },
    {
      name: "superagent_memory_save",
      description: "Save a snippet or knowledge fact into Superagent's persistent memory.",
      inputSchema: { type: "object", properties: { content: { type: "string" }, tag: { type: "string" } }, required: ["content"] },
    },
    {
      name: "superagent_query_history",
      description: "Search or retrieve conversation history, transcripts, and session records from SQLite.",
      inputSchema: { type: "object", properties: { action: { type: "string", enum: ["list_sessions", "get_messages", "search"] }, query: { type: "string" }, sessionId: { type: "string" }, limit: { type: "number" } }, required: ["action"] },
    },
    {
      name: "superagent_export_session",
      description: "Export full chat transcript to Markdown or JSON format.",
      inputSchema: { type: "object", properties: { sessionId: { type: "string" }, format: { type: "string", enum: ["markdown", "json"] } }, required: ["sessionId"] },
    },
    {
      name: "superagent_compact_context",
      description: "Trigger or simulate context compaction and review context optimization status.",
      inputSchema: { type: "object", properties: { strategy: { type: "string" }, maxTokens: { type: "number" } } },
    },
    {
      name: "superagent_get_token_usage",
      description: "Get comprehensive token consumption and context window analytics across tiers and sessions.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "superagent_remote_chrome",
      description: "Interact with remote Chrome browser extension bridge on port 9223 (check status, navigate, click, extract DOM).",
      inputSchema: { type: "object", properties: { action: { type: "string" }, target: { type: "string" }, value: { type: "string" } } },
    },
    {
      name: "superagent_invoke",
      description: "Spawn a new feature-level Superagent in an isolated Git worktree branch.",
      inputSchema: { type: "object", properties: { role: { type: "string" }, task: { type: "string" }, branch: { type: "string" }, wait: { type: "boolean" }, constraints: { type: "string" }, acceptanceCriteria: { type: "array", items: { type: "string" } } }, required: ["role", "task"] },
    },
    {
      name: "superagent_await",
      description: "Wait for all active Superagents (or specific IDs) to finish.",
      inputSchema: { type: "object", properties: { timeoutSeconds: { type: "number" }, superagentIds: { type: "array", items: { type: "string" } } } },
    },
    {
      name: "superagent_merge",
      description: "Merge completed Superagent feature branches into main workspace with conflict resolution.",
      inputSchema: { type: "object", properties: { cleanupWorktrees: { type: "boolean" } } },
    },
    {
      name: "superagent_manage",
      description: "Manage Superagent lifecycle: check status, reports, violations, kill, or retry failed ones.",
      inputSchema: { type: "object", properties: { action: { type: "string", enum: ["list", "status", "logs", "report", "violations", "kill", "kill_all", "retry_failed", "cleanup_orphans", "current_task"] }, superagentIds: { type: "array", items: { type: "string" } } }, required: ["action"] },
    },
    {
      name: "superagent_server_health",
      description: "Check health of the Superagent background HTTP server, all active CLI sessions, and Remote Chrome bridge. Use to diagnose connectivity issues.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "superagent_get_remote_status",
      description: "Inspect the real-time operational status of /muse tunnel (Cloudflare quick tunnels & WebSocket bridge), MCP (exposed MCP servers & connected client MCPs), and Telegram (Muse Watcher and Gateway).",
      inputSchema: {
        type: "object",
        properties: {
          service: { type: "string", enum: ["all", "tunnel", "mcp", "telegram"], description: "Filter by specific service or 'all'. Defaults to 'all'." },
          detailed: { type: "boolean", description: "Whether to return detailed diagnostics and tool list." },
        },
      },
    },
    ...CHROME_MCP_TOOL_DEFS,
    ...DIAGNOSTICS_MCP_TOOL_DEFS,
    ...PLAN_SKILLS_MCP_TOOL_DEFS,
    ...NETWORK_CONTENT_MCP_TOOL_DEFS,
    ...REMOTE_AGENT_MCP_TOOL_DEFS,
    ...PROJECT_MCP_TOOL_DEFS,
    ...BRAIN_MCP_TOOL_DEFS,
    ...WORKSPACE_CHAIN_MCP_TOOL_DEFS,
    ...MOTION_MCP_TOOL_DEFS,
    ...MCP_GATEWAY_TOOL_DEFS,
];

const activeMcpServerInstances = new Set<Server>();

export async function notifyMcpToolsListChanged(): Promise<void> {
  const promises = Array.from(activeMcpServerInstances).map(async (s) => {
    try {
      await s.sendToolListChanged();
    } catch {
      // ignore
    }
  });
  await Promise.all(promises);
}


export function createSuperagentMcpServer(options: McpServerOptions = {}): Server {
  const { allowedTools, onToolCall, authMode = "static-bearer", allowDangerous, lockSafeTools = false, getIdentity, workspace, toolExposure = getMcpToolExposure().mode } = options;
  if (lockSafeTools && (allowDangerous || !allowedTools)) {
    throw new Error("Safe-only MCP owner requires an explicit allowlist and must disable dangerous tools");
  }
  const version = getSuperAgentVersion();
  const server = new Server(
    {
      name: "superagent-mcp-server",
      version: version || "1.5.26",
    },
    {
      capabilities: lockSafeTools
        ? { tools: { listChanged: true } }
        : {
            tools: { listChanged: true },
            resources: {},
            prompts: {},
          },
    }
  );

  activeMcpServerInstances.add(server);
  const existingOnClose = server.onclose;
  server.onclose = () => {
    activeMcpServerInstances.delete(server);
    if (existingOnClose) existingOnClose();
  };

  // Register Standard MCP Resources & Prompts
  if (!lockSafeTools && !options.skipResourcesAndPrompts) {
    registerResourcesAndPrompts(server, { authMode, getIdentity });
  }

  const getAuthorizedMcpTools = () => {
    const allTools = MCP_TOOL_DEFINITIONS;
    // Allowlist: hide non-allowed tools from MCP clients.
    // If allowDangerous is true OR CLI YOLO mode is active ("scoped" | "full"),
    // dangerous tools are dynamically unlocked for discovery.
    const yoloState = getYoloModeState();
    const isDangerousUnlocked = canUnlockMcpDangerousTools({
      lockSafeTools, allowDangerous: Boolean(allowDangerous), yoloState,
    });
    const effectiveAllowedTools = isDangerousUnlocked ? undefined : allowedTools;
    // OAuth tool discovery must reflect the CURRENT token, not local YOLO
    // configuration. A revoked/read-only token must not see write tools.
    const oauthScopes = authMode === "oauth" ? getIdentity?.()?.scopes : undefined;
    const canDiscoverDangerous = authMode !== "oauth"
      || (Array.isArray(oauthScopes) && oauthScopes.includes("mcp:tools:write"));
    const canDiscoverRead = authMode !== "oauth"
      || (Array.isArray(oauthScopes) && oauthScopes.some(
        scope => scope === "mcp:tools" || scope === "mcp:tools:read" || scope === "mcp:tools:write"));
    const canDiscoverAdmin = authMode !== "oauth"
      || (Array.isArray(oauthScopes) && oauthScopes.includes("mcp:tools:admin") && canDiscoverDangerous);
    // Disabled tools stay hidden regardless of dangerous/YOLO mode or allowlists.
    const tools = allTools.filter(
      (t) => !DISABLED_MCP_TOOLS.has(t.name)
        && canDiscoverRead
        && (!effectiveAllowedTools || effectiveAllowedTools.includes(t.name))
        && (!lockSafeTools || MCP_TOOL_CLASSIFICATION[t.name] === "safe")
        // YOLO OFF is always read-only; --allow-dangerous, OAuth and grants cannot bypass it.
        && (MCP_TOOL_CLASSIFICATION[t.name] !== "dangerous" || (yoloState !== "off" && canDiscoverDangerous))
        && (!PRIVILEGED_MCP_TOOLS.has(t.name) || canDiscoverAdmin)
    );
    return tools;
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const authorized = getAuthorizedMcpTools();
    const tools = toolExposure === "gateway"
      ? getGatewayInitiallyAdvertisedTools(authorized)
      : authorized;
    const annotated = tools.map((t) => ({
      ...t,
      annotations: getToolAnnotations(t.name),
      _meta: { securitySchemes: getToolSecuritySchemes(t.name, authMode) },
    }));
    return { tools: annotated };
  });

  const scopedWorkspaceAnchor = workspace || process.cwd();
  let activeWorkspace = scopedWorkspaceAnchor;
  let activeProjectId: string | null = null;
  let activeProjectGrantRequired = false;
  // Stable for this server/transport session; never derived from a project cwd.
  const connectionBrainSessionId = crypto.randomUUID();
  // Actor identity is generated per authenticated MCP transport. App/client
  // names from initialize.clientInfo are informational, never authorization.
  const crossIdeGateway = new CrossIdeCdpGateway({
    sessionId: connectionBrainSessionId,
    clientLabel: process.env.SUPERAGENT_CDP_IDE_LABEL,
  });
  const dispatchMcpToolCall = async (request: any, auditContext?: McpRequestAuditContext) => {
    const { name, arguments: args = {} } = request.params;
    const earlyBlockedRoot = blockedYoloToolCall(args, activeWorkspace);
    if (earlyBlockedRoot) {
      if (auditContext) { auditContext.authorizationDecision = "denied"; auditContext.errorCode = "yolo_path_blocked"; }
      return { content: [{ type: "text", text: `Access denied by YOLO blocklist: ${earlyBlockedRoot}` }], isError: true };
    }
    if (!isFullYoloMode() && isSensitiveEnvFileAccess({ name, args })) {
      if (auditContext) { auditContext.authorizationDecision = "denied"; auditContext.errorCode = "protected_path"; }
      return { content: [{ type: "text", text: "MCP access to .env files is blocked unless Full YOLO is enabled locally. Project grants do not override this sensitive-file guard." }], isError: true };
    }
    if (typeof args.projectId === "string" && !WORKSPACE_SCOPED_MCP_TOOLS.has(name)
      && name !== "superagent_switch_workspace" && !PROJECT_REGISTRY_TOOL_NAMES.has(name)) {
      if (auditContext) { auditContext.authorizationDecision = "denied"; auditContext.errorCode = "unsupported_project_routing"; }
      return { content: [{ type: "text", text: "This MCP tool does not support projectId routing. Use projectId only with workspace-scoped MCP tools or superagent_switch_workspace." }], isError: true };
    }
    let targetWorkspace = activeWorkspace;
    let targetProjectId: string | null = null;
    let resolvedProjectTarget: ResolvedProjectTarget | null = null;
    const identityForProjectAccess = getIdentity?.();
    const hasExplicitWorkspaceTarget = typeof args.projectId === "string" || typeof args.workspace === "string"
      || typeof args.cwd === "string" || typeof args.worktreePath === "string";
    const shouldResolveWorkspace = WORKSPACE_SCOPED_MCP_TOOLS.has(name) || hasExplicitWorkspaceTarget;
    if (name !== "superagent_switch_workspace" && !PROJECT_REGISTRY_TOOL_NAMES.has(name) && shouldResolveWorkspace) {
      try {
        const resolvedTarget = resolveMcpProjectTarget(name, {
          projectId: args.projectId,
          workspace: args.workspace,
          cwd: args.cwd,
          worktreePath: args.worktreePath,
          sessionWorkspace: activeWorkspace,
        });
        resolvedProjectTarget = resolvedTarget;
        targetWorkspace = resolvedTarget.workspace;
        targetProjectId = resolvedTarget.projectId ?? (!hasExplicitWorkspaceTarget ? activeProjectId : null);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const rawExplicitTarget = [args.workspace, args.cwd, args.worktreePath]
          .find((value) => typeof value === "string" && value.trim()) as string | undefined;
        // Preserve legacy absolute/relative workspace targets only as candidates;
        // the Scoped YOLO boundary below remains the authoritative permission check.
        if (!args.projectId && rawExplicitTarget && !/^(?:ssh:|chain:)/i.test(rawExplicitTarget)
          && message.includes("Workspace target is not registered or authorized")) {
          targetWorkspace = path.isAbsolute(rawExplicitTarget)
            ? path.resolve(rawExplicitTarget)
            : path.resolve(activeWorkspace, rawExplicitTarget);
        } else {
          return { content: [{ type: "text", text: message }], isError: true };
        }
      }
    } else if (name !== "superagent_switch_workspace" && !PROJECT_REGISTRY_TOOL_NAMES.has(name)) {
      targetWorkspace = activeWorkspace;
      targetProjectId = activeProjectId;
    }
    const chainUriTarget = /^chain:/i.test(targetWorkspace);
    const sshUriTarget = /^ssh:/i.test(targetWorkspace);
    if (auditContext) {
      auditContext.projectId = targetProjectId ?? resolvedProjectTarget?.projectId ?? activeProjectId ?? null;
      auditContext.providerKind = resolvedProjectTarget?.project?.type ?? (sshUriTarget ? "ssh" : chainUriTarget ? "chain" : null);
      auditContext.requiredCapability = WORKSPACE_SCOPED_MCP_TOOLS.has(name) ? getProjectCapabilityForTool(name, args) : undefined;
    }
    if (name !== "superagent_switch_workspace" && !PROJECT_REGISTRY_TOOL_NAMES.has(name) && shouldResolveWorkspace
      && !isFullYoloMode() && !chainUriTarget) {
      const selectedProjectRequiresGrant = Boolean(activeProjectGrantRequired && targetProjectId && targetProjectId === activeProjectId);
      const scopedLocalAccess = !selectedProjectRequiresGrant && !sshUriTarget
        && isPathWithinYoloScope(targetWorkspace, scopedWorkspaceAnchor);
      const capability = getProjectCapabilityForTool(name, args);
      const grantedProjectAccess = Boolean(WORKSPACE_SCOPED_MCP_TOOLS.has(name) && targetProjectId && identityForProjectAccess?.subject
        && hasProjectAccess(identityForProjectAccess, targetProjectId, capability));
      if (!scopedLocalAccess && !grantedProjectAccess) {
        if (auditContext) { auditContext.authorizationDecision = "denied"; auditContext.errorCode = "capability_denied"; }
        const reason = name === "superagent_check_project_health"
          ? "Project health check is not authorized for this project. The authenticated MCP identity needs the explicit 'read' capability or the project must be within the session's allowed workspace scope."
          : sshUriTarget
            ? `Standalone SSH project access is not granted for project ${targetProjectId || targetWorkspace}. Use superagent_grant_project_access with the required capability after enabling dangerous-tool access.`
            : `Project target is outside the allowed workspace scope: ${targetWorkspace}. Project registration alone does not grant access. Grant the authenticated MCP identity the '${capability}' capability or enable Full YOLO locally.`;
        return { content: [{ type: "text", text: reason }], isError: true };
      }
    }
    if (auditContext && WORKSPACE_SCOPED_MCP_TOOLS.has(name) && auditContext.authorizationDecision !== "denied") {
      auditContext.authorizationDecision = "allowed";
    }
    if (name !== "superagent_switch_workspace" && !PROJECT_REGISTRY_TOOL_NAMES.has(name) && hasExplicitWorkspaceTarget) {
      // Canonicalize explicit handler context: avoid a relative cwd/workspace argument
      // being resolved again against process.cwd(). When workspace + cwd are both
      // supplied, preserve cwd as a child of the authorized workspace instead of
      // flattening it back to the workspace root.
      const requestedWorkspace = typeof args.workspace === "string" && args.workspace.trim()
        ? args.workspace.trim()
        : undefined;
      const requestedCwd = typeof args.cwd === "string" && args.cwd.trim()
        ? args.cwd.trim()
        : undefined;
      args.workspace = targetWorkspace;
      if (requestedCwd) {
        args.cwd = requestedWorkspace && !isRemoteWorkspaceTarget(targetWorkspace)
          ? resolveMcpChildWorkspacePath(targetWorkspace, requestedCwd)
          : targetWorkspace;
      }
      if (typeof args.worktreePath === "string") args.worktreePath = targetWorkspace;
    }
    return runWithMcpWorkspace(targetWorkspace, async () => {
      logMcp(`Handling tool call: ${name} with args: ${summarizeArgs(args)}`);

      try {
        if (name === "superagent_browser_gateway") {
          const claimedClientName = server.getClientVersion()?.name;
          crossIdeGateway.setClientLabel(claimedClientName || process.env.SUPERAGENT_CDP_IDE_LABEL);
          const result = await crossIdeGateway.invoke(args);
          return { content: [{ type: "text", text: JSON.stringify(result) }] };
        }
        // Optional MCP-only gateway enforcement. The raw debugging port still
        // needs OS-level isolation to prevent independent direct CDP clients.
        if (process.env.SUPERAGENT_CDP_GATEWAY_ONLY === "1" &&
            ["superagent_chrome_cdp", "superagent_control_chrome_cdp",
             "superagent_chrome_vision", "superagent_control_chrome_vision"].includes(name)) {
          return { content: [{ type: "text", text:
            "Direct MCP Chrome commands are disabled in gateway-only mode. Use superagent_browser_gateway." }], isError: true };
        }
        const providerContext = toResolvedProjectContext(resolvedProjectTarget);
        if (name === "superagent_check_project_health") {
          if (!providerContext) throw new Error("Project health is currently supported for registered local and standalone SSH projects only.");
          const provider = projectProviders[providerContext.providerKind];
          if (!provider.supports("health_check")) throw new Error(`Health checks are not supported by the ${providerContext.providerKind} provider.`);
          const timeoutMs = typeof args.timeoutMs === "number" ? Math.max(1000, Math.min(15000, args.timeoutMs)) : 8000;
          const report = await provider.checkHealth(providerContext, { timeoutMs });
          return {
            content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
            ...(report.status === "unavailable" ? { isError: true } : {}),
          };
        }
        if (providerContext && [
          "superagent_read_files", "superagent_list_files", "superagent_grep_search", "superagent_find_files",
          "superagent_write_files", "superagent_exec_command", "superagent_git_action",
        ].includes(name)) {
          const provider = projectProviders[providerContext.providerKind];
          const operation = name === "superagent_read_files" ? "read_files"
            : name === "superagent_list_files" ? "list_files"
            : name === "superagent_grep_search" ? "grep_search"
            : name === "superagent_find_files" ? "find_files"
            : name === "superagent_write_files" ? "write_files"
            : name === "superagent_exec_command" ? "exec_command" : "git_action";
          if (provider.supports(operation)) {
            const result = operation === "read_files" ? await provider.readFiles(providerContext, args)
              : operation === "list_files" ? await provider.listFiles(providerContext, args)
              : operation === "grep_search" ? await provider.grepSearch(providerContext, args)
              : operation === "find_files" ? await provider.findFiles(providerContext, args)
              : operation === "write_files" ? await provider.writeFiles(providerContext, args)
              : operation === "exec_command" ? await provider.execCommand(providerContext, args)
              : await provider.gitAction(providerContext, args);
            return {
              content: [{ type: "text", text: result.text }],
              ...(result.isError ? { isError: true } : {}),
            };
          }
        }
        if (name === "superagent_get_workspace" && providerContext) {
          const provider = projectProviders[providerContext.providerKind];
          if (provider.supports("workspace_info")) {
            const info = await provider.getWorkspaceInfo(providerContext);
            if (providerContext.providerKind === "local") return await handleGetWorkspace(info);
            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  ...info,
                  type: "ssh",
                  details: [info.workspace, info.gitBranch].filter(Boolean).join(String.fromCharCode(10)),
                  exitCode: 0,
                }, null, 2),
              }],
            };
          }
        }
        if (/^ssh:/i.test(targetWorkspace) && WORKSPACE_SCOPED_MCP_TOOLS.has(name)) {
          const sshResult = await standaloneSshProjectProvider.dispatch(name, args, targetWorkspace, targetProjectId);
          if (sshResult) return sshResult;
        }
        switch (name) {
        case "superagent_list_active":
          return await handleListActive(args);
        case "superagent_get_process_status":
          return await handleGetProcessStatus();
        case "superagent_get_status":
          return await handleGetStatus(args);
        case "superagent_get_logs":
          return await handleGetLogs(args);
        case "superagent_send_message":
          return await handleSendMessage(args);
        case "superagent_interrupt":
          return await handleInterrupt(args);
        case "superagent_pause":
          return await handlePause(args);
        case "superagent_resume":
          return await handleResume(args);
        case "superagent_run_task":
          return {
            content: [{ type: "text", text: "Tool 'superagent_run_task' is disabled and not exposed by this MCP server." }],
            isError: true,
          };
        case "superagent_spawn_subagent":
          return {
            content: [{ type: "text", text: "Tool 'superagent_spawn_subagent' is disabled on this MCP server." }],
            isError: true,
          };
        case "superagent_cli_bridge":
          return await handleCliBridge(args);
        case "superagent_switch_workspace":
          return await handleSwitchWorkspace(
            args,
            (nextWorkspace, projectId, requiresProjectGrant) => {
              activeWorkspace = nextWorkspace;
              activeProjectId = projectId ?? null;
              activeProjectGrantRequired = Boolean(requiresProjectGrant && projectId);
            },
            (projectId) => Boolean(identityForProjectAccess?.subject && hasProjectAccess(
              identityForProjectAccess, projectId, "read",
            )),
            (candidateWorkspace) => !/^(?:ssh:|chain:)/i.test(candidateWorkspace)
              && isPathWithinYoloScope(candidateWorkspace, scopedWorkspaceAnchor),
          );
        case "superagent_get_workspace":
          return await handleGetWorkspace();
        case "superagent_exec_command":
          return await handleExecCommand(args);
        case "superagent_read_file":
          return await handleReadFile(args);
        case "superagent_read_files":
          return await handleReadFiles(args);
        case "superagent_write_file":
          return await handleWriteFile(args);
        case "superagent_write_files":
          return await handleWriteFiles(args);
        case "superagent_unlock_file":
          return await handleUnlockFile(args);
        case "superagent_list_files":
          return await handleListFiles(args);
        case "superagent_grep_search":
          return await handleGrepSearch(args);
        case "superagent_find_files":
          return await handleFindFiles(args);
        case "superagent_manage_worktrees":
          return await handleManageWorktrees(args);
        case "superagent_get_current_task":
        case "superagent_get_instance_task":
          return await handleGetCurrentTask(args);
        case "superagent_get_plan_and_tasks":
          return await handleGetPlanAndTasks(args);
        case "superagent_update_tasks":
          return await handleUpdateTasks(args);
        case "superagent_get_config":
          return await handleGetConfig();
        case "superagent_switch_preset":
          return await handleSwitchPreset(args);
        case "superagent_switch_provider":
          return await handleSwitchProvider(args);
        case "superagent_memory_search":
          return await handleMemorySearch(args);
        case "superagent_memory_save":
          return await handleMemorySave(args);
        case "superagent_query_history":
          return await handleQueryHistory(args);
        case "superagent_export_session":
          return await handleExportSession(args);
        case "superagent_compact_context":
          return await handleCompactContext(args);
        case "superagent_get_token_usage":
          return await handleGetTokenUsage();
        case "superagent_remote_chrome":
          return await handleRemoteChrome(args);
        case "superagent_invoke":
          return await handleInvoke(args);
        case "superagent_await":
          return await handleAwait(args);
        case "superagent_merge":
          return await handleMerge(args);
        case "superagent_manage":
          return await handleManage(args);
        case "superagent_server_health":
          return await handleServerHealth();
        case "superagent_get_remote_status":
          return await handleGetRemoteStatus(args);
        default: {
          const identity = getIdentity?.();
          // Rendering writes an artifact and executes a worker: explicitly require
          // both capabilities when an MCP project grant (not local scope) is used.
          if (["superagent_motion_render", "superagent_motion_generate", "superagent_motion_revise", "superagent_studio_render", "superagent_studio_generate", "superagent_studio_revise"].includes(name) && targetProjectId && identityForProjectAccess?.subject
            && !isPathWithinYoloScope(targetWorkspace, scopedWorkspaceAnchor)
            && !hasProjectAccess(identityForProjectAccess, targetProjectId, "write")) {
            return { content: [{ type: "text", text: "Motion rendering also requires project write capability." }], isError: true };
          }
          if (name === "superagent_brain") {
            const identity = getIdentity?.();
            const principal = identity?.mode === "oauth"
              ? "oauth:" + identity.subject
              : identity?.mode === "static-bearer" && identity.credentialHash
                ? "bearer:" + identity.credentialHash
                : identity ? "" : authMode === "oauth" ? "" : "local-stdio";
            if (!principal) throw new Error("Authenticated identity required for brain.");
            return dispatchBrainMcpTool(name, args, principal, connectionBrainSessionId)!;
          }
          if (name === "superagent_brain_publish") {
            const identity = getIdentity?.();
            const principal = identity?.mode === "oauth"
              ? "oauth:" + identity.subject
              : identity?.mode === "static-bearer" && identity.credentialHash
                ? "bearer:" + identity.credentialHash
                : identity ? "" : authMode === "oauth" ? "" : "local-stdio";
            if (!principal) throw new Error("Authenticated identity required for brain publication.");
            if (resolvedProjectTarget?.project?.type !== "local" ||
                resolvedProjectTarget.project.enabled !== true ||
                !resolvedProjectTarget.project.root) {
              throw new Error("An enabled registered local project is required to publish Brain artifacts.");
            }
            return dispatchBrainPublishMcpTool(name, args, principal, resolvedProjectTarget.project.root)!;
          }
          const motionRes = await dispatchMotionMcpTool(name, args, targetWorkspace);
          if (motionRes) return motionRes;
          const projectRes = await dispatchProjectMcpTool(name, args, identity?.subject ? identity : null);
          if (projectRes) return projectRes;
          const chainRes = await dispatchWorkspaceChainMcpTool(name, args, targetWorkspace);
          if (chainRes) return chainRes;
          const remoteAgentRes = await dispatchRemoteAgentMcpTool(name, args);
          if (remoteAgentRes) return remoteAgentRes;
          const chromeRes = await dispatchChromeMcpTool(name, args);
          if (chromeRes) return chromeRes;
          const diagRes = await dispatchDiagnosticsMcpTool(name, args);
          if (diagRes) return diagRes;
          const planSkillsRes = await dispatchPlanSkillsMcpTool(name, args);
          if (planSkillsRes) return planSkillsRes;
          const networkRes = await dispatchNetworkContentMcpTool(name, args);
          if (networkRes) return networkRes;
          throw new McpError(ErrorCode.MethodNotFound, `Tool '${name}' not recognized.`);
        }
      }
    } catch (err: any) {
      logMcp(`Error executing tool ${name}: ${err?.stack || err?.message || String(err)}`);
      return {
        content: [{ type: "text", text: `Error executing ${name}: ${err?.message || String(err)}` }],
        isError: true,
      };
    }
      });
  };


function extractMcpResultText(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const r = result as Record<string, unknown>;
  if (Array.isArray(r.content)) {
    const texts = r.content
      .filter((item: any) => item && typeof item === "object" && item.type === "text" && typeof item.text === "string")
      .map((item: any) => item.text);
    if (texts.length > 0) return texts.join("\n");
  }
  if (typeof r.text === "string") return r.text;
  if (typeof r.error === "string") return r.error;
  if (typeof r.message === "string") return r.message;
  return "";
}

  // Allowlist + audit + YOLO boundary wrapper around the dispatcher above.
  const handleMcpCall = async (request: any): Promise<any> => {
    const toolName = String((request.params as any)?.name || "");
    const rawArgs = (request.params as any)?.arguments || {};
    const yoloState = getYoloModeState();
    const isDangerousUnlocked = canUnlockMcpDangerousTools({
      lockSafeTools, allowDangerous: Boolean(allowDangerous), yoloState,
    });
    const effectiveAllowedTools = isDangerousUnlocked ? undefined : allowedTools;
    const level = MCP_TOOL_CLASSIFICATION[toolName];
    const isDangerous = level === "dangerous";
    if (lockSafeTools && (level !== "safe" || PRIVILEGED_MCP_TOOLS.has(toolName) ||
        !isR1OwnerToolCallAllowed(toolName, rawArgs as Record<string,unknown>, scopedWorkspaceAnchor))) {
      throw new McpError(ErrorCode.InvalidRequest,
        "Safe-only MCP owner forbids unknown, dangerous, and administrative tool calls.");
    }
    let effectiveProjectId: string | null = activeProjectId;
    let effectiveWs =
      (rawArgs.workspace as string) ||
      (rawArgs.cwd as string) ||
      (rawArgs.worktreePath as string) ||
      activeWorkspace ||
      process.cwd();
    const callerIdentity = getIdentity?.();
    const principalSource = callerIdentity
      ? `${callerIdentity.mode}:${callerIdentity.subject || callerIdentity.credentialHash || ""}`
      : "";
    const auditContext: McpRequestAuditContext = {
      correlationId: crypto.randomUUID(),
      ...(principalSource ? { principalHash: crypto.createHash("sha256").update(principalSource).digest("hex").slice(0, 16) } : {}),
      projectId: effectiveProjectId,
    };
    const emitAudit = (info: { tool: string; args: unknown; ok: boolean; error?: string; durationMs?: number }) => {
      const projectId = auditContext.projectId ?? effectiveProjectId
        ?? (typeof rawArgs.projectId === "string" ? rawArgs.projectId : null);
      const registeredProject = projectId ? getProject(projectId) : null;
      const providerKind = auditContext.providerKind ?? registeredProject?.type
        ?? (/^ssh:/i.test(effectiveWs) ? "ssh" : /^chain:/i.test(effectiveWs) ? "chain" : null);
      const requiredCapability = auditContext.requiredCapability
        ?? (WORKSPACE_SCOPED_MCP_TOOLS.has(toolName)
          ? getProjectCapabilityForTool(toolName, rawArgs)
          : level ? `${level}_tool` : undefined);
      const authorizationDecision = auditContext.authorizationDecision
        ?? (info.ok ? (WORKSPACE_SCOPED_MCP_TOOLS.has(toolName) ? "allowed" : "not_applicable") : "denied");
      const errorCode = auditContext.errorCode ?? classifyMcpAuditError(info.error)
        ?? (!info.ok ? "tool_execution_failed" : undefined);
      try {
        onToolCall?.({
          ...info,
          correlationId: auditContext.correlationId,
          principalHash: auditContext.principalHash,
          projectId,
          providerKind,
          requiredCapability,
          authorizationDecision,
          errorCode,
        });
      } catch {
        // Audit observers must never break tool execution.
      }
    };
    // Opening dangerous tools locally does not elevate OAuth client scopes.
    // Fail before project routing to avoid leaking routing details to callers
    // without an explicit write grant.
    if (authMode === "oauth" && !DISABLED_MCP_TOOLS.has(toolName)) {
      const scopes = callerIdentity?.mode === "oauth" && Array.isArray(callerIdentity.scopes)
        ? callerIdentity.scopes : [];
      const allowed = isDangerous
        ? scopes.includes("mcp:tools:write")
        : scopes.some(scope => scope === "mcp:tools" || scope === "mcp:tools:read" || scope === "mcp:tools:write");
      const requiredScope = !allowed
        ? (isDangerous ? "mcp:tools:write" : "mcp:tools")
        : PRIVILEGED_MCP_TOOLS.has(toolName) && !scopes.includes("mcp:tools:admin")
          ? "mcp:tools:admin" : null;
      if (requiredScope) {
        const reason = "missing required OAuth scope " + requiredScope;
        auditContext.authorizationDecision = "denied";
        auditContext.errorCode = requiredScope === "mcp:tools:admin"
          ? "insufficient_oauth_admin_scope" : "insufficient_oauth_scope";
        // Denied OAuth scopes must not leak file contents, shell commands or
        // other caller-supplied arguments into audit/activity subscribers.
        emitAudit({ tool: toolName, args: {}, ok: false, error: reason, durationMs: 0 });
        emitMcpActivity({
          type: "tool_call",
          tool: toolName,
          args: {},
          ok: false,
          error: reason,
          durationMs: 0,
          timestamp: Date.now(),
          workspace: activeWorkspace,
        });
        throw new McpError(ErrorCode.InvalidRequest,
          "Tool requires OAuth " + requiredScope + " scope; local dangerous/YOLO mode cannot elevate token permissions.");
      }
    }
    // Re-evaluate the local YOLO state on EVERY invocation, including gateway
    // recursion and pre-existing MCP sessions. Explicit tunnel opt-in is only
    // tool exposure, never a substitute for locally enabled YOLO.
    if (isDangerous && yoloState === "off") {
      const reason = "YOLO OFF denies MCP write/execute tools even with --allow-dangerous, OAuth write/admin scopes, or project grants. Enable /yolo on locally for scoped access or /yolo full locally for broader access.";
      auditContext.authorizationDecision = "denied";
      auditContext.errorCode = "yolo_off";
      emitAudit({ tool: toolName, args: {}, ok: false, error: reason, durationMs: 0 });
      emitMcpActivity({
        type: "tool_call", tool: toolName, args: {}, ok: false, error: reason,
        durationMs: 0, timestamp: Date.now(), workspace: activeWorkspace,
      });
      throw new McpError(ErrorCode.InvalidRequest, reason);
    }
    if (toolName !== "superagent_switch_workspace" && !PROJECT_REGISTRY_TOOL_NAMES.has(toolName)
      && (typeof rawArgs.projectId === "string" || typeof rawArgs.workspace === "string" || typeof rawArgs.cwd === "string" || typeof rawArgs.worktreePath === "string")) {
      try {
        const resolvedTarget = resolveMcpProjectTarget(toolName, {
          projectId: rawArgs.projectId,
          workspace: rawArgs.workspace,
          cwd: rawArgs.cwd,
          worktreePath: rawArgs.worktreePath,
          sessionWorkspace: activeWorkspace || process.cwd(),
        });
        effectiveWs = resolvedTarget.workspace;
        effectiveProjectId = resolvedTarget.projectId;
        auditContext.projectId = resolvedTarget.projectId;
        auditContext.providerKind = resolvedTarget.project?.type ?? null;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const rawExplicitTarget = [rawArgs.workspace, rawArgs.cwd, rawArgs.worktreePath]
          .find((value) => typeof value === "string" && value.trim()) as string | undefined;
        if (!rawArgs.projectId && rawExplicitTarget && !/^(?:ssh:|chain:)/i.test(rawExplicitTarget)
          && message.includes("Workspace target is not registered or authorized")) {
          effectiveWs = path.isAbsolute(rawExplicitTarget)
            ? path.resolve(rawExplicitTarget)
            : path.resolve(activeWorkspace || process.cwd(), rawExplicitTarget);
        } else {
          emitAudit({ tool: toolName, args: rawArgs, ok: false, error: message, durationMs: 0 });
          throw new McpError(ErrorCode.InvalidParams, message);
        }
      }
    }

    const blockedRoot = blockedYoloToolCall(rawArgs, effectiveWs);
    if (blockedRoot) {
      emitAudit({ tool: toolName, args: rawArgs, ok: false, error: "YOLO blocklist denied access" });
      throw new McpError(ErrorCode.InvalidRequest, `Access denied by YOLO blocklist: ${blockedRoot}`);
    }

    // Block direct calls too, including clients that cached an old tools/list response.
    if (DISABLED_MCP_TOOLS.has(toolName)) {
      const errReason = "disabled and hidden from MCP tool discovery";
      emitAudit({ tool: toolName, args: rawArgs, ok: false, error: errReason });
      emitMcpActivity({
        type: "tool_call",
        tool: toolName,
        args: rawArgs,
        ok: false,
        error: "Tool is disabled and hidden from MCP tool discovery",
        durationMs: 0,
        timestamp: Date.now(),
        workspace: effectiveWs,
      });
      throw new McpError(ErrorCode.MethodNotFound, `Tool '${toolName}' is disabled and not exposed by this MCP server.`);
    }

    if (effectiveAllowedTools && !effectiveAllowedTools.includes(toolName)) {
      const errReason = "blocked by MCP tool allowlist";
      emitAudit({ tool: toolName, args: rawArgs, ok: false, error: errReason });
      emitMcpActivity({
        type: "tool_call",
        tool: toolName,
        args: rawArgs,
        ok: false,
        error: "Blocked by MCP tool allowlist",
        durationMs: 0,
        timestamp: Date.now(),
        workspace: effectiveWs,
      });
      throw new McpError(
        ErrorCode.InvalidRequest,
        isDangerous
          ? `Tool '${toolName}' is classified as dangerous and is blocked by MCP tool allowlist. ` +
            `Enable it dynamically via SuperAgent CLI (/yolo or /yolo full) or restart the tunnel with --allow-dangerous.`
          : `Tool '${toolName}' is not enabled on this MCP server (blocked by MCP tool allowlist).`
      );
    }

    // Scoped YOLO boundary guard (Layer 1)
    // If Full YOLO is active, system-wide access is permitted.
    // If Scoped YOLO is active (or allowDangerous without full YOLO), enforce scope boundary!
    const chainToolsRequireDedicatedBoundary = toolName === "superagent_manage_workspace_chain" || toolName === "superagent_cross_workspace_exec";
    // Gateway calls do not carry the target paths in their own schema.
    // The recursively dispatched target call enforces the original YOLO boundary.
    if (isDangerous && toolName !== MCP_GATEWAY_TOOL_NAMES.execute
      && !isFullYoloMode() && !chainToolsRequireDedicatedBoundary && toolName !== "superagent_brain") {
      const remoteSshTarget = /^ssh:/i.test(effectiveWs);
      const capability = getProjectCapabilityForTool(toolName, rawArgs);
      const boundaryIdentity = getIdentity?.();
      const projectGrant = Boolean(WORKSPACE_SCOPED_MCP_TOOLS.has(toolName) && effectiveProjectId && boundaryIdentity?.subject
        && hasProjectAccess(boundaryIdentity, effectiveProjectId, capability));
      const protectedModelConfig = isModelConfigAccess({ name: toolName, args: rawArgs }, effectiveWs);
      // An explicit project grant may expand the workspace root, but can never
      // override the protected model configuration check. SSH paths are validated
      // by the standalone provider; shell execution still runs with the SSH user's OS privileges.
      const projectAdministrationRequiresFullYolo = [
        "superagent_register_project", "superagent_update_project", "superagent_remove_project",
        "superagent_grant_project_access",
      ].includes(toolName);
      const selectedProjectRequiresGrant = Boolean(activeProjectGrantRequired && effectiveProjectId && effectiveProjectId === activeProjectId);
      const scopedBoundaryAllows = !projectAdministrationRequiresFullYolo && !selectedProjectRequiresGrant && !remoteSshTarget
        && isToolCallWithinYoloScope({ name: toolName, args: rawArgs }, scopedWorkspaceAnchor);
      const grantedProjectBoundaryAllows = !projectAdministrationRequiresFullYolo && projectGrant && !protectedModelConfig
        && (remoteSshTarget || isToolCallWithinYoloScope({ name: toolName, args: rawArgs }, effectiveWs));
      const inScope = grantedProjectBoundaryAllows || scopedBoundaryAllows;
      if (!inScope) {
        const allowedRoot = getYoloAllowedRoot(effectiveWs);
        const errReason = `Tool '${toolName}' call was blocked by Scoped YOLO boundary: operation targets path or resource outside allowed scope (${allowedRoot}) or accesses protected config files. Use /yolo full in SuperAgent CLI for unrestricted system-wide access.`;
        emitAudit({ tool: toolName, args: rawArgs, ok: false, error: errReason });
        emitMcpActivity({
          type: "tool_call",
          tool: toolName,
          args: rawArgs,
          ok: false,
          error: "Blocked by Scoped YOLO boundary",
          durationMs: 0,
          timestamp: Date.now(),
          workspace: effectiveWs,
        });
        throw new McpError(ErrorCode.InvalidParams, errReason);
      }
    }
    const startedAt = Date.now();
    try {
      const authorizedTools = getAuthorizedMcpTools();
      let result: any;
      if (toolName === MCP_GATEWAY_TOOL_NAMES.search) {
        result = gatewayTextResult({ tools: searchGatewayTools(authorizedTools, rawArgs) });
      } else if (toolName === MCP_GATEWAY_TOOL_NAMES.describe) {
        const found = describeGatewayTool(authorizedTools, rawArgs.name);
        result = found ? gatewayTextResult(found)
          : { content: [{ type: "text", text: "Tool unavailable or not authorized." }], isError: true };
      } else if (toolName === MCP_GATEWAY_TOOL_NAMES.status) {
        result = gatewayTextResult({
          mode: toolExposure,
          visibleToolCount: getGatewayVisibleCatalog(authorizedTools).length,
          gatewayTools: authorizedTools.filter((tool) =>
            Object.values(MCP_GATEWAY_TOOL_NAMES).includes(tool.name as any)).map((tool) => tool.name),
          eagerProjectWorkspaceTools: authorizedTools.filter((tool) =>
            (MCP_GATEWAY_EAGER_PROJECT_WORKSPACE_TOOL_NAMES as readonly string[]).includes(tool.name)).map((tool) => tool.name),
          initiallyAdvertisedTools: getGatewayInitiallyAdvertisedTools(authorizedTools).map((tool) => tool.name),
        });
      } else if (toolName === MCP_GATEWAY_TOOL_NAMES.execute) {
        const target = validateGatewayExecuteTarget(authorizedTools, rawArgs);
        result = !target
          ? { content: [{ type: "text", text: "Target tool unavailable, unauthorized, or arguments invalid." }], isError: true }
          : await handleMcpCall({
              ...request,
              params: { ...request.params, name: target.name, arguments: target.arguments },
            });
      } else {
        result = await dispatchMcpToolCall(request, auditContext);
      }
      const failed = !!(result && typeof result === "object" && (result as any).isError);
      const durationMs = Date.now() - startedAt;
      const outputText = extractMcpResultText(result);
      emitAudit({ tool: toolName, args: rawArgs, ok: !failed, ...(failed ? { error: outputText } : {}), durationMs });
      emitMcpActivity({
        type: "tool_call",
        tool: toolName,
        args: rawArgs,
        ok: !failed,
        error: failed ? outputText : undefined,
        output: failed ? undefined : outputText,
        durationMs,
        timestamp: Date.now(),
        workspace: effectiveWs,
      });
      return result;
    } catch (err: any) {
      const durationMs = Date.now() - startedAt;
      const errorMsg = err?.message || String(err);
      emitAudit({
        tool: toolName,
        args: rawArgs,
        ok: false,
        error: errorMsg,
        durationMs,
      });
      emitMcpActivity({
        type: "tool_call",
        tool: toolName,
        args: rawArgs,
        ok: false,
        error: errorMsg,
        durationMs,
        timestamp: Date.now(),
        workspace: effectiveWs,
      });
      throw err;
    }
  };
  server.setRequestHandler(CallToolRequestSchema, handleMcpCall);

  return server;
}

export async function startSuperagentMcpServer(options: McpServerOptions = {}): Promise<void> {
  // Stdout is strictly reserved for JSON-RPC protocol framing in stdio mode.
  // Divert console.log and console.info to stderr & logMcp to prevent protocol desync and terminal hangs.
  console.log = (...args: any[]) => {
    const msg = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    logMcp(msg);
    console.error(...args);
  };
  console.info = (...args: any[]) => {
    const msg = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    logMcp(msg);
    console.error(...args);
  };

  logMcp("Starting Superagent MCP Server via stdio transport...");
  const server = createSuperagentMcpServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logMcp("Superagent MCP Server connected and listening on stdio.");

  // Close the JSON-RPC transport before leaving on client EOF or a termination
  // signal. Do not force-kill a still-active client or write anything to stdout.
  let closing = false;
  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    process.stdin.off("end", onEnd);
    process.stdin.off("close", onEnd);
    try {
      await server.close();
    } catch (error) {
      console.error("[mcp] clean close failed:", error);
    } finally {
      process.stdin.pause();
      process.exitCode = 0;
    }
  };
  const onSignal = () => { void shutdown(); };
  const onEnd = () => { void shutdown(); };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  process.stdin.once("end", onEnd);
  process.stdin.once("close", onEnd);
}

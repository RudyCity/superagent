import { GENERAL_ASSISTANT_IDENTITY } from "../assistantIdentity.js";
/**
 * resourcesAndPrompts.ts — MCP Resources and Prompts definitions and handlers for Superagent.
 */

import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { McpServerOptions } from "./mcpToolPolicy.js";
import { getMcpWorkspacePath } from "./tools/workspaceContext.js";
import {
  superagentInstances,
  subagentInstances,
  backgroundTasks,
  masterAgentRef,
  masterPromptTokens,
  masterCompletionTokens,
} from "../tools/state.js";
import {
  getSettings,
  getActiveProviderName,
  getConfiguredProviders,
  getActivePresetId,
  getEffectiveMasterModel,
  getAllTierModels,
} from "../config.js";
import { loadRegistry } from "../tools/superagentRegistry.js";
import { listSessionsFromDb, getAllPinnedKnowledgeFromDb } from "../storage/historyDb.js";

/** The OAuth read grant covers generic MCP inspection, but not personal
 * history, memory, live task prompts or runtime configuration.
 * These resources require the separately owner-consented admin grant.
 * Static-bearer/local stdio retain their pre-existing behavior.
 */
export const SENSITIVE_MCP_RESOURCE_URIS: ReadonlySet<string> = new Set([
  "superagent://status/live",
  "superagent://config/current",
  "superagent://history/sessions",
  "superagent://memory/pinned",
]);

/**
 * Canonical system instructions supplied to external MCP clients
 * during the MCP initialize handshake and via superagent://instructions/agentic-mcp.
 */
export function getSuperagentMcpInstructions(): string {
  return [
    `# SUPERAGENT MCP AGENTIC INSTRUCTION PROTOCOL`,
    ``,
    GENERAL_ASSISTANT_IDENTITY,
    ``,
    `## CRITICAL DIRECTIVES:`,
    `1. TOOL_FIRST: For requests that need MCP action or evidence, use authorized tools promptly; for conversation or explanation, answer directly without unnecessary tool calls.`,
    `2. ACTION OVER ADVICE: For executable user requests, use authorized MCP tools instead of merely giving manual steps. Batch file operations.`,
    `3. AUTONOMOUS LOOP: Complete the entire task end-to-end (Inspect -> Plan -> Act -> Verify -> Report) without unnecessary intermediate pauses.`,
    `4. INTENT-BASED DYNAMIC TOOL DISCOVERY & ROUTING: The MCP catalog initially advertises a lean, curated core set of tools. Infer the user's goal automatically and find the right tools yourself — NEVER wait for the user to name a tool:`,
    `   a. INTENT_MAP: Translate the user's natural-language goal into a capability intent (e.g. multi-agent/code orchestration -> 'run_task'/'invoke', files -> 'read_files'/'write_files', browser/UI -> 'chrome_cdp'/'chrome_vision', ChatGPT history/tabs -> 'delegate', media/PDF/Office -> 'media'/'pdf', services/core -> 'services'/'core', projects -> 'projects').`,
    `   b. SEARCH: If the needed tool is not already in the initial tool list, immediately call 'superagent_tool_search({ intent: "<user goal>" })' (or query keyword).`,
    `   c. DESCRIBE & PREFLIGHT: Inspect the schema and permission requirements via 'superagent_tool_describe({ name: "<tool_name>" })' (and 'superagent_tool_preflight' before sensitive or workspace mutations).`,
    `   d. EXECUTE: Dispatch the tool via 'superagent_tool_execute({ name: "<tool_name>", arguments: { ... } })'. Never assume a tool is missing or ask the user which tool to call without searching first.`,
    `5. COMMON DYNAMIC TOOL TARGETS:`,
    `   • Chrome Browser Automation: 'superagent_chrome_cdp' (commands: 'navigate', 'click', 'type', 'screenshot', 'scroll', 'eval'), 'superagent_chrome_cdp_web'`,
    `   • Visual Layout & Perception: 'superagent_chrome_vision' (UI-DETR-1 layout defect detection & Set-of-Mark coordinates)`,
    `   • Workspaces & Projects: 'superagent_get_workspace', 'superagent_list_projects', 'superagent_check_project_health'`,
    `   • Delegate Chat & History: 'superagent_delegate_search_history', 'superagent_delegate_sync_history'`,
    `6. RIGOROUS VERIFICATION: Verify the requested outcome appropriately; for coding changes, run relevant project tests and builds with authorized tools.`,
    `7. ERROR RECOVERY: If a tool fails, diagnose the error, fix the root cause, and retry.`,
  ].join("\n");
}

/**
 * Canonical protocol plus the operator's saved session prompt. The operator
 * section carries tool expectations and access limits only; it is never an
 * authorization source and cannot widen a grant.
 */
export function composeMcpSessionInstructions(operatorPrompt?: string | null): string {
  const base = getSuperagentMcpInstructions();
  const custom = typeof operatorPrompt === "string" ? operatorPrompt.trim() : "";
  if (!custom) return base;
  return [
    base,
    ``,
    `## OPERATOR SESSION PROMPT`,
    `Operator-supplied guidance for this installation. Follow it for tool selection, project context and access boundaries.`,
    `It never grants permissions: OAuth scopes, Security Approval grants, project grants and host file rules stay authoritative.`,
    ``,
    custom,
  ].join("\n");
}

export function registerResourcesAndPrompts(
  server: Server,
  authOptions: Pick<McpServerOptions, "authMode" | "getIdentity"> = {},
): void {
  const authorized = (privileged = false): boolean => {
    if (authOptions.authMode !== "oauth") return true;
    const identity = authOptions.getIdentity?.();
    if (!identity || identity.mode !== "oauth" || !Array.isArray(identity.scopes)) return false;
    const read = identity.scopes.some(s => s === "mcp:tools" || s === "mcp:tools:read" || s === "mcp:tools:write");
    return read && (!privileged ||
      (identity.scopes.includes("mcp:tools:write") && identity.scopes.includes("mcp:tools:admin")));
  };
  const requireScope = (privileged = false) => {
    if (authorized(privileged)) return;
    throw new McpError(
      ErrorCode.InvalidRequest,
      privileged
        ? "MCP resource requires separately consented mcp:tools:write and mcp:tools:admin OAuth scopes."
        : "MCP resources and prompts require mcp:tools OAuth read scope."
    );
  };
  // 1. List Resources
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    requireScope();
    return {
      resources: [
        {
          uri: "superagent://status/live",
          name: "Superagent Live Status",
          description: "Real-time process status of Superagent Master Agent, running Superagents, and background processes.",
          mimeType: "application/json",
        },
        {
          uri: "superagent://config/current",
          name: "Superagent Active Configuration",
          description: "Current active AI provider, model presets across tiers, and system settings.",
          mimeType: "application/json",
        },
        {
          uri: "superagent://workspace/info",
          name: "Superagent Workspace & Worktrees",
          description: "Current workspace path, active Git branch, and list of feature worktrees.",
          mimeType: "application/json",
        },
        {
          uri: "superagent://history/sessions",
          name: "Recent Superagent Sessions",
          description: "List of recent conversation sessions and message counts from SQLite database.",
          mimeType: "application/json",
        },
        {
          uri: "superagent://memory/pinned",
          name: "Pinned Knowledge & Memories",
          description: "List of pinned facts, architectural decisions, and knowledge snippets.",
          mimeType: "application/json",
        },
        {
          uri: "superagent://instructions/agentic-mcp",
          name: "Superagent Agentic MCP Instructions",
          description: "Optional general-purpose assistant guidance for external MCP clients. Client system policies and consent requirements always take precedence.",
          mimeType: "text/markdown",
        },
      ].filter(item => !SENSITIVE_MCP_RESOURCE_URIS.has(item.uri) || authorized(true)),
    };
  });

  // 2. Read Resource
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    requireScope();
    const { uri } = request.params;
    if (SENSITIVE_MCP_RESOURCE_URIS.has(uri)) requireScope(true);

    switch (uri) {
      case "superagent://status/live": {
        const isMasterRunning = masterAgentRef ? (masterAgentRef.isAgentRunning?.() ?? false) : false;
        const { resolveInstanceCurrentTask } = await import("./tools/taskResolver.js");
        const activeSuperagents = await Promise.all(
          [...superagentInstances.values()].map(async (i) => {
            const res = await resolveInstanceCurrentTask({ superagentId: i.id });
            return {
              id: i.id,
              role: i.role,
              branch: i.branch,
              status: i.status,
              task: i.task,
              currentTask: res.currentTask,
              currentTaskStatus: res.currentTaskStatus,
              progress: res.progress,
            };
          })
        );
        const activeSubagents = [...subagentInstances.values()].map((s) => ({
          id: s.id,
          typeName: s.typeName,
          role: s.role,
          status: s.status,
          prompt: s.prompt,
          currentTask: s.prompt,
        }));
        const runningProcs = [...backgroundTasks.values()]
          .filter((t) => !t.hasExited && !t.isHidden)
          .map((t) => ({ id: t.id, command: t.command, pid: t.process?.pid }));

        const data = {
          masterAgent: {
            isRunning: isMasterRunning,
            promptTokens: masterPromptTokens,
            completionTokens: masterCompletionTokens,
          },
          superagents: activeSuperagents,
          subagents: activeSubagents,
          backgroundTasks: runningProcs,
          timestamp: Date.now(),
        };

        return {
          contents: [
            {
              uri,
              mimeType: "application/json",
              text: JSON.stringify(data, null, 2),
            },
          ],
        };
      }

      case "superagent://config/current": {
        const data = {
          activeProvider: getActiveProviderName(),
          configuredProviders: getConfiguredProviders(),
          presets: {
            single: getActivePresetId("single") || "default",
            multi: getActivePresetId("multi") || "default",
          },
          effectiveModels: {
            single: getEffectiveMasterModel("single"),
            multi: getEffectiveMasterModel("multi"),
          },
          tierModels: getAllTierModels("multi"),
          settings: getSettings(),
        };

        return {
          contents: [
            {
              uri,
              mimeType: "application/json",
              text: JSON.stringify(data, null, 2),
            },
          ],
        };
      }

      case "superagent://workspace/info": {
        const cwd = getMcpWorkspacePath();
        let branch = "unknown";
        try {
          const { execSync } = await import("child_process");
          branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd, encoding: "utf-8", windowsHide: true }).trim();
        } catch {}

        const worktrees = loadRegistry();
        const data = {
          workspacePath: cwd,
          gitBranch: branch,
          worktrees,
        };

        return {
          contents: [
            {
              uri,
              mimeType: "application/json",
              text: JSON.stringify(data, null, 2),
            },
          ],
        };
      }

      case "superagent://history/sessions": {
        const sessions = listSessionsFromDb(25);
        return {
          contents: [
            {
              uri,
              mimeType: "application/json",
              text: JSON.stringify(sessions, null, 2),
            },
          ],
        };
      }

      case "superagent://memory/pinned": {
        const pinned = getAllPinnedKnowledgeFromDb();
        return {
          contents: [
            {
              uri,
              mimeType: "application/json",
              text: JSON.stringify(pinned, null, 2),
            },
          ],
        };
      }

      case "superagent://instructions/agentic-mcp": {
        return {
          contents: [
            {
              uri,
              mimeType: "text/markdown",
              text: getSuperagentMcpInstructions(),
            },
          ],
        };
      }

      default:
        throw new Error(`Resource not found: ${uri}`);
    }
  });

  // 3. List Prompts
  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    requireScope();
    return {
      prompts: [
        {
          name: "superagent_orchestrate",
          description: "Template for orchestrating feature development across the 3-tier multi-agent architecture.",
          arguments: [
            {
              name: "feature",
              description: "The feature description or task to implement",
              required: true,
            },
            {
              name: "acceptanceCriteria",
              description: "Optional comma-separated acceptance criteria checklist",
              required: false,
            },
          ],
        },
        {
          name: "superagent_debug",
          description: "Template for systematic debugging and root-cause tracing with Superagent subagents.",
          arguments: [
            {
              name: "error",
              description: "The error message, stack trace, or failing symptom to diagnose",
              required: true,
            },
            {
              name: "file",
              description: "Optional suspected file path or component",
              required: false,
            },
          ],
        },
        {
          name: "superagent_review",
          description: "Template for automated subagent code review against acceptance criteria and safety constraints.",
          arguments: [
            {
              name: "targetBranch",
              description: "The feature branch to review",
              required: false,
            },
          ],
        },
        {
          name: "superagent_agentic_mcp",
          description: "Template for authorized general-purpose task execution using MCP tools, verification, and confirmation gates.",
          arguments: [
            {
              name: "task",
              description: "The task or objective to execute autonomously via MCP tools",
              required: true,
            },
            {
              name: "targetWorkspace",
              description: "Target workspace or project directory path (optional)",
              required: false,
            },
            {
              name: "constraints",
              description: "Optional execution constraints, rules, or testing commands",
              required: false,
            },
          ],
        },
      ],
    };
  });

  // 4. Get Prompt
  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    requireScope();
    const { name, arguments: args = {} } = request.params;

    switch (name) {
      case "superagent_orchestrate": {
        const feature = String(args.feature || "");
        const criteria = args.acceptanceCriteria ? String(args.acceptanceCriteria) : "";
        const promptText = [
          `# Feature Implementation Goal: ${feature}`,
          criteria ? `\n## Acceptance Criteria:\n${criteria}` : "",
          `\n## Multi-Agent Execution Strategy:`,
          `1. Use 'superagent_invoke' to spawn a dedicated Superagent in an isolated Git worktree branch.`,
          `2. Monitor progress via 'superagent_get_process_status'.`,
          `3. Run verification tests in worktree using 'superagent_exec_command'.`,
          `4. Merge completed work into the main branch with 'superagent_merge'.`,
        ].filter(Boolean).join("\n");

        return {
          description: `Orchestrate: ${feature}`,
          messages: [
            {
              role: "user",
              content: {
                type: "text",
                text: promptText,
              },
            },
          ],
        };
      }

      case "superagent_debug": {
        const error = String(args.error || "");
        const file = args.file ? String(args.file) : "";
        const promptText = [
          `# Systematic Debugging Task`,
          `Target Issue / Error:\n${error}`,
          file ? `\nSuspected File: ${file}` : "",
          `1. Search for relevant definitions using 'superagent_grep_search' and inspect related files in one call with 'superagent_read_files'.`,
          `2. Trace the error call stack and inspect recent execution logs with 'superagent_get_logs'.`,
          `3. Isolate minimal failing test case and verify fix before committing.`,
        ].filter(Boolean).join("\n");

        return {
          description: `Debug: ${error.slice(0, 60)}...`,
          messages: [
            {
              role: "user",
              content: {
                type: "text",
                text: promptText,
              },
            },
          ],
        };
      }

      case "superagent_review": {
        const targetBranch = String(args.targetBranch || "current");
        const promptText = [
          `# Subagent Code Review`,
          `Target Branch: ${targetBranch}`,
          `\n## Review Instructions:`,
          `1. Inspect changes using 'superagent_manage_worktrees' and batch related reads with 'superagent_read_files'.`,
          `2. Verify that all changes adhere to architectural constraints and contain no regressions.`,
          `3. Run unit tests via 'superagent_exec_command' and return a structured review report.`,
        ].join("\n");

        return {
          description: `Code Review: ${targetBranch}`,
          messages: [
            {
              role: "user",
              content: {
                type: "text",
                text: promptText,
              },
            },
          ],
        };
      }

      case "superagent_agentic_mcp": {
        const task = String(args.task || "");
        const targetWorkspace = args.targetWorkspace ? String(args.targetWorkspace) : "";
        const constraints = args.constraints ? String(args.constraints) : "";
        const promptText = [
          `# AUTONOMOUS MCP AGENTIC EXECUTION MANDATE`,
          `Task Objective: ${task}`,
          targetWorkspace ? `Target Workspace: ${targetWorkspace}` : "",
          constraints ? `Specific Constraints:\n${constraints}` : "",
          `\n## EXECUTION PROTOCOL (TOOL_FIRST):`,
          `1. ACTION-BASED ROUTING: Use MCP tools when the requested work requires actions or fresh evidence; ordinary questions and drafting can be answered directly.`,
          `2. NEVER DELEGATE TO USER: Never tell the user to run commands, edit files, or test changes manually. Execute commands with 'superagent_exec_command'; batch reads/writes with 'superagent_read_files' and 'superagent_write_files'; use 'superagent_replace_file_content' for targeted edits. Legacy 'superagent_read_file' and 'superagent_write_file' endpoints are disabled.`,
          `3. INTENT-BASED DYNAMIC GATEWAY DISCOVERY & ROUTING: The MCP catalog initially advertises a lean, curated core set of tools. Infer the user's goal automatically and discover the right tools yourself — NEVER wait for the user to name a tool. When a specialized tool is not in the initial catalog (e.g. Delegate Chat & History, file ops, browser automation, media/PDF tools, or multi-agent orchestration), call 'superagent_tool_search({ intent: "<user goal>" })', inspect its schema with 'superagent_tool_describe', and dispatch it with 'superagent_tool_execute'.`,
          `4. SAFE EXECUTION LOOP: Inspect -> Plan when needed -> Act when authorized -> Verify -> Conclude. Respect confirmation, permission and destructive-action gates; never infer consent from ambiguous replies.`,
          `5. RIGOROUS VERIFICATION: Verify the requested outcome appropriately; for coding changes, run relevant project tests and builds with authorized tools.`,
          `6. RESILIENT RECOVERY: If a tool fails, analyze the error output, adapt your parameters, and retry. Never output raw error dumps or surrender.`,
        ].filter(Boolean).join("\n");

        return {
          description: `Agentic MCP: ${task.slice(0, 60)}...`,
          messages: [
            {
              role: "user",
              content: {
                type: "text",
                text: promptText,
              },
            },
          ],
        };
      }

      default:
        throw new Error(`Prompt template not found: ${name}`);
    }
  });
}

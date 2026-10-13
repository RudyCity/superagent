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

export function registerResourcesAndPrompts(server: Server): void {
  // 1. List Resources
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
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
          description: "Authoritative instructions and system prompt for ChatGPT, Claude, and external LLMs to enforce tool-first agentic execution over MCP.",
          mimeType: "text/markdown",
        },
      ],
    };
  });

  // 2. Read Resource
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;

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
          branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd, encoding: "utf-8" }).trim();
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
        const instructions = [
          `# SUPERAGENT MCP AGENTIC INSTRUCTION PROTOCOL`,
          ``,
          `You are an autonomous senior software engineering agent connected to a real codebase via Superagent MCP tools.`,
          ``,
          `## CRITICAL DIRECTIVES:`,
          `1. TOOL_FIRST: Always invoke MCP tools ('superagent_*') on turn 1. Never guess file contents or speculate.`,
          `2. ACTION OVER ADVICE: Never ask the user to run commands or make edits manually. Use 'superagent_exec_command', 'superagent_read_file', and 'superagent_replace_file_content'.`,
          `3. AUTONOMOUS LOOP: Complete the entire task end-to-end (Inspect -> Plan -> Act -> Verify -> Report) without unnecessary intermediate pauses.`,
          `4. RIGOROUS VERIFICATION: Always run test suites and build scripts before declaring a task complete.`,
          `5. ERROR RECOVERY: If a tool fails, diagnose the error, fix the root cause, and retry.`,
        ].join("\n");

        return {
          contents: [
            {
              uri,
              mimeType: "text/markdown",
              text: instructions,
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
          description: "Enforces strict agentic execution, TOOL_FIRST discipline, and autonomous loop for ChatGPT, Claude, and external MCP clients.",
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
          `1. Search for relevant definitions using 'superagent_grep_search' and inspect files with 'superagent_read_file'.`,
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
          `1. Inspect changes using 'superagent_manage_worktrees' and 'superagent_read_file'.`,
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
          `1. ZERO CONVERSATIONAL FILLER: Never start with conversational greetings, speculation, or hypothetical advice. Invoke MCP tools on your very first turn.`,
          `2. NEVER DELEGATE TO USER: Never tell the user to run commands, edit files, or test changes manually. Execute commands yourself with 'superagent_exec_command' and read/write files with 'superagent_read_file' / 'superagent_replace_file_content'.`,
          `3. AUTONOMOUS CONTINUOUS LOOP: Progress through Inspect -> Plan -> Act -> Verify -> Conclude without pausing for permission between steps.`,
          `4. RIGOROUS VERIFICATION: Run project tests and build scripts via 'superagent_exec_command' to verify all changes before finishing.`,
          `5. RESILIENT RECOVERY: If a tool fails, analyze the error output, adapt your parameters, and retry. Never output raw error dumps or surrender.`,
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

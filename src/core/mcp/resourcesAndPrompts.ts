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
      ],
    };
  });

  // 2. Read Resource
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;

    switch (uri) {
      case "superagent://status/live": {
        const isMasterRunning = masterAgentRef ? (masterAgentRef.isAgentRunning?.() ?? false) : false;
        const activeSuperagents = [...superagentInstances.values()].map((i) => ({
          id: i.id,
          role: i.role,
          branch: i.branch,
          status: i.status,
          task: i.task,
        }));
        const activeSubagents = [...subagentInstances.values()].map((s) => ({
          id: s.id,
          typeName: s.typeName,
          role: s.role,
          status: s.status,
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
        const cwd = process.cwd();
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
          `\n## Debugging Plan:`,
          `1. Dispatch a 'researcher' subagent using 'superagent_spawn_subagent' to trace the error call stack.`,
          `2. Search for relevant definitions using 'superagent_grep_search'.`,
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

      default:
        throw new Error(`Prompt template not found: ${name}`);
    }
  });
}

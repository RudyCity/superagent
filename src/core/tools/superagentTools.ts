/**
 * superagentTools.ts — Tools for the Master Agent to orchestrate Superagents.
 *
 * Tools:
 *   invoke_superagent  — spawn a Superagent in an isolated git worktree
 *   await_superagents  — poll until all active Superagents finish
 *   merge_superagents  — merge all completed Superagent branches via MasterAgent
 */

import path from "path";
import fs from "fs";
import { execa } from "execa";
import { Tool } from "./types.js";
import {
  superagentInstances,
  notifySuperagentsChanged,
  activeQuestionHandler,
  addHistoricalSuperagentTokens,
  appendMasterLog,
} from "./state.js";
import { agentLocalStorage } from "../agent.js";
import { MasterAgent } from "../masterAgent.js";
import { ensureGitIgnore, pruneWorktrees } from "../workspaceIsolation.js";

const SUPERAGENT_REPORT_INSTRUCTION = `
When you have completed your task, provide a final report formatted exactly as:

### SUPERAGENT TASK REPORT
- **Role**: [your role]
- **Branch**: [your branch]
- **Worktree**: [your worktree path]
- **Task Completed**: [brief description]
- **Files Changed**:
  - [path/to/file]: [what changed]
- **Tests**: [passed / failed / not applicable]
- **Notes**: [issues, blockers, or recommendations]
- **Status**: Completed / Blocked / Partial
`;

// ─── invoke_superagent ────────────────────────────────────────────────────────

export const invokeSuperagentTool: Tool = {
  name: "invoke_superagent",
  description:
    "Spawn a Superagent to develop a feature in an isolated git worktree on its own branch. " +
    "Only callable by the Master Agent (depth 0). " +
    "Returns immediately with a Superagent ID; use await_superagents to wait for completion.",
  parameters: {
    type: "object",
    properties: {
      role: {
        type: "string",
        description: "Descriptive role name, e.g. 'auth-developer', 'ui-developer'",
      },
      task: {
        type: "string",
        description: "Full task description for the Superagent — be specific and self-contained",
      },
      branch: {
        type: "string",
        description: "Git branch name for this feature, e.g. 'feat/auth-module'",
      },
      wait: {
        type: "boolean",
        description: "If true, block and wait for the Superagent to finish before returning. Default: false (parallel).",
      },
      typeName: {
        type: "string",
        description: "The name of the defined Superagent type to invoke (optional).",
      },
    },
    required: ["role", "task", "branch"],
  },

  async execute(args, cwd, signal) {
    const role = args.role as string;
    const task = args.task as string;
    const branch = args.branch as string;
    const typeName = args.typeName as string | undefined;
    const wait = args.wait === true;

    // Only depth-0 (Master Agent) may invoke Superagents
    const parentAgent = agentLocalStorage.getStore();
    const parentDepth = parentAgent ? parentAgent.delegationDepth : 0;
    if (parentDepth > 0) {
      return `Error: invoke_superagent can only be called by the Master Agent (depth 0). ` +
             `You are at depth ${parentDepth}. Use invoke_subagent instead.`;
    }

    if (parentAgent && parentAgent.planState !== "APPROVED") {
      if (parentAgent.planState === "PLANNING_PENDING") {
        return `Error: Spawning or merging Superagents is blocked. A plan is pending approval. You must wait for the user to approve the plan using the interactive approval wizard before starting execution.`;
      } else {
        return `Error: Spawning or merging Superagents is blocked. You must first write an implementation plan to '${parentAgent.getPlanFilePath()}' and have the user approve it before you can invoke any Superagents.`;
      }
    }

    // Sanitize branch name for use as a directory name
    const safeBranchName = branch.replace(/\//g, "-").replace(/[^a-zA-Z0-9-_]/g, "");

    // Ensure .gitignore has .worktrees and prune orphaned worktrees
    ensureGitIgnore();
    try {
      await pruneWorktrees();
    } catch {
      // Ignore if not in git
    }

    // Create .worktrees directory if it doesn't exist
    const worktreesDir = path.join(cwd, ".worktrees");
    if (!fs.existsSync(worktreesDir)) {
      fs.mkdirSync(worktreesDir, { recursive: true });
    }
    const worktreePath = path.join(worktreesDir, safeBranchName);

    // Create git worktree + branch
    if (fs.existsSync(worktreePath)) {
      // Worktree already exists — reuse it
    } else {
      try {
        await execa("git", ["worktree", "add", "-b", branch, worktreePath], { cwd });
      } catch {
        // Branch might already exist — try without -b
        try {
          await execa("git", ["worktree", "add", worktreePath, branch], { cwd });
        } catch (err2: any) {
          return `Error: Failed to create git worktree for branch "${branch}" at "${worktreePath}": ${err2.message}`;
        }
      }
    }

    const superagentId = Math.random().toString(36).substring(2, 9);
    const logs: string[] = [];
    let lastTextIdx = -1;

    function appendToThinkingNode(text: string) {
      if (lastTextIdx === -1) {
        logs.push(`[THINK] `);
        lastTextIdx = logs.length - 1;
      }
      logs[lastTextIdx] += text;
    }

    function closeThinkingNode() {
      if (lastTextIdx >= 0) {
        const trimmed = logs[lastTextIdx].replace("[THINK]", "").trim();
        if (!trimmed) {
          logs.pop();
        } else {
          logs[lastTextIdx] = logs[lastTextIdx].trimEnd() + "\n";
        }
        lastTextIdx = -1;
      }
    }

    // Build full system prompt for this Superagent
    const { SUPERAGENT_SYSTEM_PROMPT } = await import("../prompts.js");
    let basePrompt = SUPERAGENT_SYSTEM_PROMPT(role, branch, worktreePath);

    if (typeName) {
      const { superagentTypes } = await import("./state.js");
      const customType = superagentTypes.get(typeName);
      if (customType) {
        basePrompt += "\n\n### CUSTOM ROLE SPECIFIC RULES:\n" + customType.systemPrompt;
      }
    }

    // Inject active peer Superagents context to prevent overlap
    const activePeers = [...superagentInstances.entries()]
      .filter(([_, inst]) => inst.status === "running")
      .map(([id, inst]) => `- **Session ID**: ${id}\n  - **Role**: ${inst.role}\n  - **Branch**: ${inst.branch}\n  - **Task**: "${inst.task}"`)
      .join("\n");

    if (activePeers) {
      basePrompt += "\n\n### ACTIVE PEER SUPERAGENTS:\n" +
        "The following other Superagents are currently running in parallel. Coordinate with them to avoid overlapping work or conflicts:\n" +
        activePeers;
    }

    const systemPrompt = basePrompt + "\n\n" + SUPERAGENT_REPORT_INSTRUCTION;

    // Dynamic import to avoid circular dependency at module load time
    const { Agent } = await import("../agent.js");
    const { superagentToolset } = await import("./toolsets.js");

    const agentInstance = new Agent(
      (event) => {
        if (event.type === "text") {
          appendToThinkingNode(event.content);
          notifySuperagentsChanged();
        } else if (event.type === "error") {
          closeThinkingNode();
          logs.push(`[ERROR] ${event.message}\n`);
          notifySuperagentsChanged();
        } else if (event.type === "tool_start") {
          closeThinkingNode();
          logs.push(`[TOOL:START] ${event.toolCall.name} — ${event.description}\n`);
          notifySuperagentsChanged();
        } else if (event.type === "tool_end") {
          closeThinkingNode();
          const status = event.toolResult.isError ? "FAIL" : "OK";
          const resultSnippet = event.toolResult.result.slice(0, 120).replace(/\n/g, " ");
          logs.push(`[TOOL:${status}] ${event.toolResult.name} → ${resultSnippet}\n`);
          notifySuperagentsChanged();
        } else if (event.type === "token_usage") {
          const inst = superagentInstances.get(superagentId);
          if (inst) {
            inst.tokenUsage = {
              prompt: (inst.tokenUsage?.prompt || 0) + (event.promptTokens || 0),
              completion: (inst.tokenUsage?.completion || 0) + (event.completionTokens || 0),
            };
            if (event.durationMs && event.durationMs > 0 && event.completionTokens > 0) {
              inst.speed = event.completionTokens / (event.durationMs / 1000);
            }
          }
          addHistoricalSuperagentTokens((event.promptTokens || 0) + (event.completionTokens || 0));
          notifySuperagentsChanged();
        }
      },
      // Permission handler: auto-approve but never approve destructive commands
      async (_toolCall, _desc) => {
        const cmd = (_toolCall.args.command as string || "").trim();
        const isDestructive = /(rm\s+-rf\s+[/~]|git\s+reset\s+--hard|git\s+clean\s+-fd|mkfs|dd\s+if=)/i.test(cmd);
        return !isDestructive;
      },
      // Question handler: forward to user via active handler
      async (question, options) => {
        if (activeQuestionHandler) {
          return activeQuestionHandler(`[Superagent "${role}"]: ${question}`, options);
        }
        return options[0] ?? "";
      },
      systemPrompt,
      superagentToolset,
      worktreePath
    );

    // Mark as superagent tier, set working directory to worktree
    agentInstance.delegationDepth = 1;
    agentInstance.tier = "superagent";
    agentInstance.worktreePath = worktreePath;
    agentInstance.isMultiAgent = true;

    // Register the instance in global state
    const instance = {
      id: superagentId,
      role,
      task,
      branch,
      worktreePath,
      agent: agentInstance,
      status: "running" as const,
      logs,
      tokenUsage: { prompt: 0, completion: 0 },
      historyFilePath: agentInstance.getCurrentHistoryFilePath(),
      customTypeName: typeName,
    };
    superagentInstances.set(superagentId, instance);
    notifySuperagentsChanged();
    appendMasterLog(`[INFO] Spawning Superagent "${role}" on branch ${branch}...`);

    const run = async (): Promise<string> => {
      try {
        await agentInstance.sendMessage(task);
        closeThinkingNode();

        // Capture final report from last assistant message
        const msgs = agentInstance.getHistory().getMessages();
        const lastMsg = [...msgs].reverse().find((m) => m.role === "assistant");
        const result = lastMsg?.content ?? "(no report)";

        superagentInstances.set(superagentId, {
          ...superagentInstances.get(superagentId)!,
          status: "completed",
          result,
          completedAt: Date.now(),
        });
        notifySuperagentsChanged();
        appendMasterLog(`[INFO] Superagent "${role}" (branch: ${branch}) completed successfully.`);

        return `Superagent "${role}" (branch: ${branch}) completed.\n\nReport:\n${result}`;
      } catch (err: any) {
        closeThinkingNode();
        superagentInstances.set(superagentId, {
          ...superagentInstances.get(superagentId)!,
          status: "error",
          completedAt: Date.now(),
        });
        notifySuperagentsChanged();
        appendMasterLog(`[ERROR] Superagent "${role}" (branch: ${branch}) failed: ${err.message}`);
        return `Superagent "${role}" failed: ${err.message}`;
      }
    };

    if (wait) {
      return await run();
    } else {
      // Fire and forget — returns immediately
      run().catch(() => {});
      return (
        `Superagent "${role}" spawned in background.\n` +
        `  ID:       ${superagentId}\n` +
        `  Branch:   ${branch}\n` +
        `  Worktree: ${worktreePath}\n` +
        `Use await_superagents to wait for all to finish.`
      );
    }
  },
};

// ─── await_superagents ────────────────────────────────────────────────────────

export const awaitSuperagentsTool: Tool = {
  name: "await_superagents",
  description:
    "Wait for all active Superagents to finish their work. " +
    "Polls every 2 seconds until all reach completed/error status. " +
    "Returns a summary report from each Superagent.",
  parameters: {
    type: "object",
    properties: {
      timeoutSeconds: {
        type: "number",
        description: "Maximum seconds to wait before giving up. Defaults to 600 (10 minutes).",
      },
    },
    required: [],
  },
  async execute(args, _cwd, signal) {
    const timeoutMs = ((args.timeoutSeconds as number) || 600) * 1000;
    const start = Date.now();

    const running = [...superagentInstances.values()].filter(
      (i) => i.status === "running"
    );
    const paused = [...superagentInstances.values()].filter(
      (i) => i.status === "paused"
    );

    if (running.length === 0 && paused.length > 0) {
      const pausedList = paused.map(p => `"${p.role}" (ID: ${p.id}, Branch: ${p.branch})`).join(", ");
      return `Wait blocked: There are no running Superagents, but there are paused Superagents: ${pausedList}.\n` +
             `You MUST resume them using "send_message_to_superagent" to continue their work before you can await them.`;
    }

    if (running.length === 0) {
      return "No running Superagents found. All may have already completed.";
    }

    // Poll loop
    while (true) {
      if (signal?.aborted) return "Aborted while waiting for Superagents.";
      if (Date.now() - start > timeoutMs) {
        const stillRunning = [...superagentInstances.values()]
          .filter((i) => i.status === "running")
          .map((i) => `"${i.role}" (${i.branch})`);
        return `Timeout after ${timeoutMs / 1000}s. Still running: ${stillRunning.join(", ")}`;
      }

      const hasRunning = [...superagentInstances.values()].some(
        (i) => i.status === "running"
      );
      const hasPaused = [...superagentInstances.values()].some(
        (i) => i.status === "paused"
      );

      if (!hasRunning) {
        if (hasPaused) {
          const pausedList = [...superagentInstances.values()]
            .filter((i) => i.status === "paused")
            .map(p => `"${p.role}" (ID: ${p.id}, Branch: ${p.branch})`).join(", ");
          return `Wait blocked: All running Superagents finished, but there are paused Superagents: ${pausedList}.\n` +
                 `You MUST resume them using "send_message_to_superagent" to continue their work before you can await them.`;
        }
        break;
      }

      await new Promise((r) => setTimeout(r, 2000));
    }

    // Build summary
    const lines: string[] = ["All Superagents finished:\n"];
    for (const inst of superagentInstances.values()) {
      const icon = inst.status === "completed" ? "✅" : "❌";
      lines.push(`${icon} ${inst.role} (${inst.branch}) — ${inst.status}`);
      if (inst.tokenUsage) {
        const total = inst.tokenUsage.prompt + inst.tokenUsage.completion;
        lines.push(`   Tokens used: ${total.toLocaleString()}`);
      }
      if (inst.result) {
        const preview =
          inst.result.length > 300
            ? inst.result.slice(0, 300) + "..."
            : inst.result;
        lines.push(`   Report:\n${preview.split("\n").map((l) => `     ${l}`).join("\n")}`);
      }
      lines.push("");
    }
    return lines.join("\n");
  },
};

// ─── merge_superagents ────────────────────────────────────────────────────────

export const mergeSuperagentsTool: Tool = {
  name: "merge_superagents",
  description:
    "Merge all completed Superagent branches into the current branch using AI-assisted conflict resolution. " +
    "Only callable by the Master Agent (depth 0). " +
    "Optionally removes worktree directories after merging.",
  parameters: {
    type: "object",
    properties: {
      cleanupWorktrees: {
        type: "boolean",
        description: "Remove worktree directories after a successful merge. Defaults to true.",
      },
    },
    required: [],
  },

  async execute(args, cwd, signal) {
    const cleanup = args.cleanupWorktrees !== false;

    // Only Master Agent may merge
    const parentAgent = agentLocalStorage.getStore();
    const parentDepth = parentAgent ? parentAgent.delegationDepth : 0;
    if (parentDepth > 0) {
      return `Error: merge_superagents can only be called by the Master Agent (depth 0).`;
    }

    if (parentAgent && parentAgent.planState !== "APPROVED") {
      if (parentAgent.planState === "PLANNING_PENDING") {
        return `Error: Spawning or merging Superagents is blocked. A plan is pending approval. You must wait for the user to approve the plan using the interactive approval wizard before starting execution.`;
      } else {
        return `Error: Spawning or merging Superagents is blocked. You must first write an implementation plan to '${parentAgent.getPlanFilePath()}' and have the user approve it before you can invoke any Superagents.`;
      }
    }

    const completed = [...superagentInstances.values()].filter(
      (i) => i.status === "completed"
    );
    if (completed.length === 0) {
      return "No completed Superagents to merge. Run await_superagents first.";
    }

    // Build LLM model instance for conflict resolution (uses Master Agent's model)
    const { getModelInstanceForTier } = await import("../config.js");
    const model = getModelInstanceForTier("master", 0);

    const master = new MasterAgent(model);
    const results: string[] = [`Merging ${completed.length} Superagent branch(es):\n`];

    for (const inst of completed) {
      // Discover which files were changed in the feature branch
      let changedFiles: string[] = [];
      try {
        const { stdout } = await execa(
          "git",
          ["diff", "--name-only", `HEAD...${inst.branch}`],
          { cwd }
        );
        changedFiles = stdout.split("\n").filter(Boolean);
      } catch {
        // If diff fails, pass empty list — MasterAgent will resolve all conflicts
      }

      const success = await master.mergeBranch(inst.branch, changedFiles);

      if (success) {
        results.push(`  ✅ Merged: ${inst.branch} (${inst.role})`);

        // Cleanup worktree
        if (cleanup && inst.worktreePath && fs.existsSync(inst.worktreePath)) {
          try {
            await execa("git", ["worktree", "remove", inst.worktreePath, "--force"], { cwd });
            results.push(`     Worktree removed: ${inst.worktreePath}`);
          } catch (err: any) {
            results.push(`     Worktree remove failed: ${err.message}`);
          }
        }

        // Remove from tracking
        superagentInstances.delete(inst.id);
        notifySuperagentsChanged();
      } else {
        results.push(`  ❌ Merge failed: ${inst.branch} (${inst.role}) — manual resolution required`);
        // Mark as error so it shows in dashboard
        superagentInstances.set(inst.id, { ...inst, status: "error" });
        notifySuperagentsChanged();
      }
    }

    return results.join("\n");
  },
};

async function cleanupWorktreeRobust(worktreePath: string, logs: string[], cwd: string) {
  if (worktreePath && fs.existsSync(worktreePath)) {
    try {
      // Cooldown delay for Windows file handles
      await new Promise((resolve) => setTimeout(resolve, 200));
      await execa("git", ["worktree", "remove", worktreePath, "--force"], { cwd });
      logs.push(`[CLEANUP] Worktree removed successfully: ${worktreePath}\n`);
    } catch (err: any) {
      logs.push(`[CLEANUP] git worktree remove failed: ${err.message}. Trying filesystem force remove...\n`);
      try {
        fs.rmSync(worktreePath, { recursive: true, force: true });
        await execa("git", ["worktree", "prune"], { cwd });
        logs.push(`[CLEANUP] Worktree directory force removed and pruned.\n`);
      } catch (fsErr: any) {
        logs.push(`[CLEANUP] Filesystem force remove failed: ${fsErr.message}\n`);
      }
    }
  }
}

// ─── manage_superagents ───────────────────────────────────────────────────────

export const manageSuperagentsTool: Tool = {
  name: "manage_superagents",
  description: "List active Superagents, check logs, retrieve reports, or terminate them.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "logs", "report", "kill", "kill_all"],
        description: "Action to perform",
      },
      superagentIds: {
        type: "array",
        items: { type: "string" },
        description: "List of Superagent IDs to kill or read logs/reports from",
      },
    },
    required: ["action"],
  },
  async execute(args, cwd, signal) {
    const action = args.action as string;
    const superagentIds = args.superagentIds as string[];

    // Only Master Agent (depth 0) may manage Superagents
    const parentAgent = agentLocalStorage.getStore();
    const parentDepth = parentAgent ? parentAgent.delegationDepth : 0;
    if (parentDepth > 0) {
      return `Error: manage_superagents can only be called by the Master Agent (depth 0).`;
    }

    if (action === "list") {
      const lines: string[] = ["Active Superagent Instances:"];
      if (superagentInstances.size === 0) lines.push("  None");
      for (const [id, inst] of superagentInstances.entries()) {
        let line = `  - ID: ${id} | Role: ${inst.role} | Branch: ${inst.branch} | Status: ${inst.status}`;
        if (inst.status === "completed" && inst.result) {
          const snippet = inst.result.length > 120 ? inst.result.slice(0, 120) + "..." : inst.result;
          line += `\n    Report: ${snippet.replace(/\n/g, "\n    ")}`;
        }
        lines.push(line);
      }
      return lines.join("\n");
    }

    if (action === "logs") {
      if (!superagentIds || superagentIds.length === 0) {
        return "Error: superagentIds is required to retrieve logs.";
      }
      const id = superagentIds[0];
      const inst = superagentInstances.get(id);
      if (!inst) {
        return `Error: Superagent instance "${id}" not found.`;
      }
      return `Logs for Superagent ${id} (${inst.role}):\n${inst.logs.join("") || "(no logs yet)"}`;
    }

    if (action === "report") {
      if (!superagentIds || superagentIds.length === 0) {
        return "Error: superagentIds is required to retrieve the report.";
      }
      const id = superagentIds[0];
      const inst = superagentInstances.get(id);
      if (!inst) {
        return `Error: Superagent instance "${id}" not found.`;
      }
      return `Report for Superagent ${id} (${inst.role}):\n\n${inst.result || "No report available yet."}`;
    }

    if (action === "kill") {
      if (!superagentIds || superagentIds.length === 0) {
        return "Error: superagentIds is required for kill action.";
      }
      for (const id of superagentIds) {
        const inst = superagentInstances.get(id);
        if (inst) {
          inst.agent.abort();
          inst.status = "error";
          inst.completedAt = Date.now();
          inst.logs.push("[TERMINATED] Superagent terminated by Master Agent.\n");
          if (inst.worktreePath) {
            await cleanupWorktreeRobust(inst.worktreePath, inst.logs, cwd);
          }
        }
      }
      notifySuperagentsChanged();
      return `Terminated Superagents: ${superagentIds.join(", ")}`;
    }

    if (action === "kill_all") {
      const terminated: string[] = [];
      for (const [id, inst] of superagentInstances.entries()) {
        if (inst.status === "running") {
          inst.agent.abort();
          inst.status = "error";
          inst.completedAt = Date.now();
          inst.logs.push("[TERMINATED] Superagent terminated by Master Agent.\n");
          if (inst.worktreePath) {
            await cleanupWorktreeRobust(inst.worktreePath, inst.logs, cwd);
          }
          terminated.push(id);
        }
      }
      notifySuperagentsChanged();
      return `All running Superagent instances terminated. Terminated: ${terminated.join(", ")}`;
    }

    return `Error: Unknown action "${action}"`;
  },
};

// ─── define_superagent ────────────────────────────────────────────────────────

export const defineSuperagentTool: Tool = {
  name: "define_superagent",
  description: "Define a new Superagent type with specialized rules and a custom system prompt.",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Unique type name of the Superagent",
      },
      description: {
        type: "string",
        description: "A description of what this Superagent type specializes in",
      },
      systemPrompt: {
        type: "string",
        description: "The custom system prompt defining additional rules and guidelines for this Superagent. This will be appended to the base Superagent system prompt.",
      },
    },
    required: ["name", "description", "systemPrompt"],
  },
  async execute(args, cwd, signal) {
    // Only Master Agent (depth 0) can define Superagent types
    const parentAgent = agentLocalStorage.getStore();
    const parentDepth = parentAgent ? parentAgent.delegationDepth : 0;
    if (parentDepth > 0) {
      return `Error: define_superagent can only be called by the Master Agent (depth 0).`;
    }

    const name = args.name as string;
    const description = args.description as string;
    const systemPrompt = args.systemPrompt as string;

    const { registerSuperagentType } = await import("./state.js");
    registerSuperagentType(name, description, systemPrompt);
    return `Superagent type "${name}" defined successfully.`;
  },
};

// ─── send_message_to_superagent ───────────────────────────────────────────────

export const sendMessageToSuperagentTool: Tool = {
  name: "send_message_to_superagent",
  description: "Send a follow-up message or instruction to an active Superagent.",
  parameters: {
    type: "object",
    properties: {
      superagentId: {
        type: "string",
        description: "The ID of the active Superagent",
      },
      message: {
        type: "string",
        description: "The follow-up message/instruction to send",
      },
      wait: {
        type: "boolean",
        description: "Whether to wait synchronously for the Superagent to finish and return its report. Defaults to false (parallel).",
      },
    },
    required: ["superagentId", "message"],
  },
  async execute(args, cwd, signal) {
    // Only Master Agent (depth 0) may call this tool
    const parentAgent = agentLocalStorage.getStore();
    const parentDepth = parentAgent ? parentAgent.delegationDepth : 0;
    if (parentDepth > 0) {
      return `Error: send_message_to_superagent can only be called by the Master Agent (depth 0).`;
    }

    const superagentId = args.superagentId as string;
    const message = args.message as string;
    const wait = args.wait === true;

    const inst = superagentInstances.get(superagentId);
    if (!inst) {
      return `Error: Superagent instance "${superagentId}" not found.`;
    }

    if (inst.status !== "running" && inst.status !== "paused") {
      return `Error: Superagent "${superagentId}" is not running or paused (status: ${inst.status}).`;
    }

    const isPaused = inst.status === "paused";
    let agentInstance = inst.agent;

    if (isPaused) {
      const { role, branch, worktreePath, logs, task, customTypeName } = inst;
      const logsList = logs || [];
      let lastTextIdx = -1;

      const appendToThinkingNode = (text: string) => {
        if (lastTextIdx === -1) {
          logsList.push(`[THINK] `);
          lastTextIdx = logsList.length - 1;
        }
        logsList[lastTextIdx] += text;
      };

      const closeThinkingNode = () => {
        if (lastTextIdx >= 0) {
          const trimmed = logsList[lastTextIdx].replace("[THINK]", "").trim();
          if (!trimmed) {
            logsList.pop();
          } else {
            logsList[lastTextIdx] = logsList[lastTextIdx].trimEnd() + "\n";
          }
          lastTextIdx = -1;
        }
      };

      // Reconstruct system prompt
      const { SUPERAGENT_SYSTEM_PROMPT } = await import("../prompts.js");
      let basePrompt = SUPERAGENT_SYSTEM_PROMPT(role, branch, worktreePath);

      if (customTypeName) {
        const { superagentTypes } = await import("./state.js");
        const customType = superagentTypes.get(customTypeName);
        if (customType) {
          basePrompt += "\n\n### CUSTOM ROLE SPECIFIC RULES:\n" + customType.systemPrompt;
        }
      }

      // Inject active peer Superagents context to prevent overlap
      const activePeers = [...superagentInstances.entries()]
        .filter(([id, other]) => id !== superagentId && other.status === "running")
        .map(([id, other]) => `- **Session ID**: ${id}\n  - **Role**: ${other.role}\n  - **Branch**: ${other.branch}\n  - **Task**: "${other.task}"`)
        .join("\n");

      if (activePeers) {
        basePrompt += "\n\n### ACTIVE PEER SUPERAGENTS:\n" +
          "The following other Superagents are currently running in parallel. Coordinate with them to avoid overlapping work or conflicts:\n" +
          activePeers;
      }

      const systemPrompt = basePrompt + "\n\n" + SUPERAGENT_REPORT_INSTRUCTION;

      const { Agent } = await import("../agent.js");
      const { superagentToolset } = await import("./toolsets.js");

      agentInstance = new Agent(
        (event) => {
          if (event.type === "text") {
            appendToThinkingNode(event.content);
            notifySuperagentsChanged();
          } else if (event.type === "error") {
            closeThinkingNode();
            logsList.push(`[ERROR] ${event.message}\n`);
            notifySuperagentsChanged();
          } else if (event.type === "tool_start") {
            closeThinkingNode();
            logsList.push(`[TOOL:START] ${event.toolCall.name} — ${event.description}\n`);
            notifySuperagentsChanged();
          } else if (event.type === "tool_end") {
            closeThinkingNode();
            const status = event.toolResult.isError ? "FAIL" : "OK";
            const resultSnippet = event.toolResult.result.slice(0, 120).replace(/\n/g, " ");
            logsList.push(`[TOOL:${status}] ${event.toolResult.name} → ${resultSnippet}\n`);
            notifySuperagentsChanged();
          } else if (event.type === "token_usage") {
            const currentInst = superagentInstances.get(superagentId);
            if (currentInst) {
              currentInst.tokenUsage = {
                prompt: (currentInst.tokenUsage?.prompt || 0) + (event.promptTokens || 0),
                completion: (currentInst.tokenUsage?.completion || 0) + (event.completionTokens || 0),
              };
              if (event.durationMs && event.durationMs > 0 && event.completionTokens > 0) {
                currentInst.speed = event.completionTokens / (event.durationMs / 1000);
              }
            }
            addHistoricalSuperagentTokens((event.promptTokens || 0) + (event.completionTokens || 0));
            notifySuperagentsChanged();
          }
        },
        async (_toolCall, _desc) => {
          const cmd = (_toolCall.args.command as string || "").trim();
          const isDestructive = /(rm\s+-rf\s+[/~]|git\s+reset\s+--hard|git\s+clean\s+-fd|mkfs|dd\s+if=)/i.test(cmd);
          return !isDestructive;
        },
        async (question, options) => {
          if (activeQuestionHandler) {
            return activeQuestionHandler(`[Superagent "${role}"]: ${question}`, options);
          }
          return options[0] ?? "";
        },
        systemPrompt,
        superagentToolset,
        worktreePath
      );

      agentInstance.delegationDepth = 1;
      agentInstance.tier = "superagent";
      agentInstance.worktreePath = worktreePath;
      agentInstance.isMultiAgent = true;

      // Load history
      if (inst.historyFilePath) {
        await agentInstance.loadHistoryFromPath(inst.historyFilePath);
      }

      inst.agent = agentInstance;
      inst.status = "running";
      notifySuperagentsChanged();
      appendMasterLog(`[INFO] Resuming Superagent "${role}" (branch: ${branch}) from pause...`);
    }

    inst.logs.push(`[MESSAGE RECEIVED] ${message}\n`);

    const run = async (): Promise<string> => {
      try {
        await agentInstance.sendMessage(message);

        // Capture final report from last assistant message
        let result = inst.result;
        if (agentInstance && typeof agentInstance.getHistory === "function") {
          const msgs = agentInstance.getHistory().getMessages();
          const lastMsg = [...msgs].reverse().find((m) => m.role === "assistant");
          if (lastMsg?.content) {
            result = lastMsg.content;
          }
        }
        if (!result) {
          result = "(no report)";
        }

        superagentInstances.set(superagentId, {
          ...superagentInstances.get(superagentId)!,
          status: "completed",
          result,
          completedAt: Date.now(),
        });
        notifySuperagentsChanged();
        appendMasterLog(`[INFO] Superagent "${inst.role}" (branch: ${inst.branch}) completed successfully.`);

        return `Superagent "${inst.role}" (branch: ${inst.branch}) completed.\n\nReport:\n${result}`;
      } catch (err: any) {
        superagentInstances.set(superagentId, {
          ...superagentInstances.get(superagentId)!,
          status: "error",
          completedAt: Date.now(),
        });
        notifySuperagentsChanged();
        appendMasterLog(`[ERROR] Superagent "${inst.role}" (branch: ${inst.branch}) failed: ${err.message}`);
        return `Superagent "${inst.role}" failed: ${err.message}`;
      }
    };

    if (wait) {
      return await run();
    } else {
      // Fire and forget
      run().catch(() => {});
      return `Message sent to Superagent "${superagentId}". It is resuming and processing in the background.`;
    }
  },
};

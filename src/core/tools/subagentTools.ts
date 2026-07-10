import { Tool, SubagentInstance } from "./types.js";
import { formatUnknownActionError } from "./helpers.js";
import {
  subagentTypes,
  subagentInstances,
  superagentInstances,
  notifySubagentsChanged,
  getMasterAgent,
  getActiveQuestionHandler,
  appendMasterLog
} from "./state.js";
import { agentLocalStorage } from "../agent.js";
import { resolveCarriageReturns } from "../../utils/text.js";
import fs from "fs";
import path from "path";
import os from "os";

/** Directory where subagent JSON reports are persisted. */
const SUBAGENT_REPORTS_DIR = path.join(os.homedir(), ".superagent-r", "subagents");

/**
 * Return the canonical JSON report file path for a given subagent ID.
 */
function subagentReportPath(subagentId: string): string {
  return path.join(SUBAGENT_REPORTS_DIR, `${subagentId}_report.json`);
}

const SUBAGENT_REPORT_INSTRUCTION = (subagentId: string): string => `
CRITICAL INSTRUCTION FOR SUBAGENT REPORTING:
When you have completed your assigned task, or if you are blocked and cannot proceed, you MUST do TWO things:

1. Write a structured JSON report file to: ${subagentReportPath(subagentId)}
   Use write_to_file (or equivalent) with this exact JSON schema:
   {
     "subagentId": "${subagentId}",
     "goal": "<brief description of what you were asked to do>",
     "status": "completed" | "blocked" | "error",
     "actionsTaken": ["<action 1>", "<action 2>", ...],
     "keyFindings": ["<finding 1>", "<finding 2>", ...],
     "nextSteps": "<optional: recommendations for the parent agent>",
     "verificationPassed": true | false
   }

2. Also include a summary in your final response using Markdown:
### SUBAGENT TASK REPORT
- **Goal / Objective**: [Brief description of what you were asked to do]
- **Actions Taken**:
  - [Action 1]
  - [Action 2]
- **Key Findings / Outcomes**:
  - [Detail what you discovered or accomplished]
- **Status & Next Steps**: [Completed / Blocked / Unresolved issues]

IMPORTANT: Writing the JSON file is MANDATORY. The parent agent reads it to track your progress reliably.
`;

/**
 * Extract the best report from a subagent's conversation history.
 * Priority:
 *   1. JSON report file written by subagent (machine-readable, most reliable)
 *   2. Markdown SUBAGENT TASK REPORT section in chat history
 *   3. Any substantial assistant message
 *   4. Last assistant message (fallback)
 */
function extractSubagentReport(agentInstance: any, subagentId?: string): string {
  // 1. Try reading the JSON report file first
  if (subagentId) {
    try {
      const reportFile = subagentReportPath(subagentId);
      if (fs.existsSync(reportFile)) {
        const raw = fs.readFileSync(reportFile, "utf-8");
        const report = JSON.parse(raw);
        // Convert to readable markdown for the parent agent
        const lines: string[] = [
          `### SUBAGENT TASK REPORT (JSON verified)`,
          `- **Goal**: ${report.goal || "N/A"}`,
          `- **Status**: ${report.status || "unknown"}`,
        ];
        if (Array.isArray(report.actionsTaken) && report.actionsTaken.length > 0) {
          lines.push(`- **Actions Taken**:`);
          for (const a of report.actionsTaken) lines.push(`  - ${a}`);
        }
        if (Array.isArray(report.keyFindings) && report.keyFindings.length > 0) {
          lines.push(`- **Key Findings**:`);
          for (const f of report.keyFindings) lines.push(`  - ${f}`);
        }
        if (report.nextSteps) lines.push(`- **Next Steps**: ${report.nextSteps}`);
        if (report.verificationPassed !== undefined) {
          lines.push(`- **Verification**: ${report.verificationPassed ? "✅ passed" : "❌ failed"}`);
        }
        return lines.join("\n");
      }
    } catch {
      // Fall through to markdown extraction
    }
  }

  const msgs = agentInstance.getHistory().getMessages();
  const assistantMsgs = [...msgs].filter((m: any) => m.role === "assistant");

  // 2. Look for messages containing the SUBAGENT TASK REPORT marker
  for (let i = assistantMsgs.length - 1; i >= 0; i--) {
    const content = assistantMsgs[i].content || "";
    if (content.includes("SUBAGENT TASK REPORT") || content.includes("### SUBAGENT TASK REPORT")) {
      return content;
    }
  }

  // 3. Look for any message with substantial text content (not just tool calls)
  for (let i = assistantMsgs.length - 1; i >= 0; i--) {
    const content = assistantMsgs[i].content || "";
    if (content.trim().length > 20) {
      return content;
    }
  }

  // 4. Fallback: last assistant message (even if short)
  const last = assistantMsgs[assistantMsgs.length - 1];
  return last?.content || "";
}

/**
 * Resolve a subagent instance by ID first, then by typeName or role.
 * Returns undefined if no match found.
 */
function resolveSubagentInstance(identifier: string): SubagentInstance | undefined {
  // 1. Try direct ID lookup
  const byId = subagentInstances.get(identifier);
  if (byId) return byId;

  // 2. Try matching by typeName or role (case-insensitive)
  const lower = identifier.toLowerCase();
  for (const [, inst] of subagentInstances.entries()) {
    if (inst.typeName.toLowerCase() === lower || inst.role.toLowerCase() === lower) {
      return inst;
    }
  }

  return undefined;
}

export const defineSubagentTool: Tool = {
  name: "define_subagent",
  description: "Define a new subagent type with a specialized role and system prompt.",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Unique type name of the subagent",
      },
      description: {
        type: "string",
        description: "A description of what this subagent specializes in",
      },
      systemPrompt: {
        type: "string",
        description: "The system prompt defining the subagent's rules and role",
      },
    },
    required: ["name", "description", "systemPrompt"],
  },
  async execute(args, cwd, signal) {
    const name = args.name as string;
    const description = args.description as string;
    const systemPrompt = args.systemPrompt as string;

    subagentTypes.set(name, { name, description, systemPrompt });
    return `Subagent type "${name}" defined successfully.`;
  },
};

export const invokeSubagentTool: Tool = {
  name: "invoke_subagent",
  description: "Invoke an instance of a defined subagent to run a background task.",
  parameters: {
    type: "object",
    properties: {
      typeName: {
        type: "string",
        description: "The name of the defined subagent type to invoke",
      },
      role: {
        type: "string",
        description: "Role / job title of this subagent instance",
      },
      prompt: {
        type: "string",
        description: "The initial instruction or prompt for the subagent",
      },
      wait: {
        type: "boolean",
        description: "Whether to wait synchronously for the subagent to finish and return its final report/output. Defaults to false.",
      },
      mode: {
        type: "string",
        enum: ["inline", "background"],
        description: "The execution mode: 'inline' (run synchronously and wait for completion) or 'background' (run asynchronously). If omitted, defaults to 'background'.",
      },
      timeoutMs: {
        type: "integer",
        description: "Timeout in milliseconds for inline execution. If execution exceeds this limit, the subagent is aborted.",
      },
      inheritContext: {
        type: "boolean",
        description:
          "If true, prepend a compact snapshot of the parent agent's current workspace state " +
          "(task progress, plan objective, working directory) to the subagent's system prompt. " +
          "Reduces redundant re-research by giving the subagent a head-start on context. " +
          "Snapshot is capped at 2000 characters. Default: false.",
      },
    },
    required: ["typeName", "role", "prompt"],
  },
  async execute(args, cwd, signal) {
    const typeName = (args.typeName ?? args.agent_name ?? args.name) as string;
    const role = (args.role ?? args.agent_role ?? typeName ?? "subagent") as string;
    const prompt = (args.prompt ?? args.initial_message ?? args.message) as string;
    const mode = args.mode as "inline" | "background" | undefined;
    let wait = false;
    if (mode === "inline") {
      wait = true;
    } else if (mode === "background") {
      wait = false;
    } else if (args.wait !== undefined) {
      wait = args.wait === true;
    }

    const parentAgent = agentLocalStorage.getStore();
    let parentId = "master";
    if (parentAgent) {
      for (const [saId, saInstance] of superagentInstances.entries()) {
        if (saInstance.agent === parentAgent) {
          parentId = saId;
          break;
        }
      }
    }

    const parentDepth = parentAgent ? parentAgent.delegationDepth : 0;
    if (parentDepth >= 2) {
      return `Error: Maximum subagent delegation depth (2) reached. Spawning subagents from this subagent is blocked.`;
    }

    const subType = subagentTypes.get(typeName);
    if (!subType) {
      return `Error: Subagent type "${typeName}" is not defined. Use define_subagent first.`;
    }

    const { Agent } = await import("../agent.js");
    const subagentId = Math.random().toString(36).substring(2, 9);

    const logs: string[] = [];
    let lastTextIdx = -1;
    let isFirstNode = true;

    function appendToThinkingNode(text: string) {
      if (lastTextIdx === -1) {
        logs.push(`${isFirstNode ? "┌" : "├"}───[ ✦ COGNITIVE THINKING ]\n`);
        isFirstNode = false;
        logs.push(`│   `);
        lastTextIdx = logs.length - 1;
      }

      const parts = text.split("\n");
      if (parts.length === 1) {
        logs[lastTextIdx] += parts[0];
      } else {
        logs[lastTextIdx] += parts[0] + "\n";
        for (let i = 1; i < parts.length - 1; i++) {
          logs.push(`│   ${parts[i]}\n`);
        }
        logs.push(`│   `);
        lastTextIdx = logs.length - 1;
        logs[lastTextIdx] += parts[parts.length - 1];
      }
      if (lastTextIdx >= 0) {
        logs[lastTextIdx] = resolveCarriageReturns(logs[lastTextIdx]);
      }
    }

    function closeThinkingNode() {
      if (lastTextIdx >= 0) {
        if (logs[lastTextIdx] === "│   ") {
          logs.pop();
          const lastIndex = logs.length - 1;
          if (lastIndex >= 0 && logs[lastIndex].includes("[ ✦ COGNITIVE THINKING ]")) {
            logs.pop();
          } else {
            logs.push(`│\n`);
          }
        } else {
          if (!logs[lastTextIdx].endsWith("\n")) {
            logs[lastTextIdx] += "\n";
          }
          logs.push(`│\n`);
        }
        lastTextIdx = -1;
      }
    }

    function formatSubagentArgs(subArgs: Record<string, unknown>): string {
      const entries = Object.entries(subArgs);
      if (entries.length === 0) return "{}";
      const parts = entries.map(([k, v]) => {
        const val = typeof v === "string" ? v : JSON.stringify(v);
        const truncated = val.length > 50 ? val.slice(0, 50) + "..." : val;
        return `${k}: ${truncated}`;
      });
      return `{ ${parts.join(", ")} }`;
    }

    // Pick the restricted toolset and prompt (dynamic import to avoid circular dep with toolsets.ts)
    const { subagentToolsets, defaultSubagentToolset } = await import("./toolsets.js");
    const { getSubagentSystemPrompt } = await import("../prompts.js");
    const baseSystemPrompt = await getSubagentSystemPrompt(typeName, subType.systemPrompt);
    const reportInstruction = SUBAGENT_REPORT_INSTRUCTION(subagentId);

    // ── Fix 2: Optional context inheritance — inject parent workspace snapshot ─
    const inheritContext = args.inheritContext === true;
    let contextSnippet = "";
    if (inheritContext && parentAgent) {
      const snippetParts: string[] = [];
      snippetParts.push(`Working directory: ${cwd}`);

      // Include task progress if a task file exists
      try {
        const taskFilePath = parentAgent.getPlanFilePath
          ? parentAgent.getPlanFilePath().replace("implementation_plan.md", "task.md")
          : "";
        if (taskFilePath) {
          const { buildWorkspaceStateBlock } = await import("../context/WorkspaceStateTracker.js");
          const block = buildWorkspaceStateBlock({
            taskFilePath,
            planFilePath: parentAgent.getPlanFilePath ? parentAgent.getPlanFilePath() : undefined,
            cwd,
            tier: "superagent",
          });
          if (block.text) snippetParts.push(block.text.trim());
        }
      } catch {
        // Non-critical — skip context injection if it fails
      }

      const rawSnippet = snippetParts.join("\n");
      // Cap at 2000 characters to protect subagent context window (Task 6)
      contextSnippet = rawSnippet.length > 2000
        ? rawSnippet.slice(0, 2000) + "\n...[context truncated]"
        : rawSnippet;
    }

    const resolvedPrompt = (() => {
      const withReport = baseSystemPrompt.includes("SUBAGENT TASK REPORT")
        ? baseSystemPrompt
        : `${baseSystemPrompt}\n\n${reportInstruction}`;
      if (!contextSnippet) return withReport;
      return `## INHERITED WORKSPACE CONTEXT (from parent agent)\n${contextSnippet}\n\n---\n\n${withReport}`;
    })();
    // Ensure report directory exists before subagent starts
    try { fs.mkdirSync(SUBAGENT_REPORTS_DIR, { recursive: true }); } catch {}
    const toolset = subagentToolsets[typeName] ?? defaultSubagentToolset;

    const agentInstance = new Agent(
      (event) => {
        if (event.type === "text" || event.type === "reasoning") {
          appendToThinkingNode(event.content);
          notifySubagentsChanged();
        } else if (event.type === "error") {
          closeThinkingNode();
          logs.push(`${isFirstNode ? "┌" : "├"}───[ 🚨 ERROR ]\n`);
          isFirstNode = false;
          const lines = event.message.split("\n");
          for (const line of lines) {
            logs.push(`│   ${line}\n`);
          }
          logs.push(`│\n`);
          instance.agent.writeToLogFile("SUBAGENT_ERROR", event.message);
          notifySubagentsChanged();
        } else if (event.type === "tool_start") {
          closeThinkingNode();
          logs.push(`${isFirstNode ? "┌" : "├"}───[ ⚙️ TOOL CALL: ${event.toolCall.name} ]\n`);
          isFirstNode = false;
          logs.push(`│   Description: ${event.description}\n`);
          const argLines = formatSubagentArgs(event.toolCall.args);
          logs.push(`│   Args: ${argLines}\n`);
          logs.push(`│\n`);
          notifySubagentsChanged();
        } else if (event.type === "tool_end") {
          closeThinkingNode();
          const r = event.toolResult;
          const status = r.isError ? "🔴 FAILED" : "🟢 SUCCESS";
          logs.push(`│   └───[ ${status} ]\n`);
          const resultStr = typeof r.result === "string" ? r.result : JSON.stringify(r.result);
          const truncated = resultStr.slice(0, 2000) + (resultStr.length > 2000 ? "..." : "");
          const resultLines = truncated.split("\n");
          for (const line of resultLines) {
            logs.push(`│       ${line}\n`);
          }
          logs.push(`│\n`);
          notifySubagentsChanged();
        } else if (event.type === "token_usage") {
          const inst = subagentInstances.get(subagentId);
          if (inst) {
            inst.tokenUsage = {
              prompt: (inst.tokenUsage?.prompt || 0) + (event.promptTokens || 0),
              completion: (inst.tokenUsage?.completion || 0) + (event.completionTokens || 0),
            };
            if (event.durationMs && event.durationMs > 0 && event.completionTokens > 0) {
              inst.speed = event.completionTokens / (event.durationMs / 1000);
            }
          }
          notifySubagentsChanged();
        } else if (event.type === "illegal_operation") {
          const v = event.violation;
          const icon = v.severity === "critical" ? "🚨" : "⚠️";
          closeThinkingNode();
          logs.push(`${isFirstNode ? "┌" : "├"}───[ ${icon} ILLEGAL OPERATION ]\n`);
          isFirstNode = false;
          logs.push(`│   Reason: ${v.reason}\n`);
          logs.push(`│   Tool: ${v.toolName}\n`);
          logs.push(`│   Detail: ${v.description}\n`);
          logs.push(`│\n`);
          const inst = subagentInstances.get(subagentId);
          if (inst) {
            if (!inst.violations) inst.violations = [];
            inst.violations.push(v);
          }
          appendMasterLog(`[ILLEGAL_OP] ${icon} Subagent ${subagentId} (${role}): ${v.reason} — ${v.description}`);
          notifySubagentsChanged();

          // Auto-escalation: inject system message into parent agent's conversation
          if (v.severity === "critical" && parentAgent && typeof parentAgent.getHistory === "function") {
            try {
              const criticalCount = (inst?.violations || []).filter(vv => vv.severity === "critical").length;
              parentAgent.getHistory().addMessage({
                role: "system",
                content: `[ILLEGAL_OPERATION — AUTO-ESCALATION]\n` +
                  `🚨 Subagent "${role}" (type: ${typeName}, ID: ${subagentId}) committed a CRITICAL violation.\n` +
                  `Reason: ${v.reason}\n` +
                  `Tool: ${v.toolName}\n` +
                  `Detail: ${v.description}\n` +
                  `Total critical violations for this Subagent: ${criticalCount}\n` +
                  `Consider using manage_subagents (action: "kill") to terminate this Subagent if it continues violating policies.`,
                timestamp: Date.now(),
              });
            } catch {}
          }
        }
      },
      // Permission: block destructive commands, auto-approve everything else
      async (toolCall, _desc) => {
        const cmd = (toolCall.args.command as string || "").trim();
        const isDestructive = /(rm\s+-rf\s+[\/~]|git\s+reset\s+--hard|git\s+clean\s+-fd|mkfs|dd\s+if=)/i.test(cmd);
        return !isDestructive;
      },
      async (question, options = []) => {
        const master = getMasterAgent();
        if (master && typeof (master as any).answerQuestionAsMaster === "function") {
          appendMasterLog(`[QUESTION] Subagent ${subagentId} (${role}) asks: ${question} | Options: ${options.join(", ")}`);
          const answer = await (master as any).answerQuestionAsMaster(question, options, {
            source: "subagent",
            role,
            typeName,
          });
          appendMasterLog(`[MASTER ANSWER] For Subagent ${subagentId} (${role}): "${answer}"`);
          return answer;
        }
        // Single-mode fallback: route to user UI
        const handler = getActiveQuestionHandler();
        if (handler) {
          return handler(`[Subagent ${subagentId} (${role})]: ${question}`, options);
        }
        return options[0] || "";
      },
      resolvedPrompt,
      toolset,
      cwd
    );

    agentInstance.delegationDepth = parentDepth + 1;
    agentInstance.tier = "subagent";
    agentInstance.subagentType = typeName;
    // Inherit approved plan state so subagent's internal blocking gates don't falsely activate
    agentInstance.planState = "APPROVED";
    if (parentAgent) {
      agentInstance.isMultiAgent = parentAgent.isMultiAgent;
    }

    const instance: SubagentInstance = {
      id: subagentId,
      typeName,
      role,
      agent: agentInstance,
      status: "running",
      logs,
      parentId,
      historyFilePath: agentInstance.getCurrentHistoryFilePath(),
    };

    subagentInstances.set(subagentId, instance);
    notifySubagentsChanged();
    appendMasterLog(`[INFO] Spawning Subagent "${typeName}" (Role: ${role}) [ID: ${subagentId}]...`);

    let timeoutMs = args.timeoutMs as number | undefined;
    if (timeoutMs !== undefined && timeoutMs > 0 && timeoutMs < 600000 && process.env.VITEST !== "true") {
      // Enforce a minimum timeout of 10 minutes to prevent premature timeouts on slow local models/routers
      timeoutMs = 600000;
    }
    if (wait) {
      try {
        if (timeoutMs !== undefined && timeoutMs > 0) {
          const timeoutPromise = new Promise<never>((_, reject) => {
            const timer = setTimeout(() => {
              (agentInstance as any).abortController?.abort();
              reject(new Error(`Timeout: Subagent execution exceeded ${timeoutMs}ms limit.`));
            }, timeoutMs);
            timer.unref?.();
          });
          await Promise.race([
            agentInstance.sendMessage(prompt),
            timeoutPromise
          ]);
        } else {
          await agentInstance.sendMessage(prompt);
        }
        closeThinkingNode();
        logs.push(`└──────────────────────────────────────────────\n`);
        instance.status = "completed";
        instance.completedAt = Date.now();
        instance.result = extractSubagentReport(agentInstance, subagentId);
        notifySubagentsChanged();
        appendMasterLog(`[INFO] Subagent "${typeName}" [ID: ${subagentId}] finished.`);
        return `Subagent "${typeName}" (Role: ${role}) finished. Report:\n\n${instance.result || "(no report)"}`;
      } catch (err: any) {
        closeThinkingNode();
        logs.push(`[ERROR] Subagent failed: ${err.message}\n`);
        logs.push(`└──────────────────────────────────────────────\n`);
        instance.status = "error";
        instance.completedAt = Date.now();
        notifySubagentsChanged();
        appendMasterLog(`[ERROR] Subagent "${typeName}" [ID: ${subagentId}] failed: ${err.message}`);
        instance.agent.writeToLogFile("SUBAGENT_FAILED", err.message);
        return `Subagent failed: ${err.message}`;
      }
    } else {
      agentInstance.sendMessage(prompt).then(() => {
        closeThinkingNode();
        logs.push(`└──────────────────────────────────────────────\n`);
        instance.status = "completed";
        instance.completedAt = Date.now();
        instance.result = extractSubagentReport(agentInstance, subagentId);
        notifySubagentsChanged();
        appendMasterLog(`[INFO] Subagent "${typeName}" [ID: ${subagentId}] finished.`);
      }).catch((err: any) => {
        closeThinkingNode();
        logs.push(`[ERROR] Subagent failed: ${err.message || err}\n`);
        logs.push(`└──────────────────────────────────────────────\n`);
        instance.status = "error";
        instance.completedAt = Date.now();
        notifySubagentsChanged();
        appendMasterLog(`[ERROR] Subagent "${typeName}" [ID: ${subagentId}] failed: ${err.message || err}`);
        instance.agent.writeToLogFile("SUBAGENT_FAILED", err.message || String(err));
      });

      return `Invoked subagent "${typeName}" (Role: ${role}) in background. Conversation ID: ${subagentId}`;
    }
  },
};

export const sendMessageTool: Tool = {
  name: "send_message",
  description: "Send a follow-up message to an active subagent.",
  parameters: {
    type: "object",
    properties: {
      recipientId: {
        type: "string",
        description: "The conversation ID or role/type name of the subagent (e.g. 'researcher', 'coder')",
      },
      message: {
        type: "string",
        description: "The follow-up message to send",
      },
      wait: {
        type: "boolean",
        description: "Whether to wait synchronously for the subagent to finish and return its final report/output. Defaults to true.",
      },
    },
    required: ["recipientId", "message"],
  },
  async execute(args, cwd, signal) {
    const recipientId = (args.recipientId ?? args.recipient_id ?? args.recipient ?? args.conversationId ?? args.conversation_id) as string;
    const message = (args.message ?? args.prompt ?? args.initial_message) as string;
    const wait = args.wait !== false;
    const sendParentAgent = agentLocalStorage.getStore();

    const instance = resolveSubagentInstance(recipientId);
    if (!instance) {
      return `Error: Subagent instance "${recipientId}" not found. Use 'list' action to see available IDs and role names.`;
    }

    if (instance.status !== "running" && instance.status !== "paused" && instance.status !== "idle") {
      return `Error: Subagent "${recipientId}" is not active or paused (status: ${instance.status}).`;
    }

    const isPaused = instance.status === "paused";
    let agentInstance = instance.agent;

    if (isPaused) {
      const { typeName, role, logs, historyFilePath } = instance;
      const logsList = logs || [];
      let lastTextIdx = -1;
      let isFirstNode = logsList.length === 0;

      const appendToThinkingNode = (text: string) => {
        if (lastTextIdx === -1) {
          logsList.push(`${isFirstNode ? "┌" : "├"}───[ ✦ COGNITIVE THINKING ]\n`);
          isFirstNode = false;
          logsList.push(`│   `);
          lastTextIdx = logsList.length - 1;
        }

        const parts = text.split("\n");
        if (parts.length === 1) {
          logsList[lastTextIdx] += parts[0];
        } else {
          logsList[lastTextIdx] += parts[0] + "\n";
          for (let i = 1; i < parts.length - 1; i++) {
            logsList.push(`│   ${parts[i]}\n`);
          }
          logsList.push(`│   `);
          lastTextIdx = logsList.length - 1;
          logsList[lastTextIdx] += parts[parts.length - 1];
        }
      };

      const closeThinkingNode = () => {
        if (lastTextIdx >= 0) {
          if (logsList[lastTextIdx] === "│   ") {
            logsList.pop();
            const lastIndex = logsList.length - 1;
            if (lastIndex >= 0 && logsList[lastIndex].includes("[ ✦ COGNITIVE THINKING ]")) {
              logsList.pop();
            } else {
              logsList.push(`│\n`);
            }
          } else {
            if (!logsList[lastTextIdx].endsWith("\n")) {
              logsList[lastTextIdx] += "\n";
            }
            logsList.push(`│\n`);
          }
          lastTextIdx = -1;
        }
      };

      // Import prompt & toolset
      const { subagentToolsets, defaultSubagentToolset } = await import("./toolsets.js");
      const { getSubagentSystemPrompt } = await import("../prompts.js");
      const subType = subagentTypes.get(typeName);
      const baseSystemPrompt = await getSubagentSystemPrompt(typeName, subType?.systemPrompt || "");
      const resumeReportInstruction = SUBAGENT_REPORT_INSTRUCTION(recipientId);
      const systemPrompt = baseSystemPrompt.includes("SUBAGENT TASK REPORT")
        ? baseSystemPrompt
        : `${baseSystemPrompt}\n\n${resumeReportInstruction}`;
      const toolset = subagentToolsets[typeName] ?? defaultSubagentToolset;

      const { Agent } = await import("../agent.js");
      agentInstance = new Agent(
        (event) => {
          if (event.type === "text" || event.type === "reasoning") {
            appendToThinkingNode(event.content);
            notifySubagentsChanged();
          } else if (event.type === "error") {
            closeThinkingNode();
            logsList.push(`${isFirstNode ? "┌" : "├"}───[ 🚨 ERROR ]\n`);
            isFirstNode = false;
            const lines = event.message.split("\n");
            for (const line of lines) {
              logsList.push(`│   ${line}\n`);
            }
            logsList.push(`│\n`);
            agentInstance.writeToLogFile("SUBAGENT_ERROR", event.message);
            notifySubagentsChanged();
          } else if (event.type === "tool_start") {
            closeThinkingNode();
            logsList.push(`${isFirstNode ? "┌" : "├"}───[ ⚙️ TOOL CALL: ${event.toolCall.name} ]\n`);
            isFirstNode = false;
            logsList.push(`│   Description: ${event.description}\n`);
            // Format args
            const entries = Object.entries(event.toolCall.args);
            const formatted = entries.map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join(", ");
            logsList.push(`│   Args: { ${formatted} }\n`);
            logsList.push(`│\n`);
            notifySubagentsChanged();
          } else if (event.type === "tool_end") {
            closeThinkingNode();
            const r = event.toolResult;
            const status = r.isError ? "🔴 FAILED" : "🟢 SUCCESS";
            logsList.push(`│   └───[ ${status} ]\n`);
            const resultStr = typeof r.result === "string" ? r.result : JSON.stringify(r.result);
            const truncated = resultStr.slice(0, 2000) + (resultStr.length > 2000 ? "..." : "");
            const resultLines = truncated.split("\n");
            for (const line of resultLines) {
              logsList.push(`│       ${line}\n`);
            }
            logsList.push(`│\n`);
            notifySubagentsChanged();
          } else if (event.type === "token_usage") {
            const inst = subagentInstances.get(recipientId);
            if (inst) {
              inst.tokenUsage = {
                prompt: (inst.tokenUsage?.prompt || 0) + (event.promptTokens || 0),
                completion: (inst.tokenUsage?.completion || 0) + (event.completionTokens || 0),
              };
              if (event.durationMs && event.durationMs > 0 && event.completionTokens > 0) {
                inst.speed = event.completionTokens / (event.durationMs / 1000);
              }
            }
            notifySubagentsChanged();
          } else if (event.type === "illegal_operation") {
            const v = event.violation;
            const icon = v.severity === "critical" ? "🚨" : "⚠️";
            closeThinkingNode();
            logsList.push(`${isFirstNode ? "┌" : "├"}───[ ${icon} ILLEGAL OPERATION ]\n`);
            isFirstNode = false;
            logsList.push(`│   Reason: ${v.reason}\n`);
            logsList.push(`│   Tool: ${v.toolName}\n`);
            logsList.push(`│   Detail: ${v.description}\n`);
            logsList.push(`│\n`);
            const inst = subagentInstances.get(recipientId);
            if (inst) {
              if (!inst.violations) inst.violations = [];
              inst.violations.push(v);
            }
            appendMasterLog(`[ILLEGAL_OP] ${icon} Subagent ${recipientId} (${role}): ${v.reason} — ${v.description}`);
            notifySubagentsChanged();

            // Auto-escalation: inject system message into parent agent's conversation
            if (v.severity === "critical" && sendParentAgent && typeof sendParentAgent.getHistory === "function") {
              try {
                const criticalCount = (inst?.violations || []).filter(vv => vv.severity === "critical").length;
                sendParentAgent.getHistory().addMessage({
                  role: "system",
                  content: `[ILLEGAL_OPERATION — AUTO-ESCALATION]\n` +
                    `🚨 Subagent "${role}" (type: ${typeName}, ID: ${recipientId}) committed a CRITICAL violation.\n` +
                    `Reason: ${v.reason}\n` +
                    `Tool: ${v.toolName}\n` +
                    `Detail: ${v.description}\n` +
                    `Total critical violations for this Subagent: ${criticalCount}\n` +
                    `Consider using manage_subagents (action: "kill") to terminate this Subagent if it continues violating policies.`,
                  timestamp: Date.now(),
                });
              } catch {}
            }
          }
        },
        async (toolCall, _desc) => {
          const cmd = (toolCall.args.command as string || "").trim();
          const isDestructive = /(rm\s+-rf\s+[\/~]|git\s+reset\s+--hard|git\s+clean\s+-fd|mkfs|dd\s+if=)/i.test(cmd);
          return !isDestructive;
        },
        async (question, options = []) => {
          const master = getMasterAgent();
          if (master && typeof (master as any).answerQuestionAsMaster === "function") {
            appendMasterLog(`[QUESTION] Subagent ${recipientId} (${role}) asks: ${question} | Options: ${options.join(", ")}`);
            const answer = await (master as any).answerQuestionAsMaster(question, options, {
              source: "subagent",
              role,
              typeName,
            });
            appendMasterLog(`[MASTER ANSWER] For Subagent ${recipientId} (${role}): "${answer}"`);
            return answer;
          }
          // Single-mode fallback: route to user UI
          const handler = getActiveQuestionHandler();
          if (handler) {
            return handler(`[Subagent ${recipientId} (${role})]: ${question}`, options);
          }
          return options[0] || "";
        },
        systemPrompt,
        toolset,
        cwd
      );

      // Re-setup delegation properties
      const parentAgent = agentLocalStorage.getStore();
      const parentDepth = parentAgent ? parentAgent.delegationDepth : 0;
      agentInstance.delegationDepth = parentDepth + 1;
      agentInstance.tier = "subagent";
      agentInstance.subagentType = typeName;
      if (parentAgent) {
        agentInstance.isMultiAgent = parentAgent.isMultiAgent;
      }

      // Load history
      if (historyFilePath) {
        await agentInstance.loadHistoryFromPath(historyFilePath);
      }

      instance.agent = agentInstance;
      instance.status = "running";
      notifySubagentsChanged();
      appendMasterLog(`[INFO] Resuming Subagent "${role}" from pause...`);
    } else {
      instance.status = "running";
      notifySubagentsChanged();
    }

    if (wait) {
      try {
        await agentInstance.sendMessage(message);
        instance.status = "completed";
        let result = instance.result;
        if (agentInstance && typeof agentInstance.getHistory === "function") {
          const msgs = agentInstance.getHistory().getMessages();
          const lastAssistantMsg = [...msgs].reverse().find(m => m.role === "assistant");
          if (lastAssistantMsg) {
            result = lastAssistantMsg.content;
          }
        }
        instance.result = result;
        notifySubagentsChanged();
        return `Subagent "${recipientId}" finished. Report:\n\n${result || "(no report)"}`;
      } catch (err: any) {
        instance.status = "error";
        notifySubagentsChanged();
        agentInstance.writeToLogFile("SUBAGENT_FAILED", err.message);
        return `Subagent failed: ${err.message}`;
      }
    } else {
      agentInstance.sendMessage(message).then(() => {
        instance.status = "completed";
        let result = instance.result;
        if (agentInstance && typeof agentInstance.getHistory === "function") {
          const msgs = agentInstance.getHistory().getMessages();
          const lastAssistantMsg = [...msgs].reverse().find(m => m.role === "assistant");
          if (lastAssistantMsg) {
            result = lastAssistantMsg.content;
          }
        }
        instance.result = result;
        notifySubagentsChanged();
      }).catch((err: any) => {
        instance.status = "error";
        notifySubagentsChanged();
        agentInstance.writeToLogFile("SUBAGENT_FAILED", err.message || String(err));
      });

      return `Message sent to subagent "${recipientId}". Subagent is processing.`;
    }
  },
};

export const manageSubagentsTool: Tool = {
  name: "manage_subagents",
  description: "List subagent types/instances, check logs, retrieve reports, or terminate them.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "logs", "report", "violations", "kill", "kill_all"],
        description: "Action to perform",
      },
      conversationIds: {
        type: "array",
        items: { type: "string" },
        description: "List of conversation IDs or role/type names (e.g. 'researcher', 'coder') to kill or read logs/reports from",
      },
    },
    required: ["action"],
  },
  async execute(args, cwd, signal) {
    const action = args.action as string;
    const rawIds = args.conversationIds ?? args.conversation_ids ?? args.conversation_id ?? args.conversationId;
    const conversationIds = Array.isArray(rawIds) ? (rawIds as string[]) : (rawIds ? [String(rawIds)] : []);

    if (action === "list") {
      const lines: string[] = ["Defined Subagent Types:"];
      if (subagentTypes.size === 0) lines.push("  None");
      for (const [name, t] of subagentTypes.entries()) {
        lines.push(`  - ${name}: ${t.description}`);
      }
      lines.push("\nActive Subagent Instances:");
      if (subagentInstances.size === 0) lines.push("  None");
      for (const [id, inst] of subagentInstances.entries()) {
        let line = `  - ID: ${id} | Type: ${inst.typeName} | Role: ${inst.role} | Status: ${inst.status}`;
        if (inst.violations && inst.violations.length > 0) {
          line += ` | Violations: ${inst.violations.length}`;
        }
        if (inst.status === "completed" && inst.result) {
          const snippet = inst.result.length > 120 ? inst.result.slice(0, 120) + "..." : inst.result;
          line += `\n    Report: ${snippet.replace(/\n/g, "\n    ")}`;
        }
        lines.push(line);
      }
      return lines.join("\n");
    }

    if (action === "logs") {
      if (!conversationIds || conversationIds.length === 0) {
        return "Error: conversationIds is required to retrieve logs.";
      }
      const id = conversationIds[0];
      const inst = resolveSubagentInstance(id);
      if (!inst) {
        return `Error: Subagent instance "${id}" not found. Use 'list' action to see available IDs and role names.`;
      }
      return `Logs for Subagent ${inst.id} (${inst.role}):\n${inst.logs.join("") || "(no logs yet)"}`;
    }

    if (action === "report") {
      if (!conversationIds || conversationIds.length === 0) {
        return "Error: conversationIds is required to retrieve the report.";
      }
      const id = conversationIds[0];
      const inst = resolveSubagentInstance(id);
      if (!inst) {
        return `Error: Subagent instance "${id}" not found. Use 'list' action to see available IDs and role names.`;
      }
      return `Report for Subagent ${inst.id} (${inst.role}):\n\n${inst.result || "No report available yet."}`;
    }

    if (action === "violations") {
      const lines: string[] = ["Subagent Violations Report:"];
      let hasViolations = false;
      for (const [id, inst] of subagentInstances.entries()) {
        const vList = inst.violations || [];
        if (vList.length === 0) continue;
        hasViolations = true;
        lines.push(`\n  ${inst.typeName} / ${inst.role} (ID: ${id}) — ${vList.length} violation(s):`);
        for (const v of vList) {
          const icon = v.severity === "critical" ? "🚨" : "⚠️";
          const time = new Date(v.timestamp).toISOString();
          lines.push(`    ${icon} [${time}] ${v.reason}: ${v.description}`);
        }
      }
      if (!hasViolations) lines.push("  No violations recorded.");
      return lines.join("\n");
    }

    if (action === "kill") {
      if (!conversationIds || conversationIds.length === 0) {
        return "Error: conversationIds is required for kill action.";
      }
      for (const id of conversationIds) {
        const inst = resolveSubagentInstance(id);
        if (inst) {
          inst.agent.abort();
          subagentInstances.delete(inst.id);
        }
      }
      notifySubagentsChanged();
      return `Terminated subagents: ${conversationIds.join(", ")}`;
    }

    if (action === "kill_all") {
      for (const [id, inst] of subagentInstances.entries()) {
        inst.agent.abort();
      }
      subagentInstances.clear();
      notifySubagentsChanged();
      return "All subagent instances terminated.";
    }

    return formatUnknownActionError(action, ["list", "logs", "report", "violations", "kill", "kill_all"], "Use \"report\" (singular), not \"reports\".");
  },
};

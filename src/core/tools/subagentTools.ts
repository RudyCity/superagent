import { Tool, SubagentInstance } from "./types.js";
import { 
  subagentTypes, 
  subagentInstances, 
  notifySubagentsChanged, 
  activeQuestionHandler 
} from "./state.js";
import { agentLocalStorage } from "../agent.js";

const SUBAGENT_REPORT_INSTRUCTION = `
CRITICAL INSTRUCTION FOR SUBAGENT REPORTING:
When you have completed your assigned task, or if you are blocked and cannot proceed, you MUST provide a standardized final report in your last response. Format your report exactly as follows using Markdown:

### SUBAGENT TASK REPORT
- **Goal / Objective**: [Brief description of what you were asked to do]
- **Actions Taken**:
  - [Action 1: e.g. read src/app.tsx]
  - [Action 2: e.g. executed tests]
- **Key Findings / Outcomes**:
  - [Detail what you discovered or accomplished]
- **Status & Next Steps**: [Completed / Blocked / Unresolved issues - and any recommendations for the main agent]
`;

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
        description: "Whether to wait synchronously for the subagent to finish and return its final report/output.",
      },
    },
    required: ["typeName", "role", "prompt"],
  },
  async execute(args, cwd, signal) {
    const typeName = args.typeName as string;
    const role = args.role as string;
    const prompt = args.prompt as string;
    const wait = !!args.wait;

    const parentAgent = agentLocalStorage.getStore();
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
    let textBuffer = "";
    let isFirstNode = true;

    function flushTextBuffer() {
      if (!textBuffer) return;
      const cleanText = textBuffer.trim();
      if (cleanText) {
        const lines = cleanText.split("\n");
        logs.push(`${isFirstNode ? "┌" : "├"}───[ ✦ COGNITIVE THINKING ]\n`);
        isFirstNode = false;
        for (const line of lines) {
          logs.push(`│   ${line}\n`);
        }
        logs.push(`│\n`);
      }
      textBuffer = "";
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

    const systemPromptWithReport = `${subType.systemPrompt}\n\n${SUBAGENT_REPORT_INSTRUCTION}`;

    const agentInstance = new Agent(
      (event) => {
        if (event.type === "text") {
          textBuffer += event.content;
        } else if (event.type === "error") {
          flushTextBuffer();
          logs.push(`${isFirstNode ? "┌" : "├"}───[ 🚨 ERROR ]\n`);
          isFirstNode = false;
          const lines = event.message.split("\n");
          for (const line of lines) {
            logs.push(`│   ${line}\n`);
          }
          logs.push(`│\n`);
        } else if (event.type === "tool_start") {
          flushTextBuffer();
          logs.push(`${isFirstNode ? "┌" : "├"}───[ ⚙️ TOOL CALL: ${event.toolCall.name} ]\n`);
          isFirstNode = false;
          logs.push(`│   Description: ${event.description}\n`);
          const argLines = formatSubagentArgs(event.toolCall.args);
          logs.push(`│   Args: ${argLines}\n`);
          logs.push(`│\n`);
        } else if (event.type === "tool_end") {
          flushTextBuffer();
          const r = event.toolResult;
          const status = r.isError ? "🔴 FAILED" : "🟢 SUCCESS";
          logs.push(`│   └───[ ${status} ]\n`);
          const resultStr = typeof r.result === "string" ? r.result : JSON.stringify(r.result);
          const truncated = resultStr.slice(0, 200) + (resultStr.length > 200 ? "..." : "");
          const resultLines = truncated.split("\n");
          for (const line of resultLines) {
            logs.push(`│       ${line}\n`);
          }
          logs.push(`│\n`);
        }
      },
      async (toolCall, desc) => {
        return true;
      },
      async (question, options) => {
        if (activeQuestionHandler) {
          return activeQuestionHandler(`[Subagent ${subagentId} (${role})]: ${question}`, options);
        }
        return options[0] || "";
      },
      systemPromptWithReport
    );

    agentInstance.delegationDepth = parentDepth + 1;

    const instance: SubagentInstance = {
      id: subagentId,
      typeName,
      role,
      agent: agentInstance,
      status: "running",
      logs,
    };

    subagentInstances.set(subagentId, instance);
    notifySubagentsChanged();

    if (wait) {
      try {
        await agentInstance.sendMessage(prompt);
        flushTextBuffer();
        logs.push(`└──────────────────────────────────────────────\n`);
        instance.status = "completed";
        const msgs = agentInstance.getHistory().getMessages();
        const lastAssistantMsg = [...msgs].reverse().find(m => m.role === "assistant");
        if (lastAssistantMsg) {
          instance.result = lastAssistantMsg.content;
        }
        notifySubagentsChanged();
        return `Subagent "${typeName}" (Role: ${role}) finished. Report:\n\n${instance.result || "(no report)"}`;
      } catch (err: any) {
        flushTextBuffer();
        logs.push(`└──────────────────────────────────────────────\n`);
        instance.status = "completed";
        notifySubagentsChanged();
        return `Subagent failed: ${err.message}`;
      }
    } else {
      agentInstance.sendMessage(prompt).then(() => {
        flushTextBuffer();
        logs.push(`└──────────────────────────────────────────────\n`);
        instance.status = "completed";
        const msgs = agentInstance.getHistory().getMessages();
        const lastAssistantMsg = [...msgs].reverse().find(m => m.role === "assistant");
        if (lastAssistantMsg) {
          instance.result = lastAssistantMsg.content;
        }
        notifySubagentsChanged();
      }).catch(() => {
        flushTextBuffer();
        logs.push(`└──────────────────────────────────────────────\n`);
        instance.status = "completed";
        notifySubagentsChanged();
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
        description: "The conversation ID of the subagent",
      },
      message: {
        type: "string",
        description: "The follow-up message to send",
      },
      wait: {
        type: "boolean",
        description: "Whether to wait synchronously for the subagent to finish and return its final report/output.",
      },
    },
    required: ["recipientId", "message"],
  },
  async execute(args, cwd, signal) {
    const recipientId = args.recipientId as string;
    const message = args.message as string;
    const wait = !!args.wait;

    const instance = subagentInstances.get(recipientId);
    if (!instance) {
      return `Error: Subagent instance "${recipientId}" not found.`;
    }

    instance.status = "running";
    notifySubagentsChanged();

    if (wait) {
      try {
        await instance.agent.sendMessage(message);
        instance.status = "completed";
        const msgs = instance.agent.getHistory().getMessages();
        const lastAssistantMsg = [...msgs].reverse().find(m => m.role === "assistant");
        if (lastAssistantMsg) {
          instance.result = lastAssistantMsg.content;
        }
        notifySubagentsChanged();
        return `Subagent "${recipientId}" finished. Report:\n\n${instance.result || "(no report)"}`;
      } catch (err: any) {
        instance.status = "completed";
        notifySubagentsChanged();
        return `Subagent failed: ${err.message}`;
      }
    } else {
      instance.agent.sendMessage(message).then(() => {
        instance.status = "completed";
        const msgs = instance.agent.getHistory().getMessages();
        const lastAssistantMsg = [...msgs].reverse().find(m => m.role === "assistant");
        if (lastAssistantMsg) {
          instance.result = lastAssistantMsg.content;
        }
        notifySubagentsChanged();
      }).catch(() => {
        instance.status = "completed";
        notifySubagentsChanged();
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
        enum: ["list", "logs", "report", "kill", "kill_all"],
        description: "Action to perform",
      },
      conversationIds: {
        type: "array",
        items: { type: "string" },
        description: "List of conversation IDs to kill or read logs/reports from",
      },
    },
    required: ["action"],
  },
  async execute(args, cwd, signal) {
    const action = args.action as string;
    const conversationIds = args.conversationIds as string[];

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
      const inst = subagentInstances.get(id);
      if (!inst) {
        return `Error: Subagent instance "${id}" not found.`;
      }
      return `Logs for Subagent ${id} (${inst.role}):\n${inst.logs.join("") || "(no logs yet)"}`;
    }

    if (action === "report") {
      if (!conversationIds || conversationIds.length === 0) {
        return "Error: conversationIds is required to retrieve the report.";
      }
      const id = conversationIds[0];
      const inst = subagentInstances.get(id);
      if (!inst) {
        return `Error: Subagent instance "${id}" not found.`;
      }
      return `Report for Subagent ${id} (${inst.role}):\n\n${inst.result || "No report available yet."}`;
    }

    if (action === "kill") {
      if (!conversationIds || conversationIds.length === 0) {
        return "Error: conversationIds is required for kill action.";
      }
      for (const id of conversationIds) {
        const inst = subagentInstances.get(id);
        if (inst) {
          inst.agent.abort();
          subagentInstances.delete(id);
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

    return `Error: Unknown action "${action}"`;
  },
};

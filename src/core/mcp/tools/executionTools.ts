/**
 * executionTools.ts — Task execution, subagent delegation, invoke, await, merge, and lifecycle management handlers for MCP.
 */

import path from "path";
import { McpToolResult } from "../types.js";
import { callServerApi } from "./processTools.js";
import { superagentInstances } from "../../tools/state.js";

export async function handleRunTask(args: any): Promise<McpToolResult> {
  const task = String(args.task || args.prompt || args.message || args.instruction || "");
  const role = String(args.role || args.agentRole || "assistant");
  const mode = args.mode === "multi" ? "multi" : "single";
  const targetWs = args.workspace ? path.resolve(String(args.workspace)) : process.cwd();

  if (!task) {
    return {
      content: [{ type: "text", text: "Error: 'task' is required." }],
      isError: true,
    };
  }

  // Forward to running server if active
  const serverRes = await callServerApi(
    "/api/chat",
    "POST",
    {
      message: task,
      workspace: targetWs,
      mode,
    },
    300000
  );

  if (serverRes.success) {
    return {
      content: [
        {
          type: "text",
          text:
            typeof serverRes.data === "string"
              ? serverRes.data
              : JSON.stringify(serverRes.data, null, 2),
        },
      ],
    };
  }

  // Standalone headless execution
  const { Agent } = await import("../../agent.js");
  const { superagentToolset, masterToolset } = await import("../../tools/toolsets.js");
  const { MASTER_AGENT_SYSTEM_PROMPT } = await import("../../prompts.js");

  let collectedOutput = "";
  let reasoningText = "";
  const toolCallsRun: string[] = [];

  const agent = new Agent(
    (event: any) => {
      if (event.type === "text") collectedOutput += event.content;
      if (event.type === "reasoning") reasoningText += event.content;
      if (event.type === "tool_start") toolCallsRun.push(`⚡ ${event.description}`);
      if (event.type === "tool_end") {
        const r = event.toolResult;
        toolCallsRun.push(`${r.isError ? "✗ Failed" : "✓ Done"}: ${event.description}`);
      }
    },
    async () => true,
    async (q, opts) => (Array.isArray(q) ? q.map((i) => i.options?.[0] || "") : opts?.[0] || ""),
    mode === "multi" ? MASTER_AGENT_SYSTEM_PROMPT : undefined,
    mode === "multi" ? masterToolset : superagentToolset,
    targetWs
  );

  agent.tier = mode === "multi" ? "master" : "single";
  await agent.sendMessage(task);

  const summary = [
    `Task completed by Superagent (${role}):`,
    toolCallsRun.length > 0 ? `\nTools Executed:\n${toolCallsRun.join("\n")}\n` : "",
    `\nFinal Result:\n${collectedOutput || "(No output emitted)"}`,
  ].join("\n");

  return { content: [{ type: "text", text: summary }] };
}

export async function handleSpawnSubagent(args: any): Promise<McpToolResult> {
  const typeName = String(args.type || args.typeName || args.subagentType || "researcher");
  const prompt = String(args.prompt || args.task || args.instruction || "");
  const role = String(args.role || typeName);

  if (!prompt) {
    return {
      content: [{ type: "text", text: "Error: 'prompt' is required to spawn a subagent." }],
      isError: true,
    };
  }

  const { invokeSubagentTool } = await import("../../tools/subagentTools.js");
  const result = await invokeSubagentTool.execute(
    { typeName, role, prompt, wait: true },
    process.cwd()
  );
  return { content: [{ type: "text", text: String(result) }] };
}

export async function handleSendMessage(args: any): Promise<McpToolResult> {
  const superagentId = String(args.superagentId || args.id || args.target || "");
  const message = String(args.message || args.prompt || args.instruction || "");
  const wait = args.wait === true;

  if (!superagentId || !message) {
    return {
      content: [{ type: "text", text: "Error: Both 'superagentId' and 'message' are required." }],
      isError: true,
    };
  }

  const serverRes = await callServerApi(
    "/api/superagents/message",
    "POST",
    { superagentId, message, wait },
    wait ? 300000 : 10000
  );
  if (serverRes.success) {
    return {
      content: [
        {
          type: "text",
          text:
            typeof serverRes.data === "string"
              ? serverRes.data
              : JSON.stringify(serverRes.data, null, 2),
        },
      ],
    };
  }

  const { sendMessageToSuperagentTool } = await import("../../tools/superagentTools.js");
  const result = await sendMessageToSuperagentTool.execute(
    { superagentId, message, wait },
    process.cwd()
  );
  return {
    content: [{ type: "text", text: String(result) }],
  };
}

export async function handleInvoke(args: any): Promise<McpToolResult> {
  const role = String(args.role || args.agentRole || "");
  const task = String(args.task || args.prompt || "");
  const branch = args.branch ? String(args.branch) : undefined;
  const wait = args.wait === true;
  const constraints = args.constraints ? String(args.constraints) : undefined;
  const acceptanceCriteria = Array.isArray(args.acceptanceCriteria)
    ? (args.acceptanceCriteria as string[])
    : undefined;

  if (!role || !task) {
    return {
      content: [{ type: "text", text: "Error: 'role' and 'task' are required to invoke a Superagent." }],
      isError: true,
    };
  }

  const serverRes = await callServerApi(
    "/api/superagents/invoke",
    "POST",
    { role, task, branch, wait, constraints, acceptanceCriteria },
    wait ? 600000 : 10000
  );
  if (serverRes.success) {
    return {
      content: [
        {
          type: "text",
          text:
            typeof serverRes.data === "string"
              ? serverRes.data
              : JSON.stringify(serverRes.data, null, 2),
        },
      ],
    };
  }

  const { invokeSuperagentTool } = await import("../../tools/superagentTools.js");
  const result = await invokeSuperagentTool.execute(
    { role, task, branch, wait, constraints, acceptanceCriteria },
    process.cwd()
  );
  return {
    content: [{ type: "text", text: String(result) }],
  };
}

export async function handleAwait(args: any): Promise<McpToolResult> {
  const timeoutSeconds = typeof args.timeoutSeconds === "number" ? args.timeoutSeconds : 600;
  const superagentIds = Array.isArray(args.superagentIds)
    ? (args.superagentIds as string[])
    : undefined;

  const { awaitSuperagentsTool } = await import("../../tools/superagentTools.js");
  const result = await awaitSuperagentsTool.execute(
    { timeoutSeconds, superagentIds },
    process.cwd()
  );
  return {
    content: [{ type: "text", text: String(result) }],
  };
}

export async function handleMerge(args: any): Promise<McpToolResult> {
  const cleanupWorktrees = args.cleanupWorktrees !== false;
  const { mergeSuperagentsTool } = await import("../../tools/superagentTools.js");
  const result = await mergeSuperagentsTool.execute({ cleanupWorktrees }, process.cwd());
  return {
    content: [{ type: "text", text: String(result) }],
  };
}

export async function handleManage(args: any): Promise<McpToolResult> {
  const action = String(args.action || "list");
  const superagentIds = Array.isArray(args.superagentIds) ? (args.superagentIds as string[]) : undefined;

  const serverRes = await callServerApi("/api/superagents/manage", "POST", {
    action,
    superagentIds,
  });
  if (serverRes.success) {
    return {
      content: [
        {
          type: "text",
          text:
            typeof serverRes.data === "string"
              ? serverRes.data
              : JSON.stringify(serverRes.data, null, 2),
        },
      ],
    };
  }

  const { manageSuperagentsTool } = await import("../../tools/superagentTools.js");
  const result = await manageSuperagentsTool.execute({ action, superagentIds }, process.cwd());
  return {
    content: [{ type: "text", text: String(result) }],
  };
}

export async function handleGetStatus(args: any): Promise<McpToolResult> {
  const rawIds = args.superagentIds ?? args.superagent_ids ?? args.id ?? args.superagentId;
  const ids = Array.isArray(rawIds) ? (rawIds as string[]) : rawIds ? [String(rawIds)] : [];

  if (ids.length > 0) {
    const serverRes = await callServerApi("/api/instances", "GET");
    if (serverRes.success && serverRes.data?.superagents) {
      const matched = serverRes.data.superagents.filter((s: any) => ids.includes(s.id));
      if (matched.length > 0) {
        const text = matched
          .map(
            (s: any) =>
              `Superagent ${s.id} (${s.role}):\n  Status: ${s.status}\n  Task: ${s.prompt || "(none)"}\n  Result: ${s.result || "(no result yet)"}`
          )
          .join("\n\n");
        return { content: [{ type: "text", text }] };
      }
    }
  }

  const { manageSuperagentsTool } = await import("../../tools/superagentTools.js");
  const res = await manageSuperagentsTool.execute({ action: "status", superagentIds: ids }, process.cwd());
  return { content: [{ type: "text", text: String(res) }] };
}

export async function handleCliBridge(args: any): Promise<McpToolResult> {
  const { cliBridgeTool } = await import("../../tools/cliBridgeTool.js");
  const result = await cliBridgeTool.execute(args, process.cwd());
  return { content: [{ type: "text", text: String(result) }] };
}

/**
 * executionTools.ts — Task execution, subagent delegation, invoke, await, merge, and lifecycle management handlers for MCP.
 */

import path from "path";
import { McpToolResult } from "../types.js";
import { callServerApi } from "./processTools.js";
import { resolveMcpWorkspace, isServerRejection, getMcpWorkspacePath } from "./workspaceContext.js";
import { superagentInstances } from "../../tools/state.js";

export async function handleRunTask(args: any): Promise<McpToolResult> {
  const task = String(args.task || args.prompt || args.message || args.instruction || "");
  const role = String(args.role || args.agentRole || "assistant");
  const mode = args.mode === "multi" ? "multi" : "single";
  const ws = resolveMcpWorkspace(args.workspace);
  const targetWs = ws.path;
  const workspaceNote = ws.explicit
    ? ""
    : `Note: no 'workspace' given, so the server uses its active session. Pass 'workspace' to target a specific project.\n`;

  if (!task) {
    return {
      content: [{ type: "text", text: "Error: 'task' is required." }],
      isError: true,
    };
  }

  // Forward to running server if active. /api/chat resolves the session from the
  // x-workspace-path header (or ?workspace= / sessionId), NOT from the JSON body,
  // so the target workspace has to travel as a header when it was given explicitly.
  const serverRes = await callServerApi(
    "/api/chat",
    "POST",
    {
      message: task,
      workspace: targetWs,
      mode,
    },
    300000,
    ws.explicit ? { workspace: targetWs } : {}
  );

  if (serverRes.success) {
    return {
      content: [
        {
          type: "text",
          text:
            workspaceNote +
            (typeof serverRes.data === "string"
              ? serverRes.data
              : JSON.stringify(serverRes.data, null, 2)),
        },
      ],
    };
  }

  // The server answered but refused (e.g. no session for this workspace). Falling back to
  // headless execution here would auto-approve every permission in an arbitrary directory,
  // so report the rejection instead.
  if (ws.explicit && isServerRejection(serverRes)) {
    return {
      content: [
        {
          type: "text",
          text:
            `Error: ${serverRes.error || `Server rejected the request (status ${serverRes.status}).`}\n` +
            `No session is available for workspace ${targetWs}. Open or initialize a session for it first, then retry.`,
        },
      ],
      isError: true,
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
  const wait = args.wait === true;
  const timeoutMs = typeof args.timeoutMs === "number" ? args.timeoutMs : undefined;

  if (!prompt.trim()) {
    return {
      content: [{ type: "text", text: "Error: 'prompt' is required to spawn a subagent." }],
      isError: true,
    };
  }

  try {
    const { invokeSubagentTool } = await import("../../tools/subagentTools.js");
    const result = await invokeSubagentTool.execute(
      { typeName, role, prompt, wait, timeoutMs },
      resolveMcpWorkspace(args.workspace).path
    );
    const output = String(result);
    const isError = output.startsWith("Error:") || output.startsWith("Subagent failed:");
    return {
      content: [{ type: "text", text: output }],
      ...(isError ? { isError: true } : {}),
    };
  } catch (err: any) {
    return {
      content: [{ type: "text", text: `spawn_subagent error: ${err?.message || String(err)}` }],
      isError: true,
    };
  }
}

export async function handleSendMessage(args: any): Promise<McpToolResult> {
  const superagentId = String(args.superagentId || args.id || args.target || "");
  const message = String(args.message || args.prompt || args.instruction || "");
  const wait = args.wait === true;
  const ws = resolveMcpWorkspace(args.workspace);

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
    wait ? 300000 : 10000,
    ws.explicit ? { workspace: ws.path } : {}
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

  if (ws.explicit && isServerRejection(serverRes)) {
    return {
      content: [{
        type: "text",
        text: `Error: ${serverRes.error || `Server rejected the request (status ${serverRes.status}).`}\nNo session is available for workspace ${ws.path}. Open or initialize a session for it first, then retry.`,
      }],
      isError: true,
    };
  }

  const { sendMessageToSuperagentTool } = await import("../../tools/superagentTools.js");
  const result = await sendMessageToSuperagentTool.execute(
    { superagentId, message, wait },
    ws.path
  );
  if (typeof result === "string" && result.includes("not found")) {
    const { sendEnvelopeToProcess } = await import("../../ipc/processMailbox.js");
    const ipcRes = sendEnvelopeToProcess(superagentId, {
      type: "message",
      message,
      sender: "mcp",
    });
    if (ipcRes.success) {
      return {
        content: [
          {
            type: "text",
            text: `Message successfully delivered to CLI process PID ${ipcRes.pid} via IPC mailbox. Target process will execute it on its next turn.`,
          },
        ],
      };
    }
  }
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

  const ws = resolveMcpWorkspace(args.workspace);
  const workspaceNote = ws.explicit
    ? ""
    : `Note: no 'workspace' given, so the server uses its active session. Pass 'workspace' to target a specific project.\n`;

  const serverRes = await callServerApi(
    "/api/superagents/invoke",
    "POST",
    { role, task, branch, wait, constraints, acceptanceCriteria },
    wait ? 600000 : 10000,
    ws.explicit ? { workspace: ws.path } : {}
  );
  if (serverRes.success) {
    // The route answers 200 even when the tool itself refuses (e.g. plan not approved),
    // so surface that refusal as an error instead of a success payload.
    const toolText = typeof serverRes.data?.result === "string" ? serverRes.data.result : "";
    return {
      content: [
        {
          type: "text",
          text:
            workspaceNote +
            (typeof serverRes.data === "string"
              ? serverRes.data
              : JSON.stringify(serverRes.data, null, 2)),
        },
      ],
      ...(toolText.startsWith("Error:") ? { isError: true } : {}),
    };
  }

  // An explicit server rejection (bad workspace, no session) must not fall back to local
  // execution: that would bypass the server's workspace guard and plan gate.
  if (isServerRejection(serverRes)) {
    return {
      content: [
        {
          type: "text",
          text: `${workspaceNote}Error: ${serverRes.error || `Server rejected the request (status ${serverRes.status}).`}`,
        },
      ],
      isError: true,
    };
  }

  // Server unreachable: run standalone in the target workspace (not getMcpWorkspacePath()).
  const { invokeSuperagentTool } = await import("../../tools/superagentTools.js");
  const result = await invokeSuperagentTool.execute(
    { role, task, branch, wait, constraints, acceptanceCriteria },
    ws.path
  );
  return {
    content: [{ type: "text", text: workspaceNote + String(result) }],
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
    getMcpWorkspacePath()
  );
  return {
    content: [{ type: "text", text: String(result) }],
  };
}

export async function handleMerge(args: any): Promise<McpToolResult> {
  const cleanupWorktrees = args.cleanupWorktrees !== false;
  const { mergeSuperagentsTool } = await import("../../tools/superagentTools.js");
  const result = await mergeSuperagentsTool.execute({ cleanupWorktrees }, getMcpWorkspacePath());
  return {
    content: [{ type: "text", text: String(result) }],
  };
}

export async function handleManage(args: any): Promise<McpToolResult> {
  const action = String(args.action || "list");
  const superagentIds = Array.isArray(args.superagentIds) ? (args.superagentIds as string[]) : undefined;

  if (action === "current_task") {
    const { handleGetCurrentTask } = await import("./workspaceTools.js");
    return await handleGetCurrentTask({ ...args, id: superagentIds?.[0] || args.id });
  }

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
  const result = await manageSuperagentsTool.execute({ action, superagentIds }, getMcpWorkspacePath());
  return {
    content: [{ type: "text", text: String(result) }],
  };
}

export async function handleGetStatus(args: any): Promise<McpToolResult> {
  const rawIds = args.superagentIds ?? args.superagent_ids ?? args.id ?? args.superagentId;
  const ids = Array.isArray(rawIds) ? (rawIds as string[]) : rawIds ? [String(rawIds)] : [];

  const { resolveInstanceCurrentTask } = await import("./taskResolver.js");

  if (ids.length > 0) {
    const lines: string[] = [];
    for (const id of ids) {
      const res = await resolveInstanceCurrentTask({ id });
      if (res.found) {
        let block = `Status for ${res.type.toUpperCase()} [${id}]:\n  Role: ${res.role || res.typeName || "Agent"}\n  Status: ${res.status}`;
        if (res.branch) block += `\n  Branch: ${res.branch}`;
        if (res.goal) block += `\n  Objective: ${res.goal}`;
        block += `\n  Current Task: ${res.currentTask} (${res.currentTaskStatus.toUpperCase()})`;
        if (res.totalTasks > 0) {
          block += `\n  Checklist Step: ${res.currentTaskIndex} of ${res.totalTasks} | Progress: ${res.progress}`;
        }
        if (res.worktreePath) block += `\n  Worktree: ${res.worktreePath}`;
        if (res.activeTool) block += `\n  Active Tool: ${res.activeTool}`;
        lines.push(block);
      } else {
        const serverRes = await callServerApi("/api/instances", "GET");
        if (serverRes.success && serverRes.data?.superagents) {
          const matched = serverRes.data.superagents.find((s: any) => s.id === id);
          if (matched) {
            lines.push(
              `Superagent ${matched.id} (${matched.role}):\n  Status: ${matched.status}\n  Task: ${matched.prompt || "(none)"}\n  Result: ${matched.result || "(no result yet)"}`
            );
            continue;
          }
        }
        lines.push(`Error: No active Superagent, Subagent, or process found with ID "${id}".`);
      }
    }
    return { content: [{ type: "text", text: lines.join("\n\n") }] };
  }

  const { superagentInstances, subagentInstances } = await import("../../tools/state.js");
  const lines: string[] = ["=== Superagent & Subagent Instance Statuses ==="];

  if (superagentInstances.size === 0 && subagentInstances.size === 0) {
    const { handleGetProcessStatus } = await import("./processTools.js");
    return await handleGetProcessStatus();
  }

  if (superagentInstances.size > 0) {
    lines.push("\nSuperagents:");
    for (const [id, inst] of superagentInstances.entries()) {
      const res = await resolveInstanceCurrentTask({ superagentId: id });
      let line = `  - [${id}] ${inst.role} | Status: ${inst.status} | Branch: ${inst.branch}`;
      line += `\n    Current Task: ${res.currentTask} (${res.currentTaskStatus})`;
      if (res.totalTasks > 0) {
        line += ` | Progress: ${res.progress}`;
      }
      lines.push(line);
    }
  }

  if (subagentInstances.size > 0) {
    lines.push("\nSubagents:");
    for (const [id, sub] of subagentInstances.entries()) {
      lines.push(
        `  - [${id}] ${sub.typeName} (${sub.role}) | Status: ${sub.status}\n    Task / Prompt: ${sub.prompt || "(none)"}`
      );
    }
  }

  return { content: [{ type: "text", text: lines.join("\n") }] };
}

export async function handleCliBridge(args: any): Promise<McpToolResult> {
  const { cliBridgeTool } = await import("../../tools/cliBridgeTool.js");
  const result = await cliBridgeTool.execute(args, getMcpWorkspacePath());
  return { content: [{ type: "text", text: String(result) }] };
}

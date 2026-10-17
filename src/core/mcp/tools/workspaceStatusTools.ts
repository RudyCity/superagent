/** MCP workspace identity and task status readers. */
import { McpToolResult } from "../types.js";
import { getMcpWorkspacePath } from "./workspaceContext.js";
import { loadRegistry } from "../../tools/superagentRegistry.js";

export async function handleGetWorkspace(): Promise<McpToolResult> {
  const cwd = getMcpWorkspacePath();
  let branch = "unknown";
  try {
    const { execSync } = await import("child_process");
    branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd, encoding: "utf-8" }).trim();
  } catch {}

  const registry = loadRegistry();
  const lines = [
    `Current Workspace: ${cwd}`,
    `Git Branch: ${branch}`,
    `Registered Feature Worktrees (${registry.length}):`,
  ];
  for (const r of registry) {
    lines.push(`  - [${r.id}] ${r.role} -> ${r.branch} (${r.status}) at ${r.worktreePath}`);
  }
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

export async function handleGetCurrentTask(args: any): Promise<McpToolResult> {
  const { resolveInstanceCurrentTask } = await import("./taskResolver.js");
  const targetWs = args.workspace || getMcpWorkspacePath();
  const resolution = await resolveInstanceCurrentTask(args.workspace ? args : { ...args, workspace: targetWs });

  if (!resolution.found && resolution.errorMessage) {
    return {
      content: [{ type: "text", text: `Error: ${resolution.errorMessage}` }],
      isError: true,
    };
  }

  const currentOnly = args.currentOnly ?? args.current_only ?? args.currentTaskOnly ?? false;
  if (currentOnly) {
    return {
      content: [{ type: "text", text: resolution.currentTask || "(no active task)" }],
    };
  }

  const lines: string[] = [
    `=== Current Instance Task [${resolution.type.toUpperCase()}${resolution.id ? `: ${resolution.id}` : ""}] ===`,
  ];
  if (resolution.role) lines.push(`Role: ${resolution.role}`);
  if (resolution.typeName && resolution.typeName !== resolution.role) lines.push(`Type: ${resolution.typeName}`);
  if (resolution.branch) lines.push(`Branch: ${resolution.branch}`);
  if (resolution.status) lines.push(`Status: ${resolution.status}`);
  if (resolution.goal && resolution.goal !== resolution.currentTask) lines.push(`Objective: ${resolution.goal}`);
  lines.push(`Active Task: ${resolution.currentTask}`);
  lines.push(`Task State: ${resolution.currentTaskStatus.toUpperCase()}`);
  if (resolution.totalTasks > 0) {
    lines.push(`Checklist Step: ${resolution.currentTaskIndex} of ${resolution.totalTasks}`);
    lines.push(`Progress: ${resolution.progress}`);
  }
  if (resolution.activeTool) lines.push(`Active Tool: ${resolution.activeTool}`);
  if (resolution.worktreePath) lines.push(`Worktree / Workspace: ${resolution.worktreePath}`);
  if (resolution.taskFilePath) lines.push(`Task File: ${resolution.taskFilePath}`);

  return { content: [{ type: "text", text: lines.join("\n") }] };
}

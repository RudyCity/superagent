/**
 * planSkillsMcpTools.ts — Plan management, checklist synchronization, skill engine, and surgical file mutation tools for MCP.
 */

import path from "path";
import { McpToolResult } from "../types.js";
import {
  managePlanTool,
  manageTasksTool,
  getSkillsTool,
  useSkillTool,
} from "../../tools/otherTools.js";
import { synthesizeSkillTool } from "../../tools/synthesizeSkillTool.js";
import {
  replaceFileContentTool,
  applyPatchTool,
} from "../../tools/systemTools.js";
import {
  isFullYoloMode,
  isPathWithinYoloScope,
  getYoloAllowedRoot,
} from "../../permissions.js";

function toResult(res: unknown): McpToolResult {
  const text = typeof res === "string" ? res : JSON.stringify(res, null, 2);
  const isError =
    typeof res === "string" &&
    (res.startsWith("Error:") ||
      res.startsWith("Failed to") ||
      res.includes("[LOCK_CONFLICT]"));
  return {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
  };
}

export async function handleManagePlan(args: any): Promise<McpToolResult> {
  try {
    const res = await managePlanTool.execute(args || {}, process.cwd());
    return toResult(res);
  } catch (err: any) {
    return {
      content: [{ type: "text", text: `manage_plan error: ${err?.message || String(err)}` }],
      isError: true,
    };
  }
}

export async function handleManageTasks(args: any): Promise<McpToolResult> {
  try {
    const res = await manageTasksTool.execute(args || {}, process.cwd());
    return toResult(res);
  } catch (err: any) {
    return {
      content: [{ type: "text", text: `manage_tasks error: ${err?.message || String(err)}` }],
      isError: true,
    };
  }
}

export async function handleGetSkills(args: any): Promise<McpToolResult> {
  try {
    const res = await getSkillsTool.execute(args || {}, process.cwd());
    return toResult(res);
  } catch (err: any) {
    return {
      content: [{ type: "text", text: `get_skills error: ${err?.message || String(err)}` }],
      isError: true,
    };
  }
}

export async function handleUseSkill(args: any): Promise<McpToolResult> {
  try {
    const res = await useSkillTool.execute(args || {}, process.cwd());
    return toResult(res);
  } catch (err: any) {
    return {
      content: [{ type: "text", text: `use_skill error: ${err?.message || String(err)}` }],
      isError: true,
    };
  }
}

export async function handleSynthesizeSkill(args: any): Promise<McpToolResult> {
  try {
    const res = await synthesizeSkillTool.execute(args || {}, process.cwd());
    return toResult(res);
  } catch (err: any) {
    return {
      content: [{ type: "text", text: `synthesize_skill error: ${err?.message || String(err)}` }],
      isError: true,
    };
  }
}

export async function handleReplaceFileContent(args: any): Promise<McpToolResult> {
  const filePath = String(args.filePath || args.TargetFile || args.path || args.file || "");
  if (!isFullYoloMode() && filePath) {
    const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
    if (path.basename(resolved).toLowerCase() === "model-config.json") {
      return {
        content: [{ type: "text", text: "Error: Editing model-config.json is strictly protected and prohibited via MCP." }],
        isError: true,
      };
    }
    if (!isPathWithinYoloScope(resolved, process.cwd())) {
      const allowedRoot = getYoloAllowedRoot(process.cwd());
      return {
        content: [{
          type: "text",
          text: `Error: File editing blocked by Scoped YOLO boundary: "${resolved}" is outside allowed scope (${allowedRoot}). Use /yolo full in SuperAgent CLI for unrestricted access.`,
        }],
        isError: true,
      };
    }
  }
  try {
    const res = await replaceFileContentTool.execute(args || {}, process.cwd());
    return toResult(res);
  } catch (err: any) {
    return {
      content: [{ type: "text", text: `replace_file_content error: ${err?.message || String(err)}` }],
      isError: true,
    };
  }
}

export async function handleApplyPatch(args: any): Promise<McpToolResult> {
  const filePath = String(args.filePath || args.path || args.file || "");
  if (!isFullYoloMode() && filePath) {
    const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
    if (path.basename(resolved).toLowerCase() === "model-config.json") {
      return {
        content: [{ type: "text", text: "Error: Patching model-config.json is strictly protected and prohibited via MCP." }],
        isError: true,
      };
    }
    if (!isPathWithinYoloScope(resolved, process.cwd())) {
      const allowedRoot = getYoloAllowedRoot(process.cwd());
      return {
        content: [{
          type: "text",
          text: `Error: Patch application blocked by Scoped YOLO boundary: "${resolved}" is outside allowed scope (${allowedRoot}). Use /yolo full in SuperAgent CLI for unrestricted access.`,
        }],
        isError: true,
      };
    }
  }
  try {
    const res = await applyPatchTool.execute(args || {}, process.cwd());
    return toResult(res);
  } catch (err: any) {
    return {
      content: [{ type: "text", text: `apply_patch error: ${err?.message || String(err)}` }],
      isError: true,
    };
  }
}

export const PLAN_SKILLS_MCP_TOOL_CLASSIFICATIONS: Record<string, "safe" | "dangerous"> = {
  superagent_manage_plan: "dangerous",
  superagent_manage_tasks: "dangerous",
  superagent_get_skills: "safe",
  superagent_use_skill: "safe",
  superagent_synthesize_skill: "dangerous",
  superagent_replace_file_content: "dangerous",
  superagent_apply_patch: "dangerous",
};

export const PLAN_SKILLS_MCP_TOOL_DEFS = [
  {
    name: "superagent_manage_plan",
    description:
      "Create, edit, sync, or retrieve the implementation plan (_implementation_plan.md) and automatically connect and synchronize it with the task checklist (_task.md).",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["create", "edit", "sync", "get"],
          description: "Action to perform: 'create' (create plan & sync tasks), 'edit' (modify plan), 'sync' (sync plan to task.md), 'get' (retrieve plan and task status).",
        },
        planContent: { type: "string", description: "Markdown content of implementation plan." },
        targetContent: { type: "string", description: "Exact text in existing plan to replace (for 'edit')." },
        replacementContent: { type: "string", description: "Replacement text (for 'edit')." },
        sessionId: { type: "string", description: "Optional session ID for multi-agent mode." },
      },
      required: ["action"],
    },
  },
  {
    name: "superagent_manage_tasks",
    description:
      "Manage tasks in the active task list (_task.md). Actions: 'list', 'add', 'add_bulk', 'update', 'remove', 'update_bulk', 'remove_bulk'.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "add", "add_bulk", "update", "remove", "update_bulk", "remove_bulk"],
          description: "Action to perform on task list.",
        },
        text: { type: "string", description: "Task description for 'add'." },
        texts: { type: "array", items: { type: "string" }, description: "Task descriptions for 'add_bulk'." },
        index: { type: "number", description: "1-based task index for 'update' or 'remove'." },
        indices: { type: "array", items: { type: "number" }, description: "1-based task indices for bulk updates/removals." },
        status: { type: "string", enum: [" ", "/", "x"], description: "New task status: ' ' (pending), '/' (in progress), 'x' (completed)." },
        sessionId: { type: "string", description: "Optional session ID for multi-agent mode." },
      },
      required: ["action"],
    },
  },
  {
    name: "superagent_get_skills",
    description:
      "List and search installed skills relevant to a specific task or query using semantic and keyword matching.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Descriptive query of the task you need skills for (e.g. 'debug typescript', 'e2e test playwright', 'cdp automation').",
        },
      },
    },
  },
  {
    name: "superagent_use_skill",
    description:
      "Activate and load the full instructions for a specific skill from SKILL.md by skill name or path.",
    inputSchema: {
      type: "object",
      properties: {
        skillName: { type: "string", description: "Exact skill name (e.g. 'systematic-debugging', 'antislop')." },
        path: { type: "string", description: "Optional absolute path to SKILL.md file." },
      },
    },
  },
  {
    name: "superagent_synthesize_skill",
    description:
      "Synthesizes a new reusable skill (SKILL.md) from the current workflow, commands, and problem-solving patterns into .agents/skills/<name>/SKILL.md.",
    inputSchema: {
      type: "object",
      properties: {
        taskDescription: { type: "string", description: "Clear summary of the task or workflow accomplished." },
        skillName: { type: "string", description: "Optional kebab-case identifier (e.g. 'sqlite-migration-helper')." },
        category: { type: "string", description: "Optional category (e.g. 'database', 'testing', 'refactor')." },
      },
      required: ["taskDescription"],
    },
  },
  {
    name: "superagent_replace_file_content",
    description:
      "Surgically replace a contiguous block of text in a file within a specified line range, with syntax verification and concurrency locking.",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Path to the file to edit." },
        targetContent: { type: "string", description: "The exact content to replace." },
        replacementContent: { type: "string", description: "The replacement content." },
        startLine: { type: "number", description: "Start line number of the block (1-indexed)." },
        endLine: { type: "number", description: "End line number of the block (1-indexed)." },
        allowMultiple: { type: "boolean", description: "Allow multiple occurrences within the line range." },
      },
      required: ["filePath", "targetContent", "replacementContent", "startLine", "endLine"],
    },
  },
  {
    name: "superagent_apply_patch",
    description:
      "Apply unified diff patches or search-replace format blocks to modify files in bulk or single file.",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Path to the file to patch." },
        patchContent: { type: "string", description: "Unified diff or search-replace format block." },
        patches: {
          type: "array",
          items: {
            type: "object",
            properties: {
              filePath: { type: "string" },
              patchContent: { type: "string" },
            },
            required: ["filePath", "patchContent"],
          },
          description: "List of patches to apply across multiple files in bulk.",
        },
      },
    },
  },
];

export async function dispatchPlanSkillsMcpTool(name: string, args: any): Promise<McpToolResult | null> {
  switch (name) {
    case "superagent_manage_plan":
      return await handleManagePlan(args);
    case "superagent_manage_tasks":
      return await handleManageTasks(args);
    case "superagent_get_skills":
      return await handleGetSkills(args);
    case "superagent_use_skill":
      return await handleUseSkill(args);
    case "superagent_synthesize_skill":
      return await handleSynthesizeSkill(args);
    case "superagent_replace_file_content":
      return await handleReplaceFileContent(args);
    case "superagent_apply_patch":
    case "superagent_patch":
      return await handleApplyPatch(args);
    default:
      return null;
  }
}

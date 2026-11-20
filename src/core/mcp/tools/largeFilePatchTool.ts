import fs from "node:fs";
import path from "node:path";
import { assertPathWithinProject } from "../../project/projectRouter.js";
import { isPathWithinMcpScope } from "../../permissions.js";
import { registeredFileToolGate } from "../../tools/registeredFileToolGate.js";
import { getMcpWorkspacePath } from "./workspaceContext.js";
import {
  applyLinePatchOperations,
  isPatchableTargetFile,
  type PatchOperation,
} from "../mcpLargeFilePatch.js";
import type { McpToolResult } from "../types.js";

export const PATCH_LARGE_FILE_MCP_TOOL_DEF = {
  name: "superagent_patch_file",
  description:
    "Apply targeted line-range replacements or insertions to an existing large file without sending the full file content over MCP.",
  inputSchema: {
    type: "object",
    properties: {
      filePath: { type: "string", description: "Target file path inside the authorized workspace." },
      operations: {
        type: "array",
        minItems: 1,
        maxItems: 50,
        items: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["replace_block", "insert_before", "insert_after"] },
            startLine: { type: "integer", minimum: 1 },
            endLine: { type: "integer", minimum: 1 },
            line: { type: "integer", minimum: 0 },
            expectedSnippet: { type: "string" },
            expectedLineSnippet: { type: "string" },
            replacement: { type: "string" },
            content: { type: "string" },
          },
          required: ["kind"],
        },
      },
      workspace: { type: "string", description: "Optional workspace path." },
      cwd: { type: "string", description: "Optional working directory." },
      projectId: { type: "string", description: "Optional registered project ID." },
    },
    required: ["filePath", "operations"],
  },
};

export async function handlePatchFile(args: any): Promise<McpToolResult> {
  const filePath = String(args?.filePath || args?.path || args?.file || "").trim();
  const operations = Array.isArray(args?.operations) ? (args.operations as PatchOperation[]) : null;
  const targetCwd = String(args?.cwd || args?.workspace || getMcpWorkspacePath());

  if (!filePath || !operations || operations.length === 0) {
    return {
      content: [{ type: "text", text: "Error: 'filePath' and non-empty 'operations' array are required." }],
      isError: true,
    };
  }

  if (!isPatchableTargetFile(filePath)) {
    return {
      content: [{ type: "text", text: `Error: File type is not supported by superagent_patch_file: ${filePath}` }],
      isError: true,
    };
  }

  const fileBlock = registeredFileToolGate({ name: "superagent_write_file", args: { filePath } }, targetCwd);
  if (fileBlock) {
    return {
      content: [{ type: "text", text: "Access denied by permanent host file policy: " + fileBlock }],
      isError: true,
    };
  }

  let resolved: string;
  try {
    if (/^(?:ssh:|chain:)/i.test(targetCwd)) {
      throw new Error("superagent_patch_file only supports local workspaces.");
    }
    resolved = assertPathWithinProject(
      path.isAbsolute(filePath) ? filePath : path.resolve(targetCwd, filePath),
      targetCwd,
    );
  } catch (error: any) {
    return {
      content: [{ type: "text", text: `Error: ${error?.message || String(error)}` }],
      isError: true,
    };
  }

  if (path.basename(resolved).toLowerCase() === "model-config.json") {
    return {
      content: [{ type: "text", text: "Error: Writing to model-config.json is strictly protected and prohibited via MCP." }],
      isError: true,
    };
  }

  if (!isPathWithinMcpScope(resolved, getMcpWorkspacePath())) {
    return {
      content: [{
        type: "text",
        text: `Error: File patch blocked. Target path "${resolved}" is outside registered project scope.`,
      }],
      isError: true,
    };
  }

  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    return {
      content: [{ type: "text", text: `Error: Target file not found: ${resolved}` }],
      isError: true,
    };
  }

  try {
    const { checkFileLock, releaseFile } = await import("../../storage/sharedMemory.js");
    const lockCheck = checkFileLock(resolved, undefined, targetCwd);
    if (lockCheck.locked) {
      if (args?.force === true) {
        releaseFile(resolved, undefined, targetCwd, true);
      } else {
        return {
          content: [{
            type: "text",
            text: `Error: [LOCK_CONFLICT] File "${resolved}" is locked by session ${lockCheck.owner?.sessionId || "unknown"}.`,
          }],
          isError: true,
        };
      }
    }
  } catch (err: any) {
    if (err?.code === "LOCK_CONFLICT") {
      return { content: [{ type: "text", text: `Error: [LOCK_CONFLICT] ${err.message}` }], isError: true };
    }
  }

  try {
    const original = await fs.promises.readFile(resolved, "utf8");
    const updated = applyLinePatchOperations(original, operations);
    await fs.promises.writeFile(resolved, updated, "utf8");
    return {
      content: [{
        type: "text",
        text: `Patched ${resolved} (${operations.length} operation(s); ${updated.length} chars total).`,
      }],
    };
  } catch (err: any) {
    return {
      content: [{ type: "text", text: `Error patching file: ${err?.message || String(err)}` }],
      isError: true,
    };
  }
}

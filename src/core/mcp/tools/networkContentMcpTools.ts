/**
 * networkContentMcpTools.ts — Web search, page fetching, academic journals, document reading, office CLI, and git actions for MCP.
 */

import { McpToolResult } from "../types.js";
import path from "node:path";
import { webSearchTool, fetchUrlTool } from "../../tools/networkTools.js";
import { searchJournalTool } from "../../tools/academicSearchTools.js";
import { readDocumentTool } from "../../tools/documentReadTools.js";
import { officeCliTool } from "../../tools/officeCliTools.js";
import { gitActionTool } from "../../tools/otherTools.js";
import { getMcpWorkspacePath } from "./workspaceContext.js";
import { assertPathWithinProject } from "../../project/projectRouter.js";

function toResult(res: unknown): McpToolResult {
  const text = typeof res === "string" ? res : JSON.stringify(res, null, 2);
  const isError =
    typeof res === "string" &&
    (res.startsWith("Error:") ||
      res.startsWith("Failed:") ||
      res.startsWith("Git action error:"));
  return {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
  };
}

export async function handleWebSearch(args: any): Promise<McpToolResult> {
  try {
    const res = await webSearchTool.execute(args || {}, getMcpWorkspacePath());
    return toResult(res);
  } catch (err: any) {
    return {
      content: [{ type: "text", text: `web_search error: ${err?.message || String(err)}` }],
      isError: true,
    };
  }
}

export async function handleFetchUrl(args: any): Promise<McpToolResult> {
  try {
    const res = await fetchUrlTool.execute(args || {}, getMcpWorkspacePath());
    return toResult(res);
  } catch (err: any) {
    return {
      content: [{ type: "text", text: `fetch_url error: ${err?.message || String(err)}` }],
      isError: true,
    };
  }
}

export async function handleSearchJournal(args: any): Promise<McpToolResult> {
  try {
    const res = await searchJournalTool.execute(args || {}, getMcpWorkspacePath());
    return toResult(res);
  } catch (err: any) {
    return {
      content: [{ type: "text", text: `search_journal error: ${err?.message || String(err)}` }],
      isError: true,
    };
  }
}

export async function handleReadDocument(args: any): Promise<McpToolResult> {
  const filePath = String(args.filePath || "");
  const workspace = getMcpWorkspacePath();
  if (!filePath) return { content: [{ type: "text", text: "Error: 'filePath' is required." }], isError: true };
  try {
    if (/^(?:ssh:|chain:)/i.test(workspace)) throw new Error("Document reads require a local workspace. Use Workspace Chain tools for remote nodes.");
    const resolved = assertPathWithinProject(path.isAbsolute(filePath) ? filePath : path.resolve(workspace, filePath), workspace);
    const res = await readDocumentTool.execute({ ...args, filePath: resolved }, workspace);
    return toResult(res);
  } catch (err: any) {
    return {
      content: [{ type: "text", text: `read_document error: ${err?.message || String(err)}` }],
      isError: true,
    };
  }
}

export async function handleOfficeCli(args: any): Promise<McpToolResult> {
  try {
    const res = await officeCliTool.execute(args || {}, getMcpWorkspacePath());
    return toResult(res);
  } catch (err: any) {
    return {
      content: [{ type: "text", text: `office_cli error: ${err?.message || String(err)}` }],
      isError: true,
    };
  }
}

export async function handleGitAction(args: any): Promise<McpToolResult> {
  const workspace = getMcpWorkspacePath();
  if (/^(?:ssh:|chain:)/i.test(workspace)) {
    return { content: [{ type: "text", text: "Git actions require a local project workspace." }], isError: true };
  }
  if (["add", "restore"].includes(String(args.action || "")) && Array.isArray(args.files)) {
    try {
      for (const file of args.files) {
        if (typeof file !== "string" || !file.trim()) throw new Error("Each git file path must be a non-empty string.");
        assertPathWithinProject(path.isAbsolute(file) ? file : path.resolve(workspace, file), workspace);
      }
    } catch (error) {
      return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
  }
  try {
    const res = await gitActionTool.execute(args || {}, workspace);
    return toResult(res);
  } catch (err: any) {
    return {
      content: [{ type: "text", text: `git_action error: ${err?.message || String(err)}` }],
      isError: true,
    };
  }
}

export const NETWORK_CONTENT_MCP_TOOL_CLASSIFICATIONS: Record<string, "safe" | "dangerous"> = {
  superagent_web_search: "safe",
  superagent_fetch_url: "safe",
  superagent_search_journal: "safe",
  superagent_read_document: "safe",
  superagent_office_cli: "dangerous",
  superagent_git_action: "dangerous",
};

export const NETWORK_CONTENT_MCP_TOOL_DEFS = [
  {
    name: "superagent_web_search",
    description:
      "Search the web using DuckDuckGo search engine and extract clean titles, snippets, and source URLs.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query string." },
        limit: { type: "number", description: "Maximum number of search results (default: 5)." },
      },
      required: ["query"],
    },
  },
  {
    name: "superagent_fetch_url",
    description:
      "Fetch a web page or REST endpoint via HTTP GET and convert HTML content into clean markdown text.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The full HTTP or HTTPS URL to fetch." },
      },
      required: ["url"],
    },
  },
  {
    name: "superagent_search_journal",
    description:
      "Search academic journals and scientific papers using Semantic Scholar, ArXiv, OpenAlex, Crossref, and CORE APIs.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Academic search query." },
        provider: {
          type: "string",
          enum: ["openalex", "arxiv", "semanticscholar", "crossref", "core", "auto"],
          description: "Preferred academic engine (default: 'auto').",
        },
        limit: { type: "number", description: "Max results (default: 5)." },
      },
      required: ["query"],
    },
  },
  {
    name: "superagent_read_document",
    description:
      "Read and extract text from PDF, Excel (.xlsx, .xls), Word (.docx), Markdown, TXT, CSV, JSON, YAML, XML, HTML, logs, and common source-code text files.",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Path to PDF/XLSX/XLS/DOCX or readable text file such as MD, TXT, CSV, JSON, YAML, XML, HTML, logs, or source code, within the selected project root." },
        workspace: { type: "string", description: "Optional workspace path within a registered project." },
        projectId: { type: "string", description: "Stable ID of a registered project." },
      },
      required: ["filePath"],
    },
  },
  {
    name: "superagent_office_cli",
    description:
      "Execute officecli commands to create, modify, inspect, or convert Word (.docx), Excel (.xlsx), and PowerPoint (.pptx) documents.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Officecli subcommand to execute." },
        workspace: { type: "string", description: "Optional registered project workspace." },
        projectId: { type: "string", description: "Stable ID of a registered project." },
      },
      required: ["command"],
    },
  },
  {
    name: "superagent_git_action",
    description:
      "Perform structured Git repository actions: 'status', 'diff', 'commit', 'log', 'add', 'restore', 'clean'.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["status", "diff", "commit", "log", "add", "restore", "clean"],
          description: "Git action to perform.",
        },
        message: { type: "string", description: "Commit message (required for commit)." },
        limit: { type: "number", description: "Max commit log entries (default: 5)." },
        files: { type: "array", items: { type: "string" }, description: "Files to stage or restore, restricted to the selected project." },
        workspace: { type: "string", description: "Optional registered project workspace." },
        projectId: { type: "string", description: "Stable ID of a registered project." },
      },
      required: ["action"],
    },
  },
];

export async function dispatchNetworkContentMcpTool(name: string, args: any): Promise<McpToolResult | null> {
  switch (name) {
    case "superagent_web_search":
      return await handleWebSearch(args);
    case "superagent_fetch_url":
      return await handleFetchUrl(args);
    case "superagent_search_journal":
      return await handleSearchJournal(args);
    case "superagent_read_document":
      return await handleReadDocument(args);
    case "superagent_office_cli":
      return await handleOfficeCli(args);
    case "superagent_git_action":
      return await handleGitAction(args);
    default:
      return null;
  }
}

import path from "path";
import { Tool } from "./types.js";
import { CodebaseIndexer } from "../context/codebaseIndexer.js";
import { getNormalizedProjectPath } from "./helpers.js";

export const codebaseSearchTool: Tool = {
  name: "codebase_search",
  description: "Perform semantic vector search over the indexed codebase to find relevant code snippets, functions, classes, or usage patterns without reading every file manually.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Semantic search query describing the functionality, function name, feature, or logic you want to find.",
      },
      limit: {
        type: "number",
        description: "Maximum number of code snippets to return (default: 5).",
      },
    },
    required: ["query"],
  },
  async execute(args, cwd) {
    const query = String(args.query || "").trim();
    if (!query) {
      return "Error: query argument is required.";
    }

    const limit = Number(args.limit) || 5;
    const activeWorkspace = getNormalizedProjectPath(cwd || process.cwd());

    try {
      const results = await CodebaseIndexer.searchCodebase(activeWorkspace, query, limit);
      if (!results || results.length === 0) {
        return `No code snippets found matching query: "${query}". You can try broader search terms or use file_search/grep_search tools.`;
      }

      const formatted = results.map((r, i) => {
        return `--- Result #${i + 1} (Score: ${(r.score * 100).toFixed(1)}%) ---\nFile: ${r.relativePath} (lines ${r.startLine}-${r.endLine})\n\n${r.content}`;
      }).join("\n\n");

      return formatted;
    } catch (err: any) {
      return `Failed to search codebase: ${err.message || String(err)}`;
    }
  },
};

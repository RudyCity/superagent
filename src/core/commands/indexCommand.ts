import { SlashCommand, SlashCommandContext } from "./types.js";
import { registry } from "./registry.js";
import { CodebaseIndexer } from "../context/codebaseIndexer.js";
import path from "path";

export const indexCommand: SlashCommand = {
  name: "index",
  description: "Manage codebase vector embeddings for the active workspace (/index, /index clean, /index search <query>)",
  execute: async (args: string, ctx: SlashCommandContext): Promise<void> => {
    const parts = args.trim().split(/\s+/);
    const sub = (parts[0] || "").toLowerCase();
    const activeWorkspace = process.cwd();

    if (sub === "status" || sub === "info") {
      const stats = await CodebaseIndexer.getStatus(activeWorkspace);
      ctx.addLine({
        type: "system",
        content: `Codebase Index Status [${path.basename(activeWorkspace)}]:\n- Indexed Files: ${stats.indexedFiles}\n- Stored Vector Chunks: ${stats.totalChunks}\n- Cache Directory: ${stats.indexDir}`,
        timestamp: Date.now(),
      });
      return;
    }

    if (sub === "clean" || sub === "reset" || sub === "clear") {
      ctx.addLine({
        type: "system",
        content: `Clearing codebase index for workspace: ${path.basename(activeWorkspace)}...`,
        timestamp: Date.now(),
      });
      await CodebaseIndexer.clearIndex(activeWorkspace);
      ctx.addLine({
        type: "system",
        content: `Codebase index cleared successfully.`,
        timestamp: Date.now(),
      });
      return;
    }

    if (sub === "search") {
      const query = parts.slice(1).join(" ").trim();
      if (!query) {
        ctx.addLine({
          type: "error",
          content: "Usage: /index search <query>",
          timestamp: Date.now(),
        });
        return;
      }
      ctx.addLine({
        type: "system",
        content: `Searching codebase index for "${query}"...`,
        timestamp: Date.now(),
      });
      const results = await CodebaseIndexer.searchCodebase(activeWorkspace, query, 5);
      if (results.length === 0) {
        ctx.addLine({
          type: "system",
          content: "No matching code snippets found in vector store.",
          timestamp: Date.now(),
        });
      } else {
        const text = results.map((r, i) =>
          `[${i + 1}] ${r.relativePath} (${r.startLine}-${r.endLine}) - Score: ${(r.score * 100).toFixed(1)}%\n${r.content.substring(0, 300)}...`
        ).join("\n\n");
        ctx.addLine({
          type: "assistant",
          content: text,
          timestamp: Date.now(),
        });
      }
      return;
    }

    // Default: index workspace
    ctx.addLine({
      type: "system",
      content: `Indexing codebase files for workspace: ${path.basename(activeWorkspace)}...`,
      timestamp: Date.now(),
    });

    const res = await CodebaseIndexer.indexWorkspace(activeWorkspace, sub === "force" || sub === "rebuild");
    ctx.addLine({
      type: "system",
      content: `Indexing completed: ${res.indexedFiles} files processed, ${res.totalChunks} code chunks vector-stored.`,
      timestamp: Date.now(),
    });
  },
};

registry.register(indexCommand);


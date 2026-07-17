import { SlashCommand } from "./types.js";
import { registry } from "./registry.js";
import { getSettings } from "../config.js";
import { getRMemoryClient, getRMemorySessionKey } from "../rmemoryUtil.js";

export const memoryCommand: SlashCommand = {
  name: "memory",
  description: "Manage and inspect RMemory long-term memory",
  async execute(args, ctx) {
    const trimmed = args.trim();
    const parts = trimmed.split(/\s+/);
    const subcommand = parts[0]?.toLowerCase() || "help";

    const settings = getSettings();
    if (!settings.enableRmemory) {
      ctx.addLine({
        type: "error",
        content: "RMemory memory is currently disabled. Enable it in settings first.",
        timestamp: Date.now(),
      });
      return;
    }

    const client = getRMemoryClient(5000); // 5s timeout

    if (subcommand === "status") {
      ctx.addLine({
        type: "system",
        content: "Checking RMemory memory status...",
        timestamp: Date.now(),
      });

      try {
        const historyPath = ctx.agent?.getCurrentHistoryFilePath() || null;
        const sessionKey = getRMemorySessionKey(historyPath);
        
        // Quick connection check
        await client.readCore();

        const watermark = ctx.agent?.getHistory()?.lastCapturedTimestamp;
        const watermarkStr = watermark 
          ? new Date(watermark).toLocaleString() 
          : "None (no turns synchronized yet)";

        const lines = [
          "----------------------------------------------------------------------",
          "RMEMORY STATUS",
          "----------------------------------------------------------------------",
          "RMemory Memory Status: Active",
          `Session ID: ${sessionKey}`,
          `Embedding Provider: ${settings.rmemoryEmbeddingProvider || "local"}`,
          `Embedding Model: ${settings.rmemoryEmbeddingProvider === "local" ? "nomic-embed-text-v1.5" : (settings.rmemoryEmbeddingModel || "text-embedding-3-small")}`,
          `Last Sync Watermark: ${watermarkStr}`,
          "----------------------------------------------------------------------",
        ];

        ctx.addLine({
          type: "system",
          content: lines.join("\n"),
          timestamp: Date.now(),
        });
      } catch (err: any) {
        ctx.addLine({
          type: "error",
          content: `RMemory Memory Status: Error\n  Error: ${err.message}`,
          timestamp: Date.now(),
        });
      }
      return;
    }

    if (subcommand === "search") {
      const query = parts.slice(1).join(" ");
      if (!query) {
        ctx.addLine({
          type: "error",
          content: "Usage: /memory search <query>",
          timestamp: Date.now(),
        });
        return;
      }

      ctx.addLine({
        type: "system",
        content: `Searching memories for: "${query}"...`,
        timestamp: Date.now(),
      });

      try {
        const res = await client.searchAtomic({ query, limit: 5 });
        const items = res.items || [];
        if (items.length === 0) {
          ctx.addLine({
            type: "system",
            content: "No matching memories found.",
            timestamp: Date.now(),
          });
          return;
        }

        const lines = [
          "----------------------------------------------------------------------",
          `MEMORY SEARCH RESULTS FOR: "${query}"`,
          "----------------------------------------------------------------------",
        ];
        for (const item of items) {
          const typeTag = item.type ? ` [Type: ${item.type}]` : "";
          lines.push(`ID: ${item.id}${typeTag}`);
          lines.push(`Score: ${item.score?.toFixed(4) || "N/A"}`);
          lines.push(`Content: ${item.content}`);
          lines.push("----------------------------------------------------------------------");
        }

        ctx.addLine({
          type: "system",
          content: lines.join("\n"),
          timestamp: Date.now(),
        });
      } catch (err: any) {
        ctx.addLine({
          type: "error",
          content: `Memory search failed: ${err.message}`,
          timestamp: Date.now(),
        });
      }
      return;
    }

    if (subcommand === "add") {
      const argsText = parts.slice(1).join(" ");
      const matches = argsText.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
      const key = matches[0]?.replace(/"/g, "");
      const value = matches[1]?.replace(/"/g, "");
      const type = matches[2]?.replace(/"/g, "") || "preference";

      if (!key || !value) {
        ctx.addLine({
          type: "error",
          content: "Usage: /memory add <key> <value> [type]\nExample: /memory add user-name \"John Doe\" preference",
          timestamp: Date.now(),
        });
        return;
      }

      ctx.addLine({
        type: "system",
        content: `Saving memory "${key}"...`,
        timestamp: Date.now(),
      });

      try {
        const res = await client.updateAtomic({ id: key, content: value });
        ctx.addLine({
          type: "system",
          content: `✓ Memory saved successfully.\n  ID: ${res.id}\n  Updated: ${new Date(res.updated_at).toLocaleString()}`,
          timestamp: Date.now(),
        });
      } catch (err: any) {
        ctx.addLine({
          type: "error",
          content: `Failed to save memory: ${err.message}`,
          timestamp: Date.now(),
        });
      }
      return;
    }

    if (subcommand === "delete") {
      const key = parts[1];
      if (!key) {
        ctx.addLine({
          type: "error",
          content: "Usage: /memory delete <key>",
          timestamp: Date.now(),
        });
        return;
      }

      ctx.addLine({
        type: "system",
        content: `Deleting memory "${key}"...`,
        timestamp: Date.now(),
      });

      try {
        await client.deleteAtomic({ ids: [key] });
        ctx.addLine({
          type: "system",
          content: `✓ Memory "${key}" deleted successfully.`,
          timestamp: Date.now(),
        });
      } catch (err: any) {
        ctx.addLine({
          type: "error",
          content: `Failed to delete memory: ${err.message}`,
          timestamp: Date.now(),
        });
      }
      return;
    }

    if (subcommand === "list-scenes") {
      ctx.addLine({
        type: "system",
        content: "Retrieving scenario blocks (L2)...",
        timestamp: Date.now(),
      });

      try {
        const res = await client.listScenarios({});
        const entries = res.entries || [];
        if (entries.length === 0) {
          ctx.addLine({
            type: "system",
            content: "No scenario blocks found.",
            timestamp: Date.now(),
          });
          return;
        }

        const lines = [
          "----------------------------------------------------------------------",
          "SCENARIO BLOCKS (L2)",
          "----------------------------------------------------------------------",
        ];
        for (const entry of entries) {
          lines.push(`- ${entry.path}`);
        }
        lines.push("----------------------------------------------------------------------");

        ctx.addLine({
          type: "system",
          content: lines.join("\n"),
          timestamp: Date.now(),
        });
      } catch (err: any) {
        ctx.addLine({
          type: "error",
          content: `Failed to list scenarios: ${err.message}`,
          timestamp: Date.now(),
        });
      }
      return;
    }

    if (subcommand === "read-scene") {
      const filePath = parts[1];
      if (!filePath) {
        ctx.addLine({
          type: "error",
          content: "Usage: /memory read-scene <path>\nExample: /memory read-scene scene_blocks/coding-style.md",
          timestamp: Date.now(),
        });
        return;
      }

      ctx.addLine({
        type: "system",
        content: `Reading scenario block: "${filePath}"...`,
        timestamp: Date.now(),
      });

      try {
        const res = await client.readScenario({ path: filePath });
        if (!res || res.content === null) {
          ctx.addLine({
            type: "error",
            content: `Failed to read scenario block file: File not found: ${filePath}`,
            timestamp: Date.now(),
          });
          return;
        }

        ctx.addLine({
          type: "system",
          content: `----------------------------------------------------------------------\nSCENARIO BLOCK FILE: ${filePath}\n----------------------------------------------------------------------\n\n${res.content}\n----------------------------------------------------------------------`,
          timestamp: Date.now(),
        });
      } catch (err: any) {
        ctx.addLine({
          type: "error",
          content: `Failed to read scenario block file: ${err.message}`,
          timestamp: Date.now(),
        });
      }
      return;
    }

    if (subcommand === "read-persona") {
      ctx.addLine({
        type: "system",
        content: "Reading user persona (L3)...",
        timestamp: Date.now(),
      });

      try {
        const res = await client.readCore();
        if (!res || res.content === null) {
          ctx.addLine({
            type: "system",
            content: "No user persona profile (persona.md) found.",
            timestamp: Date.now(),
          });
          return;
        }

        ctx.addLine({
          type: "system",
          content: `----------------------------------------------------------------------\nUSER PERSONA (persona.md)\n----------------------------------------------------------------------\n\n${res.content}\n----------------------------------------------------------------------`,
          timestamp: Date.now(),
        });
      } catch (err: any) {
        ctx.addLine({
          type: "error",
          content: `Failed to read user persona: ${err.message}`,
          timestamp: Date.now(),
        });
      }
      return;
    }

    const helpLines = [
      "----------------------------------------------------------------------",
      "RMEMORY COMMAND USAGE",
      "----------------------------------------------------------------------",
      "Usage: /memory <subcommand> [args]",
      "",
      "Subcommands:",
      "  status               Check RMemory connection and config status",
      "  search <query>       Perform a vector search through your long-term memories (L1)",
      "  add <id> <val>       Save or overwrite a long-term structured memory",
      "  delete <id>          Delete a specific long-term structured memory",
      "  list-scenes          List all scenario navigation blocks (L2)",
      "  read-scene <path>    Read the content of a specific scenario block",
      "  read-persona         Read the user persona profile (L3)",
      "  help                 Show this help menu",
      "----------------------------------------------------------------------",
    ];

    ctx.addLine({
      type: "system",
      content: helpLines.join("\n"),
      timestamp: Date.now(),
    });
  },
};

registry.register(memoryCommand);

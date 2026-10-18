import { SlashCommand } from "./types.js";
import { registry } from "./registry.js";
import { getSettings } from "../config.js";
import { getRMemoryClient, getRMemorySessionKey, getActiveRMemoryEmbeddingInfo, getRMemoryProjectId, isRmemoryActiveSync } from "../rmemoryUtil.js";
import { createMemoryRecordMetadata } from "../memoryRecord.js";
import { detectScopedMemoryConflicts, filterEligibleMemoryRecords, previewMemoryRetention } from "../memoryLifecycle.js";
import { executeMemoryQualityCommand } from "./memoryQualityCommands.js";

export const memoryCommand: SlashCommand = {
  name: "memory",
  description: "Manage and inspect RMemory long-term memory",
  async execute(args, ctx) {
    const trimmed = args.trim();
    const parts = trimmed.split(/\s+/);
    const subcommand = parts[0]?.toLowerCase() || "help";

    if (!isRmemoryActiveSync()) {
      ctx.addLine({
        type: "error",
        content: "RMemory memory is currently disabled or failed to initialize. Enable it in settings first, or check for startup errors.",
        timestamp: Date.now(),
      });
      return;
    }

    const client = getRMemoryClient(5000); // 5s timeout
    if (await executeMemoryQualityCommand(subcommand, parts, ctx as any, client)) return;

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

        const embeddingInfo = getActiveRMemoryEmbeddingInfo();

        const lines = [
          "----------------------------------------------------------------------",
          "RMEMORY STATUS",
          "----------------------------------------------------------------------",
          "RMemory Memory Status: Active",
          `Session ID: ${sessionKey}`,
          `Embedding Provider: ${embeddingInfo.provider}`,
          `Embedding Model: ${embeddingInfo.modelName} (${embeddingInfo.dimensions} dims)`,
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
        const projectId = getRMemoryProjectId(ctx.agent?.workingDirectory || process.cwd());
        const res = await client.searchAtomic({ query, limit: 50, projectId });
        const recall = filterEligibleMemoryRecords((res.items || []) as any[], { projectId, scope: "all" });
        const items = recall.items.slice(0, 10);
        if (items.length === 0) {
          ctx.addLine({
            type: "system",
            content: recall.withheldCount > 0
              ? `No eligible current memories found. ${recall.withheldCount} scoped record(s) were withheld; ${recall.conflictPairCount} explicit conflict pair(s) need review.`
              : "No matching memories found in the current project/global scope.",
            timestamp: Date.now(),
          });
          return;
        }

        const lines = [
          "----------------------------------------------------------------------",
          `MEMORY SEARCH RESULTS FOR: "${query}"`,
          `Recall: injected=${items.length}, withheld=${recall.withheldCount}, cross-scope rejected=${recall.crossScopeRejectedCount}, conflict pairs=${recall.conflictPairCount}`,
          "----------------------------------------------------------------------",
        ];
        for (const item of items) {
          const typeTag = item.type ? ` [Type: ${item.type}]` : "";
          lines.push(`ID: ${item.id}${typeTag}`);
          lines.push(`Score: ${item.score?.toFixed(4) || "N/A"}`);
          lines.push(`Content: ${item.content}`);
          const metadata = item.metadata || {};
          const provenance = metadata.provenance && typeof metadata.provenance === "object" ? metadata.provenance : {};
          const metadataLine = [
            metadata.scope ? `Scope: ${metadata.scope}` : undefined,
            metadata.projectId ? `Project ID: ${metadata.projectId}` : undefined,
            metadata.schemaVersion ? `Schema: ${metadata.schemaVersion}` : undefined,
            metadata.validationStatus ? `Validation: ${metadata.validationStatus}` : undefined,
            metadata.reviewState ? `Review: ${metadata.reviewState}` : undefined,
            metadata.lifecycleState ? `Lifecycle: ${metadata.lifecycleState}` : undefined,
            metadata.retentionClass ? `Retention: ${metadata.retentionClass}` : undefined,
            metadata.expiresAt ? `Expires: ${metadata.expiresAt}` : undefined,
            metadata.updatedAt ? `Updated: ${metadata.updatedAt}` : undefined,
            provenance.source ? `Source: ${provenance.source}` : undefined,
          ].filter(Boolean).join(" | ");
          if (metadataLine) lines.push(`Metadata: ${metadataLine}`);
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
        const projectId = getRMemoryProjectId(ctx.agent?.workingDirectory || process.cwd());
        const now = new Date().toISOString();
        const res = await client.updateAtomic({
          id: key,
          content: `[project:${projectId}] ${value.replace(/^\[(?:global|project(?::[^\]]+)?)\]\s*/i, "")}`,
          metadata: createMemoryRecordMetadata({
            memoryId: key,
            memoryType: type,
            scope: "project",
            projectId,
            source: "memory_command_add",
            agentTier: ctx.agent?.tier || "unknown",
            now,
          }),
        });
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
      const scope = parts[2]?.toLowerCase() === "global" ? "global" : "project";
      if (!key) {
        ctx.addLine({
          type: "error",
          content: "Usage: /memory delete <key> [project|global] (default: project)",
          timestamp: Date.now(),
        });
        return;
      }

      const currentAgent = ctx.agent as any;
      const askQuestion = currentAgent?.onQuestion;
      if (typeof askQuestion !== "function") {
        ctx.addLine({
          type: "error",
          content: "Memory deletion requires interactive owner confirmation; no record was changed.",
          timestamp: Date.now(),
        });
        return;
      }
      let confirmation: unknown;
      try {
        confirmation = await askQuestion(`Permanently delete ${scope}-scope memory "${key}"?`, ["Yes", "No"]);
      } catch {
        confirmation = undefined;
      }
      if (confirmation !== "Yes") {
        ctx.addLine({
          type: "system",
          content: `Memory deletion cancelled for ${scope}-scope memory "${key}"; no record was changed.`,
          timestamp: Date.now(),
        });
        return;
      }

      ctx.addLine({
        type: "system",
        content: `Deleting ${scope}-scope memory "${key}"...`,
        timestamp: Date.now(),
      });

      try {
        const deleted = await client.deleteAtomicScoped({
          id: key,
          scope,
          projectId: getRMemoryProjectId(ctx.agent?.workingDirectory || process.cwd()),
        });
        ctx.addLine({
          type: deleted ? "system" : "error",
          content: deleted
            ? `✓ ${scope}-scope memory "${key}" deleted successfully.`
            : `No ${scope}-scope memory found for "${key}"; nothing was deleted.`,
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

    if (subcommand === "sync") {
      if (!ctx.agent) {
        ctx.addLine({
          type: "error",
          content: "No active agent session to sync.",
          timestamp: Date.now(),
        });
        return;
      }

      ctx.addLine({
        type: "system",
        content: "Synchronizing conversation history to RMemory database...",
        timestamp: Date.now(),
      });

      try {
        await ctx.agent.saveHistory();
        ctx.addLine({
          type: "system",
          content: "Synchronization complete.",
          timestamp: Date.now(),
        });
      } catch (err: any) {
        ctx.addLine({
          type: "error",
          content: `Failed to synchronize: ${err.message}`,
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
      "  revise preview|apply|history|restore ...  Reviewable updates with version history",
      "  review conflicts|verify|quarantine|legacy-preview ...  Owner review workflows",
      "  retention-review preview|mark-stale ...  Preview-first, non-destructive retention",
      "  sync                 Manually trigger synchronization of history to RMemory database",
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

import fs from "fs";
import path from "path";
import { Tool } from "./types.js";
import { getRootConfigDir } from "../config/paths.js";
import { getNormalizedProjectPath } from "./helpers.js";
import { getRMemoryProjectId } from "../rmemoryUtil.js";
import { createMemoryRecordMetadata } from "../memoryRecord.js";

export interface SharedMemoryEntry {
  key: string;
  value: string;
  source: string;
  timestamp: number;
  scope?: "global" | "project";
  projectPath?: string;
}

export const saveSharedMemoryTool: Tool = {
  name: "save_shared_memory",
  description: "Save a key finding, API change, or crucial codebase fact to shared memory so other parallel Superagents/Subagents can see it. Specify scope as 'project' (default, workspace-specific) or 'global' (universal preference) to optimize token usage.",
  parameters: {
    type: "object",
    properties: {
      key: {
        type: "string",
        description: "A short, descriptive identifier or title of the finding, e.g., 'auth-api-deprecated' or 'vitest-require-setup'",
      },
      value: {
        type: "string",
        description: "The detailed finding, codebase fact, or context to share",
      },
      scope: {
        type: "string",
        enum: ["project", "global"],
        description: "Scope of the memory. 'project' (default) isolates memory to the current workspace. 'global' shares it universally across all projects.",
      },
    },
    required: ["key", "value"],
  },
  async execute(args, cwd, signal) {
    const key = (args.key as string).trim();
    const value = (args.value as string).trim();
    const scope: "global" | "project" = args.scope === "global" ? "global" : "project";
    const projectPath = getNormalizedProjectPath(cwd || process.cwd());

    if (!key || !value) {
      return "Error: key and value cannot be empty.";
    }

    const { agentLocalStorage } = await import("../agent.js");
    const currentAgent = agentLocalStorage.getStore();

    // Tier guard (audit fix M5): only Master Agent and Superagent may
    // write to shared memory. Subagents (researcher, coder, reviewer,
    // etc.) MUST be read-only so a single subagent cannot poison
    // cross-session knowledge that other agents consume. The toolset
    // already filters these tools out of subagent definitions; this is
    // the runtime belt-and-suspenders check.
    if (
      currentAgent &&
      currentAgent.tier !== "master" &&
      currentAgent.tier !== "superagent" &&
      currentAgent.tier !== "single"
    ) {
      return `Error: save_shared_memory is restricted to Master Agent and Superagent tiers. Current tier: ${currentAgent.tier}. To record findings, return them to your parent Superagent and let it decide what to persist.`;
    }

    let source = "system";
    if (currentAgent) {
      if (currentAgent.tier === "master") {
        source = "master";
      } else if (currentAgent.tier === "superagent") {
        const { superagentInstances } = await import("./state.js");
        const inst = [...superagentInstances.values()].find(i => i.agent === currentAgent);
        source = inst ? inst.role : "superagent";
      } else if (currentAgent.tier === "subagent") {
        source = currentAgent.subagentType || "subagent";
      } else {
        source = currentAgent.tier;
      }
    }

    const configDir = getRootConfigDir();
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    const sharedMemPath = path.join(configDir, "shared-memory.json");
    const lockFile = sharedMemPath + ".lock";

    // Spin-lock acquisition
    let lockAcquired = false;
    let attempts = 0;
    while (attempts < 20) {
      if (signal?.aborted) {
        return "Error: Aborted while waiting for shared memory lock.";
      }
      try {
        fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, time: Date.now() }), { flag: "wx" });
        lockAcquired = true;
        break;
      } catch (err) {
        try {
          if (fs.existsSync(lockFile)) {
            const stat = fs.statSync(lockFile);
            if (Date.now() - stat.mtimeMs > 3000) {
              fs.unlinkSync(lockFile);
            }
          }
        } catch {}
        attempts++;
        await new Promise(r => setTimeout(r, 10 + Math.random() * 20));
      }
    }

    if (!lockAcquired) {
      return "Error: Could not acquire lock to write to shared memory. Please try again.";
    }

    try {
      let memories: SharedMemoryEntry[] = [];
      if (fs.existsSync(sharedMemPath)) {
        try {
          const raw = fs.readFileSync(sharedMemPath, "utf-8");
          memories = JSON.parse(raw);
          if (!Array.isArray(memories)) {
            memories = [];
          }
        } catch {
          memories = [];
        }
      }

      const newEntry: SharedMemoryEntry = {
        key,
        value,
        source,
        timestamp: Date.now(),
        scope,
        projectPath: scope === "project" ? projectPath : undefined,
      };

      // Update only the same logical key within the same scope and canonical project.
      // Reusing a key in another project must not overwrite that project's memory.
      const index = memories.findIndex((m) => {
        if (m.key.toLowerCase() !== key.toLowerCase() || (m.scope || "project") !== scope) return false;
        if (scope === "global") return true;
        if (!m.projectPath) return false; // ambiguous legacy rows are quarantined, not claimed by this project
        return getNormalizedProjectPath(m.projectPath) === projectPath;
      });
      if (index !== -1) {
        memories[index] = { ...memories[index], ...newEntry };
      } else {
        memories.push(newEntry);
      }

      // Compact & Prune: 7-day TTL and 30-entry max limit
      const now = Date.now();
      const TTL = 7 * 24 * 60 * 60 * 1000;
      const validMemories = memories.filter(m => now - m.timestamp < TTL);
      const ttlPruned = memories.filter(m => now - m.timestamp >= TTL);

      let prunedMemories = [...ttlPruned];
      let finalMemories = [...validMemories];

      if (finalMemories.length > 30) {
        // Sort by timestamp ascending (oldest first)
        finalMemories.sort((a, b) => a.timestamp - b.timestamp);
        const toPruneCount = finalMemories.length - 30;
        const extraPruned = finalMemories.slice(0, toPruneCount);
        prunedMemories.push(...extraPruned);
        finalMemories = finalMemories.slice(toPruneCount);
      }

      // Write atomically using a temporary file and rename
      const tempPath = sharedMemPath + ".tmp";
      fs.writeFileSync(tempPath, JSON.stringify(finalMemories, null, 2), "utf-8");
      fs.renameSync(tempPath, sharedMemPath);

      // Sync to RMemory Memory if enabled
      try {
        const { getSettings } = await import("../config.js");
        const settings = getSettings();
        if (settings.enableRmemory) {
          const { getRMemoryClient } = await import("../rmemoryUtil.js");
          const client = getRMemoryClient(500);
          
          const projectId = getRMemoryProjectId(projectPath);
          const scopeTag = scope === "global" ? "[global]" : `[project:${projectId}]`;
          const now = new Date().toISOString();

          // 1. Update/save the new/updated entry with a structured scope.
          await client.updateAtomic({
            id: `shared-memory-${key}`,
            content: `[shared-memory] [${source}] ${scopeTag} ${key}: ${value}`,
            metadata: createMemoryRecordMetadata({
              memoryId: `shared-memory-${key}`,
              memoryType: "shared_memory",
              scope,
              projectId,
              source: "save_shared_memory",
              agentTier: currentAgent?.tier || source,
              sessionId: currentAgent?.sessionId,
              now,
            }),
          });

          // 2. Delete only known, unambiguously scoped pruned entries from RMemory.
          if (prunedMemories.length > 0) {
            const prunedIds = prunedMemories.flatMap((memory) => {
              const id = `shared-memory-${memory.key}`;
              if (memory.scope === "global") return [id];
              if (memory.scope === "project" && memory.projectPath) return [`${getRMemoryProjectId(memory.projectPath)}:${id}`];
              return []; // Do not delete ambiguous legacy entries by a possibly shared physical ID.
            });
            if (prunedIds.length > 0) await client.deleteAtomic({ ids: prunedIds });
          }
        }
      } catch (tdbErr: any) {
        // Log to console/logs but don't fail the command
      }

      return `Successfully saved memory "${key}" (${scope} scope) to shared memory cache.`;
    } catch (err: any) {
      return `Error saving memory: ${err.message}`;
    } finally {
      // Release lock
      try {
        if (fs.existsSync(lockFile)) {
          fs.unlinkSync(lockFile);
        }
      } catch {}
    }
  }
};

export const readSharedMemoryTool: Tool = {
  name: "read_shared_memory",
  description: "Read shared memory entries. Returns entries matching the current project scope or global scope.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Optional search query to filter memory keys or values.",
      },
      scope: {
        type: "string",
        enum: ["all", "project", "global"],
        description: "Scope filter: 'project' (current workspace only), 'global' (global memories only), or 'all' (default).",
      },
    },
  },
  async execute(args, cwd) {
    const filterScope = args.scope === "project" ? "project" : args.scope === "global" ? "global" : "all";
    const query = args.query ? String(args.query).trim().toLowerCase() : "";
    const activeProjectPath = getNormalizedProjectPath(cwd || process.cwd());

    const configDir = getRootConfigDir();
    const sharedMemPath = path.join(configDir, "shared-memory.json");

    if (!fs.existsSync(sharedMemPath)) {
      return "No shared memories found.";
    }

    try {
      const raw = fs.readFileSync(sharedMemPath, "utf-8");
      const memories = JSON.parse(raw) as SharedMemoryEntry[];
      if (!Array.isArray(memories) || memories.length === 0) {
        return "No shared memories stored.";
      }

      const filtered = memories.filter(m => {
        // Global records are explicitly cross-project; project records must bind to a known canonical path.
        if (m.scope === "global") {
          if (filterScope === "project") return false;
        } else {
          if (filterScope === "global") return false;
          if (m.scope !== "project" || !m.projectPath) return false; // quarantine ambiguous legacy project rows
          if (getNormalizedProjectPath(m.projectPath) !== activeProjectPath) return false;
        }

        // Query check
        if (query) {
          const matchKey = m.key.toLowerCase().includes(query);
          const matchVal = m.value.toLowerCase().includes(query);
          if (!matchKey && !matchVal) return false;
        }

        return true;
      });

      if (filtered.length === 0) {
        return "No shared memory entries matched your criteria.";
      }

      return filtered
        .map(m => {
          const scopeLabel = m.scope === "global" ? "[global]" : `[project:${m.projectPath ? path.basename(m.projectPath) : "local"}]`;
          const timeLabel = new Date(m.timestamp).toISOString();
          return `- ${scopeLabel} [${m.source}] ${m.key}: ${m.value} (${timeLabel})`;
        })
        .join("\n");
    } catch (err: any) {
      return `Error reading shared memory: ${err.message}`;
    }
  },
};


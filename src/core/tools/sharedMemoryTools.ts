import fs from "fs";
import path from "path";
import { Tool } from "./types.js";
import { getRootConfigDir } from "../config/paths.js";
import { agentLocalStorage } from "../agent.js";

export const saveSharedMemoryTool: Tool = {
  name: "save_shared_memory",
  description: "Save a key finding, API change, or crucial codebase fact to the global shared memory so other parallel Superagents/Subagents can see it instantly.",
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
    },
    required: ["key", "value"],
  },
  async execute(args, cwd, signal) {
    const key = (args.key as string).trim();
    const value = (args.value as string).trim();
    if (!key || !value) {
      return "Error: key and value cannot be empty.";
    }

    const currentAgent = agentLocalStorage.getStore();
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
        attempts++;
        // Wait a random duration between 50 and 100 ms to resolve collision
        await new Promise(r => setTimeout(r, 50 + Math.random() * 50));
      }
    }

    if (!lockAcquired) {
      return "Error: Could not acquire lock to write to shared memory. Please try again.";
    }

    try {
      let memories: Array<{ key: string; value: string; source: string; timestamp: number }> = [];
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

      // Update existing or add new
      const index = memories.findIndex(m => m.key.toLowerCase() === key.toLowerCase());
      if (index !== -1) {
        memories[index] = { key, value, source, timestamp: Date.now() };
      } else {
        memories.push({ key, value, source, timestamp: Date.now() });
      }

      // Write atomically using a temporary file and rename
      const tempPath = sharedMemPath + ".tmp";
      fs.writeFileSync(tempPath, JSON.stringify(memories, null, 2), "utf-8");
      fs.renameSync(tempPath, sharedMemPath);

      // Sync to TencentDB Memory if enabled
      try {
        const { getSettings } = await import("../config.js");
        const settings = getSettings();
        if (settings.enableTencentdbMemory) {
          const { getTencentDBClient } = await import("../tencentdbUtil.js");
          const client = getTencentDBClient(2000);
          await client.updateAtomic({
            id: `shared-memory-${key}`,
            content: `[${source}] ${key}: ${value}`
          });
        }
      } catch (tdbErr: any) {
        // Log to console/logs but don't fail the command
      }

      return `Successfully saved memory "${key}" to shared memory cache.`;
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

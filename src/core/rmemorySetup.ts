/**
 * rmemorySetup.ts — Auto-detect and run RMemory Gateway on startup.
 *
 * Starts scoped resumable history sync when memory is enabled; it does not
 * clone, install, or initialize a gateway.
 *
 * Called asynchronously during CLI startup.
 */

import { getSettings, getEffectiveMasterModel } from "./config.js";
import { getConfiguredProviders, getTierModelWithProvider } from "./config/providers.js";

import fs from "fs";
import os from "os";
import path from "path";
import { exec, spawn, execSync } from "child_process";
import { promisify } from "util";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Project root: go up from dist/core/ or src/core/ */
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

// Reuse the running Bun executable, including installed Bun on Windows.
const runtimeBun = (): string => process.versions.bun ? process.execPath : "bun";

/**
 * Spawns the RMemory Gateway process completely silently in the background.
 */
export function spawnRmemoryGateway(options: {
  gatewayDir: string;
  globalDataDir: string;
  llmApiKey: string;
  llmBaseUrl: string;
  llmModel: string;
  outLog: number;
  errLog: number;
}): any {
  const env = {
    ...process.env,
    TDAI_DATA_DIR: options.globalDataDir,
    TDAI_LLM_API_KEY: options.llmApiKey,
    TDAI_LLM_BASE_URL: options.llmBaseUrl,
    TDAI_LLM_MODEL: options.llmModel,
    MEMORY_RMEMORY_GATEWAY_PORT: "8420",
  };

  const cmd = runtimeBun();
  const args = ["src/gateway/server.ts"];

  return spawn(cmd, args, {
    cwd: options.gatewayDir,
    detached: true,
    shell: false,
    windowsHide: true,
    stdio: ["ignore", options.outLog, options.errLog],
    env,
  });
}

/**
 * Start an optional detached, lock-protected RMemory history backfill.
 */
export async function runRmemorySetup(): Promise<void> {
  const { getSettings } = await import("./config.js");
  if (getSettings().enableRmemory) {
    try {
      const isTsx = __filename.endsWith(".ts") || __filename.includes("src");
      const entryFile = isTsx
        ? path.join(PROJECT_ROOT, "src", "cli.tsx")
        : path.join(PROJECT_ROOT, "dist", "cli.js");

      const cmd = runtimeBun();
      const args = [entryFile, "--sync-history-only"];

      // Avoid spawning duplicate Bun processes; the child also checks the
      // exclusive lock to cover concurrent parent startup.
      const lockPath = path.join(os.homedir(), ".superagent-r", "rmemory", "history-sync.lock");
      if (fs.existsSync(lockPath)) {
        try {
          const owner = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { pid?: number };
          if (typeof owner.pid !== "number" || owner.pid <= 0) return;
          try { process.kill(owner.pid, 0); return; }
          catch (error: any) { if (error?.code !== "ESRCH") return; }
        } catch {
          // A fresh malformed lock may still be getting written by its owner.
          try { if (Date.now() - fs.statSync(lockPath).mtimeMs < 30 * 60 * 1000) return; }
          catch { return; }
        }
        // An old/dead owner's lock is recovered by the child, not the parent.
      }
      const logDir = path.join(os.homedir(), ".superagent-r", "logs");
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }
      const outLog = fs.openSync(path.join(logDir, "rmemory-sync.log"), "a");
      const errLog = fs.openSync(path.join(logDir, "rmemory-sync.err"), "a");

      const child = spawn(cmd, args, {
        cwd: PROJECT_ROOT,
        detached: true,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", outLog, errLog],
        env: {
          ...process.env,
        },
      });
      child.unref();
      fs.closeSync(outLog);
      fs.closeSync(errLog);
    } catch (err) {
      console.error("Failed to spawn background history sync process:", err);
    }
  }
}


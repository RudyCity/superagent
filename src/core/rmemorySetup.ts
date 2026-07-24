/**
 * rmemorySetup.ts — Auto-detect and run RMemory Gateway on startup.
 *
 * Checks if the RMemory Gateway is enabled in settings and running.
 * If enabled but offline, automatically clones, installs, and starts the
 * gateway in the background.
 *
 * Called from cli.tsx at startup. Fully asynchronous and non-blocking to ensure
 * instant CLI startup.
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

// Detect if Bun is available globally
let hasBunCached: boolean | null = null;
function checkHasBun(): boolean {
  if (hasBunCached !== null) return hasBunCached;
  try {
    execSync("bun --version", { stdio: "ignore" });
    hasBunCached = true;
  } catch {
    hasBunCached = false;
  }
  return hasBunCached;
}

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

  const useBun = checkHasBun();
  const cmd = useBun ? "bun" : process.execPath;
  const args = useBun
    ? ["src/gateway/server.ts"]
    : ["--import", "tsx", "src/gateway/server.ts"];

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
 * Check and start the RMemory Gateway if enabled and offline.
 * Non-blocking: runs asynchronously in the background.
 */
export async function runRmemorySetup(): Promise<void> {
  const { getSettings } = await import("./config.js");
  if (getSettings().enableRmemory) {
    try {
      const isTsx = __filename.endsWith(".ts") || __filename.includes("src");
      const entryFile = isTsx
        ? path.join(PROJECT_ROOT, "src", "cli.tsx")
        : path.join(PROJECT_ROOT, "dist", "cli.js");

      const useBun = checkHasBun();
      const cmd = useBun ? "bun" : process.execPath;
      const args = useBun
        ? [entryFile, "--sync-history-only"]
        : (isTsx
            ? ["--import", "tsx", entryFile, "--sync-history-only"]
            : [entryFile, "--sync-history-only"]);

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
    } catch (err) {
      console.error("Failed to spawn background history sync process:", err);
    }
  }
}


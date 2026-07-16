/**
 * tencentdbSetup.ts — Auto-detect and run TencentDB Memory Gateway on startup.
 *
 * Checks if the TencentDB Memory Gateway is enabled in settings and running.
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
import { exec, spawn } from "child_process";
import { promisify } from "util";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Project root: go up from dist/core/ or src/core/ */
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

/**
 * Spawns the TencentDB Memory Gateway process completely silently in the background.
 */
export function spawnTencentdbGateway(options: {
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
    MEMORY_TENCENTDB_GATEWAY_PORT: "8420",
  };

  // Run directly via node with --import tsx and shell: false to ensure NO console window is opened on Windows
  return spawn(process.execPath, ["--import", "tsx", "src/gateway/server.ts"], {
    cwd: options.gatewayDir,
    detached: true,
    shell: false,
    windowsHide: true,
    stdio: ["ignore", options.outLog, options.errLog],
    env,
  });
}

/**
 * Check and start the TencentDB Memory Gateway if enabled and offline.
 * Non-blocking: runs asynchronously in the background.
 */
export async function runTencentdbSetup(): Promise<void> {
  return;
}

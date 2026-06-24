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
import { MemoryClient } from "@tencentdb-agent-memory/memory-sdk-ts";
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
 * Check and start the TencentDB Memory Gateway if enabled and offline.
 * Non-blocking: runs asynchronously in the background.
 */
export async function runTencentdbSetup(): Promise<void> {
  try {
    const s = getSettings();
    if (!s.enableTencentdbMemory) {
      return;
    }

    const endpoint = s.tencentdbGatewayUrl || "http://127.0.0.1:8420";
    const client = new MemoryClient({
      endpoint,
      apiKey: s.tencentdbGatewayApiKey || "sk-xxxx",
      serviceId: s.tencentdbServiceId || "default",
    });

    // 1. Check if already online (with 1s timeout)
    let online = false;
    try {
      const checkPromise = client.listScenarios({});
      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 1000));
      await Promise.race([checkPromise, timeoutPromise]);
      online = true;
    } catch (err) {
      // offline
    }

    if (online) {
      return;
    }

    // Gateway is offline, let's start it!
    const vendorDir = path.join(PROJECT_ROOT, "vendor");
    const gatewayDir = path.join(vendorDir, "tencentdb-memory");

    // 2. Clone or checkout tag v1.0.0
    let packageJsonVersion = "";
    const gatewayPkgPath = path.join(gatewayDir, "package.json");
    if (fs.existsSync(gatewayPkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(gatewayPkgPath, "utf8"));
        packageJsonVersion = pkg.version;
      } catch (e) {}
    }

    if (!fs.existsSync(gatewayDir) || !fs.existsSync(path.join(gatewayDir, ".git"))) {
      fs.mkdirSync(vendorDir, { recursive: true });
      try {
        const execAsync = promisify(exec);
        await execAsync("git clone -b v1.0.0 https://github.com/TencentCloud/TencentDB-Agent-Memory.git tencentdb-memory", {
          cwd: vendorDir,
        });
      } catch (cloneErr: any) {
        console.warn(`[TencentDB] Failed to clone repository on startup: ${cloneErr.message}`);
        return;
      }
    } else if (packageJsonVersion !== "1.0.0") {
      try {
        const execAsync = promisify(exec);
        await execAsync("git fetch --tags", { cwd: gatewayDir });
        await execAsync("git checkout v1.0.0", { cwd: gatewayDir });
        // Remove node_modules if version changed to force a clean reinstall
        const nodeModulesDir = path.join(gatewayDir, "node_modules");
        if (fs.existsSync(nodeModulesDir)) {
          fs.rmSync(nodeModulesDir, { recursive: true, force: true });
        }
      } catch (checkoutErr: any) {
        console.warn(`[TencentDB] Failed to switch gateway repository to v1.0.0: ${checkoutErr.message}`);
      }
    }

    // 3. Install dependencies if missing
    const nodeModulesDir = path.join(gatewayDir, "node_modules");
    if (!fs.existsSync(nodeModulesDir)) {
      try {
        const execAsync = promisify(exec);
        await execAsync("npm install --no-audit --no-fund --ignore-scripts", {
          cwd: gatewayDir,
        });
      } catch (installErr: any) {
        console.warn(`[TencentDB] Failed to install dependencies on startup: ${installErr.message}`);
        return;
      }
    }

    // 4. Start the gateway in the background
    const globalDataDir = path.join(os.homedir(), ".superagent-r", "tencentdb-memory");
    fs.mkdirSync(globalDataDir, { recursive: true });
    const logDir = path.join(globalDataDir, "logs");
    fs.mkdirSync(logDir, { recursive: true });

    const outLog = fs.openSync(path.join(logDir, "gateway.log"), "a");
    const errLog = fs.openSync(path.join(logDir, "gateway.err"), "a");

    const providers = getConfiguredProviders();
    const isMulti = process.argv.includes("--multi") || process.env.SUPERAGENT_MULTI === "true";
    const modelMode = isMulti ? "multi" : "single";
    
    // Resolve memory-specific tier model/provider from presets, if any
    const resolvedTier = getTierModelWithProvider(modelMode, "memory") || getTierModelWithProvider(modelMode, "tencentdb") || "";
    
    let providerId = "";
    let llmModel = "";
    if (resolvedTier.includes("@")) {
      const atIdx = resolvedTier.indexOf("@");
      providerId = resolvedTier.substring(0, atIdx);
      llmModel = resolvedTier.substring(atIdx + 1);
    } else if (resolvedTier) {
      llmModel = resolvedTier;
    }

    // Resolve active provider profile based on providerId or fallback to active
    let activeProvider = providers.find((p) => p.isActive) || providers[0];
    if (providerId) {
      const specificProvider = providers.find((p) => p.id === providerId);
      if (specificProvider) {
        activeProvider = specificProvider;
      }
    }

    const llmApiKey = activeProvider?.apiKey || "";
    const llmBaseUrl = activeProvider?.baseUrl || "";
    
    if (!llmModel) {
      llmModel = getEffectiveMasterModel("auto") || "gpt-4o";
    }

    const child = spawn("npx", ["tsx", "src/gateway/server.ts"], {
      cwd: gatewayDir,
      detached: true,
      shell: true,
      windowsHide: true,
      stdio: ["ignore", outLog, errLog],
      env: {
        ...process.env,
        TDAI_DATA_DIR: globalDataDir,
        TDAI_LLM_API_KEY: llmApiKey,
        TDAI_LLM_BASE_URL: llmBaseUrl,
        TDAI_LLM_MODEL: llmModel,
        MEMORY_TENCENTDB_GATEWAY_PORT: "8420",
      },
    });
    child.unref();

    // Register as a background process so it shows in the process list
    try {
      const { backgroundTasks, savePersistedTasks, notifyTasksChanged } = await import("./tools/index.js");
      backgroundTasks.set("tencentdb-gateway", {
        id: "tencentdb-gateway",
        command: "npx tsx src/gateway/server.ts (TencentDB Gateway)",
        process: child as any,
        output: [],
        logPath: path.join(globalDataDir, "logs", "gateway.log"),
        hasExited: false,
      });
      savePersistedTasks();
      notifyTasksChanged();

      child.on("close", (code) => {
        const task = backgroundTasks.get("tencentdb-gateway");
        if (task) {
          task.hasExited = true;
          task.exitCode = code ?? undefined;
          savePersistedTasks();
          notifyTasksChanged();
        }
      });
    } catch (importErr) {
      // Ignore background registration errors if tools module is not initialized yet
    }
  } catch (globalErr: any) {
    console.warn(`[TencentDB] Unhandled error during startup setup: ${globalErr.message}`);
  }
}

import { registry } from "./registry.js";
import { getSettings, updateSettings, getContextWindowLimit, getEffectiveMasterModel } from "../config.js";
import { MemoryClient } from "@tencentdb-agent-memory/memory-sdk-ts";
import { getConfiguredProviders, getTierModelWithProvider } from "../config/providers.js";
import fs from "fs";
import os from "os";
import path from "path";
import { exec, spawn } from "child_process";
import { promisify } from "util";
import { fileURLToPath } from "url";
// /settings command — show all settings from JSON config
export const settingsCommand = {
    name: "settings",
    description: "Show current settings (rate limit, concurrency, streaming, etc.)",
    execute(args, ctx) {
        const s = getSettings();
        ctx.addLine({
            type: "system",
            content: [
                "┌───[ ⚙️ SUPERAGENT SETTINGS ]",
                "│ ",
                `│ • Concurrency Limit  : ${s.concurrencyLimit === 1 ? "1 (enabled)" : "0 (disabled)"}`,
                `│ • Rate Limit (RPM)   : ${s.rateLimitRpm === 0 ? "0 (disabled)" : `${s.rateLimitRpm} RPM`}`,
                `│ • Limit Capacity     : ${s.rateLimitCapacity}`,
                `│ • Streaming          : ${s.disableStreaming ? "DISABLED" : "ENABLED"}`,
                `│ • Context Window     : ${s.contextWindowLimit > 0 ? `${s.contextWindowLimit} tokens` : "auto (model default)"}`,
                `│ • Max Iterations     : ${s.maxIterations}`,
                `│ • TencentDB Memory   : ${s.enableTencentdbMemory ? "ENABLED" : "DISABLED"}`,
                `│ • TencentDB Gateway  : ${s.tencentdbGatewayUrl}`,
                "│ ",
                "└─────────────────────────────────",
                "Configure these settings using:",
                "  /setting-concurrency <0|1>",
                "  /setting-rpm <number>",
                "  /setting-capacity <number>",
                "  /setting-streaming <on|off>",
                "  /setting-context-limit <number>",
                "  /setting-max-iterations <number>",
                "  /setting-tencentdb <on|off|status|show-bg-procs> [gatewayUrl]"
            ].join("\n"),
            timestamp: Date.now(),
        });
    }
};
// /setting-concurrency command
export const settingConcurrencyCommand = {
    name: "setting-concurrency",
    description: "Set LLM concurrency limit",
    execute(args, ctx) {
        const val = args.trim();
        const now = Date.now();
        if (!val) {
            ctx.addLine({
                type: "system",
                content: `Usage: /setting-concurrency <0|1>\nCurrent value: ${getSettings().concurrencyLimit === 1 ? "1 (enabled)" : "0 (disabled)"}`,
                timestamp: now,
            });
            return;
        }
        if (val !== "0" && val !== "1") {
            ctx.addLine({
                type: "error",
                content: "Invalid value. Must be 0 (disabled) or 1 (enabled).",
                timestamp: now,
            });
            return;
        }
        try {
            updateSettings({ concurrencyLimit: parseInt(val, 10) });
            ctx.addLine({
                type: "system",
                content: `✓ Concurrency limit set to: ${val === "1" ? "1 (enabled)" : "0 (disabled)"}`,
                timestamp: now,
            });
        }
        catch (err) {
            ctx.addLine({
                type: "error",
                content: `Failed to save setting: ${err.message}`,
                timestamp: now,
            });
        }
    }
};
// /setting-rpm command
export const settingRpmCommand = {
    name: "setting-rpm",
    description: "Set rate limit RPM",
    execute(args, ctx) {
        const val = args.trim();
        const now = Date.now();
        if (!val) {
            ctx.addLine({
                type: "system",
                content: `Usage: /setting-rpm <number>\nCurrent value: ${getSettings().rateLimitRpm}`,
                timestamp: now,
            });
            return;
        }
        const num = parseInt(val, 10);
        if (isNaN(num) || num < 0) {
            ctx.addLine({
                type: "error",
                content: "Invalid value. Must be a non-negative integer.",
                timestamp: now,
            });
            return;
        }
        try {
            updateSettings({ rateLimitRpm: num });
            ctx.addLine({
                type: "system",
                content: `✓ Rate limit set to: ${val === "0" ? "0 (disabled)" : `${val} RPM`}`,
                timestamp: now,
            });
        }
        catch (err) {
            ctx.addLine({
                type: "error",
                content: `Failed to save setting: ${err.message}`,
                timestamp: now,
            });
        }
    }
};
// /setting-capacity command
export const settingCapacityCommand = {
    name: "setting-capacity",
    description: "Set rate limit capacity",
    execute(args, ctx) {
        const val = args.trim();
        const now = Date.now();
        if (!val) {
            ctx.addLine({
                type: "system",
                content: `Usage: /setting-capacity <number>\nCurrent value: ${getSettings().rateLimitCapacity}`,
                timestamp: now,
            });
            return;
        }
        const num = parseInt(val, 10);
        if (isNaN(num) || num <= 0) {
            ctx.addLine({
                type: "error",
                content: "Invalid value. Must be a positive integer.",
                timestamp: now,
            });
            return;
        }
        try {
            updateSettings({ rateLimitCapacity: num });
            ctx.addLine({
                type: "system",
                content: `✓ Rate limit capacity set to: ${val}`,
                timestamp: now,
            });
        }
        catch (err) {
            ctx.addLine({
                type: "error",
                content: `Failed to save setting: ${err.message}`,
                timestamp: now,
            });
        }
    }
};
// /setting-streaming command
export const settingStreamingCommand = {
    name: "setting-streaming",
    description: "Enable or disable streaming",
    execute(args, ctx) {
        const val = args.trim().toLowerCase();
        const now = Date.now();
        if (!val) {
            ctx.addLine({
                type: "system",
                content: `Usage: /setting-streaming <on|off>\nCurrent value: ${getSettings().disableStreaming ? "DISABLED" : "ENABLED"}`,
                timestamp: now,
            });
            return;
        }
        if (val !== "on" && val !== "off" && val !== "true" && val !== "false" && val !== "enable" && val !== "disable") {
            ctx.addLine({
                type: "error",
                content: "Invalid value. Use 'on' or 'off'.",
                timestamp: now,
            });
            return;
        }
        const disabled = val === "off" || val === "false" || val === "disable";
        try {
            updateSettings({ disableStreaming: disabled });
            ctx.addLine({
                type: "system",
                content: `✓ Streaming set to: ${disabled ? "DISABLED" : "ENABLED"}`,
                timestamp: now,
            });
        }
        catch (err) {
            ctx.addLine({
                type: "error",
                content: `Failed to save setting: ${err.message}`,
                timestamp: now,
            });
        }
    }
};
// /setting-context-limit command
export const settingContextLimitCommand = {
    name: "setting-context-limit",
    description: "Set custom context window limit (0 = auto)",
    execute(args, ctx) {
        const val = args.trim();
        const now = Date.now();
        if (!val) {
            const current = getSettings().contextWindowLimit;
            ctx.addLine({
                type: "system",
                content: `Usage: /setting-context-limit <number> (0 = auto/model default)\nCurrent value: ${current > 0 ? `${current} tokens` : "auto"}`,
                timestamp: now,
            });
            return;
        }
        const num = parseInt(val, 10);
        if (isNaN(num) || num < 0) {
            ctx.addLine({
                type: "error",
                content: "Invalid value. Must be a non-negative integer (0 = auto).",
                timestamp: now,
            });
            return;
        }
        try {
            updateSettings({ contextWindowLimit: num });
            // Refresh ContextManager if it exists
            const cm = ctx.agent?.getContextManager?.();
            if (cm) {
                if (num > 0) {
                    cm.setThreshold(num);
                }
                else {
                    // Auto mode - reset to model default
                    const currentModel = getEffectiveMasterModel("auto") || "gpt-4o";
                    const modelLimit = getContextWindowLimit(currentModel);
                    cm.setThreshold(modelLimit);
                }
                ctx.addLine({
                    type: "system",
                    content: `✓ Context window limit set to: ${num > 0 ? `${num} tokens` : "auto (model default)"}\n  ContextManager threshold updated.`,
                    timestamp: now,
                });
            }
            else {
                ctx.addLine({
                    type: "system",
                    content: `✓ Context window limit set to: ${num > 0 ? `${num} tokens` : "auto (model default)"}`,
                    timestamp: now,
                });
            }
            // Update UI context limit display
            if (ctx.setContextLimit) {
                ctx.setContextLimit(num > 0 ? num : 256000);
            }
        }
        catch (err) {
            ctx.addLine({
                type: "error",
                content: `Failed to save setting: ${err.message}`,
                timestamp: now,
            });
        }
    }
};
// /setting-max-iterations command
export const settingMaxIterationsCommand = {
    name: "setting-max-iterations",
    description: "Set max agent loop iterations",
    execute(args, ctx) {
        const val = args.trim();
        const now = Date.now();
        if (!val) {
            ctx.addLine({
                type: "system",
                content: `Usage: /setting-max-iterations <number>\nCurrent value: ${getSettings().maxIterations}`,
                timestamp: now,
            });
            return;
        }
        const num = parseInt(val, 10);
        if (isNaN(num) || num < 1) {
            ctx.addLine({
                type: "error",
                content: "Invalid value. Must be a positive integer (minimum 1).",
                timestamp: now,
            });
            return;
        }
        try {
            updateSettings({ maxIterations: num });
            ctx.addLine({
                type: "system",
                content: `✓ Max iterations set to: ${num}`,
                timestamp: now,
            });
        }
        catch (err) {
            ctx.addLine({
                type: "error",
                content: `Failed to save setting: ${err.message}`,
                timestamp: now,
            });
        }
    }
};
// /setting-tencentdb command
export const settingTencentdbCommand = {
    name: "setting-tencentdb",
    description: "Configure TencentDB memory strategy and gateway URL",
    async execute(args, ctx) {
        const now = Date.now();
        const parts = args.trim().split(/\s+/);
        const mode = parts[0]?.toLowerCase();
        const url = parts[1];
        // --- status subcommand: live connection health check ---
        if (mode === "status") {
            const s = getSettings();
            const endpoint = s.tencentdbGatewayUrl || "http://127.0.0.1:8420";
            const configState = s.enableTencentdbMemory ? "on (ENABLED)" : "off (DISABLED)";
            ctx.addLine({
                type: "system",
                content: [
                    "┌───[ 🧠 TENCENTDB MEMORY STATUS ]",
                    `│ • Config State  : ${configState}`,
                    `│ • Gateway URL   : ${endpoint}`,
                    "│ • Connectivity  : checking...",
                    "└─────────────────────────────────",
                ].join("\n"),
                timestamp: now,
            });
            const client = new MemoryClient({
                endpoint,
                apiKey: s.tencentdbGatewayApiKey || "sk-xxxx",
                serviceId: s.tencentdbServiceId || "default",
            });
            const pingStart = Date.now();
            let online = false;
            let latencyMs = 0;
            let errorMsg = "";
            try {
                const checkPromise = client.listScenarios({});
                const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("Connection timed out after 3s")), 3000));
                await Promise.race([checkPromise, timeoutPromise]);
                latencyMs = Date.now() - pingStart;
                online = true;
            }
            catch (err) {
                latencyMs = Date.now() - pingStart;
                errorMsg = err?.message || "Unknown error";
            }
            const globalDataDir = path.join(os.homedir(), ".superagent-r", "tencentdb-memory");
            const dbPath = path.join(globalDataDir, "vectors.db");
            const dbExists = fs.existsSync(dbPath);
            if (online) {
                ctx.addLine({
                    type: "system",
                    content: [
                        "┌───[ 🧠 TENCENTDB MEMORY STATUS ]",
                        `│ • Config State  : ${configState}`,
                        `│ • Gateway URL   : ${endpoint}`,
                        `│ • Connectivity  : ✅ ONLINE (${latencyMs}ms)`,
                        `│ • Vector DB     : ${dbExists ? `✅ exists  (~/.superagent-r/tencentdb-memory/vectors.db)` : "⚠️  not found yet"}`,
                        "└─────────────────────────────────",
                    ].join("\n"),
                    timestamp: Date.now(),
                });
            }
            else {
                ctx.addLine({
                    type: "system",
                    content: [
                        "┌───[ 🧠 TENCENTDB MEMORY STATUS ]",
                        `│ • Config State  : ${configState}`,
                        `│ • Gateway URL   : ${endpoint}`,
                        `│ • Connectivity  : ❌ OFFLINE — ${errorMsg}`,
                        `│ • Hint          : Run /setting-tencentdb on to start the gateway`,
                        "└─────────────────────────────────",
                    ].join("\n"),
                    timestamp: Date.now(),
                });
            }
            return;
        }
        if (mode === "show-bg-procs") {
            const { backgroundTasks } = await import("../tools/index.js");
            const task = backgroundTasks.get("tencentdb-gateway");
            if (!task) {
                ctx.addLine({
                    type: "system",
                    content: [
                        "┌───[ 🧠 TENCENTDB BG PROCESS ]",
                        "│ • Status      : NOT SPAWNED (no background task entry)",
                        "└─────────────────────────────────",
                    ].join("\n"),
                    timestamp: now,
                });
                return;
            }
            const isAlive = !task.hasExited;
            const pid = task.process?.pid || "unknown";
            const logPath = task.logPath || "unknown";
            let tailLines = [];
            if (logPath && fs.existsSync(logPath)) {
                try {
                    const logs = fs.readFileSync(logPath, "utf-8");
                    tailLines = logs.split("\n").filter(Boolean).slice(-10);
                }
                catch { }
            }
            ctx.addLine({
                type: "system",
                content: [
                    "┌───[ 🧠 TENCENTDB BG PROCESS ]",
                    `│ • ID          : ${task.id}`,
                    `│ • Status      : ${isAlive ? "✅ RUNNING" : "❌ EXITED"}`,
                    `│ • PID         : ${pid}`,
                    `│ • Log Path    : ${logPath}`,
                    `│ • Command     : ${task.command}`,
                    "│",
                    "│ • Recent Output Logs (last 10 lines):",
                    ...tailLines.map(line => `│   ${line}`),
                    "└─────────────────────────────────",
                ].join("\n"),
                timestamp: now,
            });
            return;
        }
        if (!mode || (mode !== "on" && mode !== "off" && mode !== "status" && mode !== "show-bg-procs")) {
            const s = getSettings();
            ctx.addLine({
                type: "system",
                content: [
                    "Usage: /setting-tencentdb <on|off|status|show-bg-procs> [gatewayUrl]",
                    `Current value: ${s.enableTencentdbMemory ? "on (ENABLED)" : "off (DISABLED)"}`,
                    `Gateway URL  : ${s.tencentdbGatewayUrl}`,
                    "",
                    "  on [url]       — enable TencentDB memory (auto-starts gateway)",
                    "  off            — disable TencentDB memory and stop local gateway",
                    "  status         — live connectivity check to the gateway",
                    "  show-bg-procs  — show the background gateway process details and logs",
                ].join("\n"),
                timestamp: now,
            });
            return;
        }
        try {
            const updates = {
                enableTencentdbMemory: mode === "on",
            };
            if (url) {
                updates.tencentdbGatewayUrl = url;
            }
            updateSettings(updates);
            let msg = `✓ TencentDB memory strategy set to: ${mode === "on" ? "on (ENABLED)" : "off (DISABLED)"}`;
            if (url) {
                msg += `\n✓ Gateway URL set to: ${url}`;
            }
            if (mode === "on") {
                const s = getSettings();
                const endpoint = url || s.tencentdbGatewayUrl || "http://127.0.0.1:8420";
                const client = new MemoryClient({
                    endpoint,
                    apiKey: s.tencentdbGatewayApiKey || "sk-xxxx",
                    serviceId: s.tencentdbServiceId || "default",
                });
                ctx.addLine({
                    type: "system",
                    content: `${msg}\n⚡ Verifying connection to TencentDB Memory Gateway...`,
                    timestamp: now,
                });
                let online = false;
                try {
                    const checkPromise = client.listScenarios({});
                    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 1000));
                    await Promise.race([checkPromise, timeoutPromise]);
                    online = true;
                }
                catch (err) {
                    // gateway is offline
                }
                if (online) {
                    ctx.addLine({
                        type: "system",
                        content: `✓ Connection established! Gateway is online at ${endpoint}.`,
                        timestamp: Date.now(),
                    });
                }
                else {
                    ctx.addLine({
                        type: "system",
                        content: `⚠️ Gateway is offline at ${endpoint}. Initiating automatic local setup...`,
                        timestamp: Date.now(),
                    });
                    const __filename = fileURLToPath(import.meta.url);
                    const __dirname = path.dirname(__filename);
                    const projectRoot = path.resolve(__dirname, "..", "..", "..");
                    const vendorDir = path.join(projectRoot, "vendor");
                    const gatewayDir = path.join(vendorDir, "tencentdb-memory");
                    // 1. Clone only if directory does not exist yet (avoid re-cloning an existing repo)
                    if (!fs.existsSync(gatewayDir) || !fs.existsSync(path.join(gatewayDir, ".git"))) {
                        ctx.addLine({
                            type: "system",
                            content: `⚡ Cloning TencentDB Memory Gateway into vendor/tencentdb-memory...`,
                            timestamp: Date.now(),
                        });
                        fs.mkdirSync(vendorDir, { recursive: true });
                        try {
                            const execAsync = promisify(exec);
                            await execAsync("git clone https://github.com/TencentCloud/TencentDB-Agent-Memory.git tencentdb-memory", {
                                cwd: vendorDir,
                            });
                            ctx.addLine({
                                type: "system",
                                content: `✓ Repository successfully cloned.`,
                                timestamp: Date.now(),
                            });
                        }
                        catch (cloneErr) {
                            ctx.addLine({
                                type: "error",
                                content: `Failed to clone repository: ${cloneErr.message}`,
                                timestamp: Date.now(),
                            });
                            return;
                        }
                    }
                    // 2. Install dependencies if node_modules not exists
                    const nodeModulesDir = path.join(gatewayDir, "node_modules");
                    if (!fs.existsSync(nodeModulesDir)) {
                        ctx.addLine({
                            type: "system",
                            content: `⚡ Installing gateway dependencies (npm install)...`,
                            timestamp: Date.now(),
                        });
                        try {
                            const execAsync = promisify(exec);
                            await execAsync("npm install --no-audit --no-fund --ignore-scripts", {
                                cwd: gatewayDir,
                            });
                            ctx.addLine({
                                type: "system",
                                content: `✓ Dependencies successfully installed.`,
                                timestamp: Date.now(),
                            });
                        }
                        catch (installErr) {
                            ctx.addLine({
                                type: "error",
                                content: `Failed to install dependencies: ${installErr.message}`,
                                timestamp: Date.now(),
                            });
                            return;
                        }
                    }
                    // 3. Start the gateway in the background
                    ctx.addLine({
                        type: "system",
                        content: `⚡ Starting TencentDB Memory Gateway in the background...`,
                        timestamp: Date.now(),
                    });
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
                    }
                    else if (resolvedTier) {
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
                    try {
                        const child = spawn("npx", ["tsx", "src/gateway/server.ts"], {
                            cwd: gatewayDir,
                            detached: true,
                            shell: true,
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
                        const { backgroundTasks, savePersistedTasks, notifyTasksChanged } = await import("../tools/index.js");
                        backgroundTasks.set("tencentdb-gateway", {
                            id: "tencentdb-gateway",
                            command: "npx tsx src/gateway/server.ts (TencentDB Gateway)",
                            process: child,
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
                        ctx.addLine({
                            type: "system",
                            content: `⚡ Waiting for gateway to initialize...`,
                            timestamp: Date.now(),
                        });
                        // Wait 3 seconds and verify connection
                        await new Promise((resolve) => setTimeout(resolve, 3000));
                        let verifyOnline = false;
                        try {
                            const checkPromise = client.listScenarios({});
                            const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 2000));
                            await Promise.race([checkPromise, timeoutPromise]);
                            verifyOnline = true;
                        }
                        catch (err) {
                            // still offline
                        }
                        if (verifyOnline) {
                            ctx.addLine({
                                type: "system",
                                content: `✓ TencentDB Memory Gateway successfully started and connected!\n  Database path: ~/.superagent-r/tencentdb-memory/vectors.db`,
                                timestamp: Date.now(),
                            });
                        }
                        else {
                            ctx.addLine({
                                type: "system",
                                content: `⚠️ Gateway process started in the background, but verification timed out.\n  Check error logs at: ~/.superagent-r/tencentdb-memory/logs/gateway.err`,
                                timestamp: Date.now(),
                            });
                        }
                    }
                    catch (spawnErr) {
                        ctx.addLine({
                            type: "error",
                            content: `Failed to start gateway process: ${spawnErr.message}`,
                            timestamp: Date.now(),
                        });
                    }
                }
            }
            else {
                ctx.addLine({
                    type: "system",
                    content: msg,
                    timestamp: now,
                });
                // Kill the process on port 8420 to clean up
                try {
                    const execAsync = promisify(exec);
                    if (process.platform === "win32") {
                        await execAsync(`powershell -NoProfile -Command "Get-Process -Id (Get-NetTCPConnection -LocalPort 8420 -ErrorAction SilentlyContinue).OwningProcess -ErrorAction SilentlyContinue | Stop-Process -Force"`);
                    }
                    else {
                        await execAsync("lsof -t -i:8420 | xargs kill -9 2>/dev/null || true");
                    }
                    const { backgroundTasks, savePersistedTasks, notifyTasksChanged } = await import("../tools/index.js");
                    const task = backgroundTasks.get("tencentdb-gateway");
                    if (task) {
                        task.hasExited = true;
                        task.exitCode = 9;
                        savePersistedTasks();
                        notifyTasksChanged();
                    }
                    ctx.addLine({
                        type: "system",
                        content: `✓ Stopped local TencentDB Memory Gateway server on port 8420.`,
                        timestamp: Date.now(),
                    });
                }
                catch (err) {
                    // ignore error if port already free
                }
            }
        }
        catch (err) {
            ctx.addLine({
                type: "error",
                content: `Failed to save setting: ${err.message}`,
                timestamp: now,
            });
        }
    }
};
registry.register(settingsCommand);
registry.register(settingConcurrencyCommand);
registry.register(settingRpmCommand);
registry.register(settingCapacityCommand);
registry.register(settingStreamingCommand);
registry.register(settingContextLimitCommand);
registry.register(settingMaxIterationsCommand);
registry.register(settingTencentdbCommand);
//# sourceMappingURL=settingsCommand.js.map
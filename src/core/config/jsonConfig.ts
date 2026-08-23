import fs from "fs";
import path from "path";
import { execa } from "execa";
import { threadId } from "worker_threads";
import { getModelConfigPath, ensureGlobalConfigDir, getRootConfigDir, ensureProtocol, getWorkspaceId } from "./paths.js";
import { saveWorkspaceToDb, getWorkspacesFromDb, getWorkspaceFromDb, deleteWorkspaceFromDb } from "../storage/historyDb.js";

export interface ProviderProfile {
  id: string;
  name: string;
  provider: string; // e.g. 'openai', 'anthropic', 'openrouter', 'custom'
  apiKey: string;
  baseUrl?: string;
}

export interface TierModelConfig {
  providerProfileId: string;
  model: string;
  supportsVision?: boolean;
}

export interface PresetModelsMulti {
  master: TierModelConfig;
  superagent: TierModelConfig;
  subagentDefault: TierModelConfig;
  subagentDetails: Record<string, TierModelConfig>;
}

export interface PresetModelsSingle {
  superagent: TierModelConfig;
  subagentDefault: TierModelConfig;
  subagentDetails: Record<string, TierModelConfig>;
}

export interface JSONModelPreset<T> {
  id: string;
  name: string;
  description: string;
  models: T;
}

export interface SystemSettings {
  concurrencyLimit: number;
  rateLimitRpm: number;
  rateLimitCapacity: number;
  disableStreaming: boolean;
  contextWindowLimit: number;
  /** Estimated token budget reserved for optional skills, memories, and runtime context. */
  promptContextBudget?: number;
  maxIterations: number;
  simpleTaskFileThreshold?: number;
  simpleTaskKeywords?: string[];
  /** Enable multi-category request classifier for token optimization (default: true) */
  classifierEnabled?: boolean;
  /** Minimum heuristic confidence to skip LLM classification phase (default: "high") */
  classifierConfidenceThreshold?: "high" | "medium" | "low";
  /** Custom keyword overrides per request category */
  classifierKeywords?: Record<string, string[]>;
  rmemoryGatewayUrl?: string;
  rmemoryGatewayApiKey?: string;
  rmemoryServiceId?: string;
  enableRmemory?: boolean;
  rmemoryPollIntervalMs?: number;
  rmemoryEmbeddingProvider?: "local" | "openai";
  rmemoryEmbeddingModel?: string;
  rmemoryEmbeddingDimensions?: number;
  maxChecklistVisible?: number;
  maxHistoryVisible?: number;
  maxProcsVisible?: number;
  forcePromptBasedToolCalling?: boolean;
  hideTimeline?: boolean;
  enableAdvisor?: boolean;
  advisorWarningThreshold?: number;
  advisorPauseThreshold?: number;
  advisorErrorThreshold?: number;
  advisorAdaptiveScaling?: boolean;
  advisorPatternMemory?: boolean;
  /** Log level for prompt logging: off | metadata (no messages) | full (all content) */
  promptLogLevel?: "off" | "metadata" | "full";
}

export interface McpServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface GlobalModelConfig {
  providers: ProviderProfile[];
  presets: {
    multi: JSONModelPreset<PresetModelsMulti>[];
    single: JSONModelPreset<PresetModelsSingle>[];
  };
  activePresetId: {
    multi: string;
    single: string;
  };
  settings?: SystemSettings;
  trustedDirectories?: string[];
  activeHooks?: Record<string, string[]>;
  mcpServers?: Record<string, McpServerConfig>;
}


const DEFAULT_CONFIG: GlobalModelConfig = {
  settings: {
    concurrencyLimit: 0,
    rateLimitRpm: 60,
    rateLimitCapacity: 60,
    disableStreaming: false,
    contextWindowLimit: 0,
    promptContextBudget: 8000,
    maxIterations: 0,
    simpleTaskFileThreshold: 3,
    simpleTaskKeywords: ['lanjut', 'coba', 'go ahead', 'proceed', 'try', 'run', 'execute', 'ok', 'yes', 'y'],
    maxChecklistVisible: 3,
    maxHistoryVisible: 3,
    maxProcsVisible: 3,
    forcePromptBasedToolCalling: false,
    enableRmemory: false,
    rmemoryEmbeddingProvider: "local",
    rmemoryEmbeddingModel: "Xenova/all-MiniLM-L6-v2",
    rmemoryEmbeddingDimensions: 384,
    enableAdvisor: true,
    advisorWarningThreshold: 3,
    advisorPauseThreshold: 5,
    advisorErrorThreshold: 5,
    advisorAdaptiveScaling: true,
    advisorPatternMemory: true,
  },
  trustedDirectories: [],
  providers: [
    {
      id: "default-anthropic",
      name: "Default Anthropic",
      provider: "anthropic",
      apiKey: "",
      baseUrl: "",
    },
    {
      id: "default-openai",
      name: "Default OpenAI",
      provider: "openai",
      apiKey: "",
      baseUrl: "",
    }
  ],
  presets: {
    multi: [
      {
        id: "default-multi",
        name: "Default Multi-Agent Setup",
        description: "Standard configuration using Claude Sonnet and GPT-4o-mini",
        models: {
          master: {
            providerProfileId: "default-anthropic",
            model: "claude-3-5-sonnet-20241022",
          },
          superagent: {
            providerProfileId: "default-anthropic",
            model: "claude-3-5-sonnet-20241022",
          },
          subagentDefault: {
            providerProfileId: "default-openai",
            model: "gpt-4o-mini",
          },
          subagentDetails: {},
        },
      },
    ],
    single: [
      {
        id: "default-single",
        name: "Default Single-Agent Setup",
        description: "Standard single-agent setup using Claude Sonnet and GPT-4o-mini",
        models: {
          superagent: {
            providerProfileId: "default-anthropic",
            model: "claude-3-5-sonnet-20241022",
          },
          subagentDefault: {
            providerProfileId: "default-openai",
            model: "gpt-4o-mini",
          },
          subagentDetails: {},
        },
      },
    ],
  },
  activePresetId: {
    multi: "default-multi",
    single: "default-single",
  },
};

let cachedConfig: GlobalModelConfig | null = null;
// Modification time (ms) of the file that produced `cachedConfig`. Used to detect
// out-of-band writes (a second process / terminal / spawned agent) so we don't keep
// serving — and worse, re-saving — a stale in-memory snapshot that is missing
// providers another process added. -1 means "unknown".
let cachedConfigMtimeMs = -1;
let lastStatCheckTime = 0;

let sessionActivePreset: {
  multi?: JSONModelPreset<PresetModelsMulti>;
  single?: JSONModelPreset<PresetModelsSingle>;
} = {};

function safeMtimeMs(p: string): number {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return -1;
  }
}

let localLockCount = 0;

function getLockPath(configPath: string): string {
  const isVitest = typeof process.env.VITEST !== "undefined";
  const useLockSuffix = isVitest && !process.env.SUPERAGENT_TEST_NO_LOCK_SUFFIX;
  return configPath + ".lock" + (useLockSuffix ? `-${threadId}-${process.pid}` : "");
}

function sleepSync(ms: number): void {
  try {
    const sab = new SharedArrayBuffer(4);
    const int32 = new Int32Array(sab);
    Atomics.wait(int32, 0, 0, ms);
  } catch (e) {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* busy wait fallback */ }
  }
}

function acquireLockSync(lockPath: string, timeoutMs: number = 5000): boolean {
  if (localLockCount > 0) {
    localLockCount++;
    return true;
  }

  const start = Date.now();
  const lockTTL = 5000; // 5 seconds
  let attempt = 0;

  while (Date.now() - start < timeoutMs) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      fs.writeFileSync(fd, `${process.pid}:${threadId}:${Date.now()}`);
      fs.closeSync(fd);
      localLockCount = 1;
      return true;
    } catch (err: any) {
      if (err.code === "ENOENT") {
        try {
          fs.mkdirSync(path.dirname(lockPath), { recursive: true });
          continue; // Retry immediately after directory creation
        } catch {}
      }
      if (err.code === "EEXIST") {
        try {
          const content = fs.readFileSync(lockPath, "utf-8").trim();
          const parts = content.split(":");
          const lockPid = parseInt(parts[0], 10);
          const lockThreadId = parseInt(parts[1], 10);
          const lockTime = parseInt(parts[2], 10);

          if (!isNaN(lockPid) && !isNaN(lockThreadId) && lockPid === process.pid && lockThreadId === threadId) {
            localLockCount = 1;
            return true;
          }

          let isStale = isNaN(lockTime) || isNaN(lockPid) || isNaN(lockThreadId) || (Date.now() - lockTime) > lockTTL;

          if (!isStale && !isNaN(lockPid) && lockPid !== process.pid) {
            try {
              process.kill(lockPid, 0);
            } catch (e: any) {
              if (e.code === "ESRCH") {
                isStale = true; // Clean up locks held by dead/exited processes instantly
              }
            }
          }

          if (isStale) {
            try {
              fs.unlinkSync(lockPath);
            } catch {}
            // Retry immediately
            continue;
          }
        } catch {
          // stats/read failed, maybe lock deleted or being written
        }
      }

      const delay = Math.min(50 + attempt * 20 + Math.random() * 20, 150);
      if (err.code !== "EEXIST") {
        console.error(`[LOCK DEBUG] Failed to acquire lock at ${lockPath}: ${err.code} - ${err.message}`);
      }
      sleepSync(delay);
      attempt++;
    }
  }

  try {
    const content = fs.existsSync(lockPath) ? fs.readFileSync(lockPath, "utf-8").trim() : "(does not exist)";
    console.error(`[LOCK TIMEOUT DIAGNOSTICS] lockPath: ${lockPath} | currentPid: ${process.pid} | currentThreadId: ${threadId} | localLockCount: ${localLockCount} | lockFileContent: ${content}`);
  } catch (diagErr: any) {
    console.error(`[LOCK TIMEOUT DIAGNOSTICS ERR] failed to read diagnostics: ${diagErr.message}`);
  }

  return false;
}

function releaseLockSync(lockPath: string): void {
  if (localLockCount > 1) {
    localLockCount--;
    return;
  }
  localLockCount = 0;
  try {
    if (fs.existsSync(lockPath)) {
      fs.unlinkSync(lockPath);
    }
  } catch {
    // Ignore errors on release
  }
}

export function clearModelConfigCache(): void {
  cachedConfig = null;
  cachedConfigMtimeMs = -1;
}

export function loadModelConfig(): GlobalModelConfig {
  const configPath = getModelConfigPath();
  if (cachedConfig) {
    // Throttle disk stats: if checked less than 50ms ago, use cache directly
    const isTest = typeof process.env.VITEST !== "undefined" || typeof process.env.BUN_TEST !== "undefined" || process.env.NODE_ENV === "test";
    const now = Date.now();
    if (!isTest && now - lastStatCheckTime < 50) {
      return cachedConfig;
    }
    lastStatCheckTime = now;
    // Serve the cache only if the file on disk hasn't changed since we cached it.
    // If another process rewrote model-config.json, fall through and reload so we
    // pick up providers/presets we don't know about yet.
    const diskMtime = safeMtimeMs(configPath);
    if (diskMtime === -1 || diskMtime === cachedConfigMtimeMs) {
      return cachedConfig;
    }
  }

  ensureGlobalConfigDir();
  const lockPath = getLockPath(configPath);
  const hasLock = acquireLockSync(lockPath);
  if (!hasLock) {
    console.warn(`[WARNING] Could not acquire lock to read model-config.json, proceeding without lock`);
  }

  try {
    let lastError: any = null;
    const maxLoadAttempts = 5;
    for (let attempt = 0; attempt < maxLoadAttempts; attempt++) {
      try {
        if (fs.existsSync(configPath)) {
          const rawData = fs.readFileSync(configPath, "utf-8");
          const data = rawData.replace(/^\uFEFF/, "");
          if (!data || data.trim() === "") {
            throw new Error("Config file is empty or blank");
          }
          const parsed = JSON.parse(data);
          // Basic migrations/fallback validation
          if (!parsed?.providers) {
            // File exists but the providers field is missing/invalid. Back up before touching it.
            try {
              const backupPath = configPath + ".corrupt-" + Date.now();
              fs.copyFileSync(configPath, backupPath);
              console.warn(`model-config.json had invalid providers field. Backed up to: ${backupPath}`);
            } catch {}
            // Try to recover real providers (with their API keys) from the newest backup
            // that still has them, so we don't silently destroy the user's credentials.
            const recoveredProviders = recoverProvidersFromBackups(configPath);
            const fallbackConfig: GlobalModelConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
            if (recoveredProviders && recoveredProviders.length > 0) {
              fallbackConfig.providers = recoveredProviders;
              console.warn(`[WARNING] model-config.json providers were invalid. Recovered ${recoveredProviders.length} provider profile(s) from a backup.`);
            } else {
              console.warn(`[WARNING] model-config.json providers were invalid and no backup with providers was found. Reset to defaults. Re-add credentials with /login.`);
            }
            if (parsed?.presets) {
              fallbackConfig.presets = parsed.presets;
            }
            if (parsed?.activePresetId) {
              fallbackConfig.activePresetId = parsed.activePresetId;
            }
            if (parsed?.settings) {
              fallbackConfig.settings = parsed.settings;
            }
            cachedConfig = fallbackConfig;
            // saveModelConfig refreshes cachedConfigMtimeMs after writing.
            saveModelConfig(fallbackConfig);
          } else {
            // Validate and repair missing presets / activePresetId (e.g. from older app versions)
            if (!parsed.presets || !parsed.presets.multi || !parsed.presets.single) {
              parsed.presets = JSON.parse(JSON.stringify(DEFAULT_CONFIG.presets));
            }
            if (!parsed.activePresetId || !parsed.activePresetId.multi || !parsed.activePresetId.single) {
              parsed.activePresetId = JSON.parse(JSON.stringify(DEFAULT_CONFIG.activePresetId));
            }

            // Repair stale providerProfileIds: if a preset references a non-existent provider,
            // replace it with a valid provider that has an API key (or the first provider).
            const providerIds = new Set((parsed.providers || []).map((p: any) => p.id));
            const firstProviderWithKey = (parsed.providers || []).find(
              (p: any) => p.apiKey && p.apiKey.trim() !== ""
            );
            const fallbackProviderId = firstProviderWithKey?.id || parsed.providers?.[0]?.id || "";

            if (fallbackProviderId) {
              let repaired = false;
              for (const mode of ["multi", "single"] as const) {
                const presetsList = parsed.presets?.[mode] as any[] | undefined;
                if (!presetsList) continue;
                for (const preset of presetsList) {
                  if (!preset?.models) continue;
                  const models = preset.models;
                  const tierKeys = ["master", "superagent", "subagentDefault"];
                  for (const key of tierKeys) {
                    if (models[key]?.providerProfileId && !providerIds.has(models[key].providerProfileId)) {
                      models[key].providerProfileId = fallbackProviderId;
                      repaired = true;
                    }
                  }
                  if (models.subagentDetails) {
                    for (const subKey of Object.keys(models.subagentDetails)) {
                      if (models.subagentDetails[subKey]?.providerProfileId && !providerIds.has(models.subagentDetails[subKey].providerProfileId)) {
                        models.subagentDetails[subKey].providerProfileId = fallbackProviderId;
                        repaired = true;
                      }
                    }
                  }
                }
              }
              if (repaired) {
                try {
                  writeConfigAtomically(configPath, parsed);
                } catch {
                  // Ignore repair write errors
                }
              }
            }

            cachedConfig = parsed;
            cachedConfigMtimeMs = safeMtimeMs(configPath);

            // Repair provider baseUrls missing protocol prefix (e.g. "ai.genzx.id/v1" → "https://ai.genzx.id/v1")
            let baseUrlRepaired = false;
            for (const p of (parsed.providers || [])) {
              if (p.baseUrl && typeof p.baseUrl === "string" && p.baseUrl.trim() !== "") {
                const normalized = ensureProtocol(p.baseUrl);
                if (normalized !== p.baseUrl) {
                  p.baseUrl = normalized;
                  baseUrlRepaired = true;
                }
              }
            }
            if (baseUrlRepaired) {
              try {
                writeConfigAtomically(configPath, parsed);
                cachedConfigMtimeMs = safeMtimeMs(configPath);
              } catch {
                // Ignore repair write errors
              }
            }
          }
          return cachedConfig!;
        } else {
          // File doesn't exist yet. Since we successfully acquired the lock and it's not
          // being written by another process, it simply doesn't exist. Break early to
          // avoid unnecessary sleep/retry delay loops.
          break;
        }
      } catch (error: any) {
        lastError = error;
        if (attempt < maxLoadAttempts - 1) {
          // Wait and retry
          const waitMs = (attempt + 1) * 50;
          sleepSync(waitMs);
          continue;
        }
      }
    }

    if (lastError) {
      console.error("Error reading model-config.json after retries:", lastError);
    }

    const fileExists = fs.existsSync(configPath);

    // Back up the corrupted file before overwriting with defaults
    if (fileExists) {
      try {
        const backupPath = configPath + ".corrupt-" + Date.now();
        fs.copyFileSync(configPath, backupPath);
        console.warn(`model-config.json was corrupted. Backed up to: ${backupPath}`);
      } catch {}
    }

    // Attempt config-level recovery from backups
    const recoveredConfig = recoverConfigFromBackups(configPath);
    if (recoveredConfig) {
      console.warn(`[WARNING] model-config.json recovered from a backup.`);
      cachedConfig = recoveredConfig;
      if (!fileExists) {
        saveModelConfig(recoveredConfig);
      }
      return cachedConfig;
    }

    // Fallback to default — do NOT set cachedConfig until save succeeds
    const defaultConfig: GlobalModelConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    if (!fileExists) {
      const saveResult = saveModelConfig(defaultConfig);
      if (saveResult) {
        cachedConfig = defaultConfig;
      } else {
        // Save failed (e.g. directory creation failed). Set cache anyway so the app
        // can still function in-memory, but log a critical warning.
        cachedConfig = defaultConfig;
        cachedConfigMtimeMs = -1;
        console.error("CRITICAL: Failed to persist model-config.json to disk. Credentials will be lost on restart. Check permissions for: " + getRootConfigDir());
      }
    } else {
      console.warn("[WARNING] model-config.json exists but is unreadable/corrupt. Falling back to defaults in-memory to prevent overwriting user config.");
      cachedConfig = defaultConfig;
      cachedConfigMtimeMs = -1;
    }
    return cachedConfig!;
  } finally {
    releaseLockSync(lockPath);
  }
}

/**
 * Scan model-config.json backups (.corrupt-* and .tmp) newest-first and return the
 * first valid config object parsed, so we can recover settings, presets, and providers.
 */
function recoverConfigFromBackups(configPath: string): GlobalModelConfig | null {
  try {
    const dir = configPath.substring(0, Math.max(configPath.lastIndexOf("/"), configPath.lastIndexOf("\\")));
    const base = configPath.substring(Math.max(configPath.lastIndexOf("/"), configPath.lastIndexOf("\\")) + 1);
    if (!dir || !fs.existsSync(dir)) return null;
    const candidates = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(base + ".corrupt-"))
      .map((f) => {
        const full = dir + "/" + f;
        return { full, mtime: safeMtimeMs(full) };
      })
      .sort((a, b) => b.mtime - a.mtime);
    for (const c of candidates) {
      try {
        const raw = fs.readFileSync(c.full, "utf-8").replace(/^\uFEFF/, "");
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.providers) && parsed.providers.length > 0) {
          return parsed;
        }
      } catch {
        // Skip unreadable/invalid backup
      }
    }
  } catch {
    // Ignore recovery errors
  }
  return null;
}

/**
 * Scan model-config.json backups (.corrupt-* and .tmp) newest-first and return the
 * first valid, non-empty providers array found. Used to recover credentials when the
 * live file's providers field is missing/invalid, so a transient bad write doesn't
 * permanently destroy the user's API keys.
 */
function recoverProvidersFromBackups(configPath: string): ProviderProfile[] | null {
  try {
    const dir = configPath.substring(0, Math.max(configPath.lastIndexOf("/"), configPath.lastIndexOf("\\")));
    const base = configPath.substring(Math.max(configPath.lastIndexOf("/"), configPath.lastIndexOf("\\")) + 1);
    if (!dir || !fs.existsSync(dir)) return null;
    const candidates = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(base + ".corrupt-"))
      .map((f) => {
        const full = dir + "/" + f;
        return { full, mtime: safeMtimeMs(full) };
      })
      .sort((a, b) => b.mtime - a.mtime);
    for (const c of candidates) {
      try {
        const raw = fs.readFileSync(c.full, "utf-8").replace(/^\uFEFF/, "");
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed?.providers) && parsed.providers.length > 0) {
          return parsed.providers;
        }
      } catch {
        // Skip unreadable/invalid backup
      }
    }
  } catch {
    // Ignore recovery errors
  }
  return null;
}

/**
 * Merge the providers we're about to save with whatever providers currently exist on
 * disk. Any provider id that exists on disk but is missing from `config` is preserved
 * (appended), so a stale in-memory snapshot from another process can never silently
 * delete provider profiles + API keys. Providers present in `config` always win for
 * matching ids (this is how legitimate updates take effect).
 *
 * This is intentionally skipped for explicit deletions (see removeProvider).
 */
function mergeProvidersWithDisk(config: GlobalModelConfig, configPath: string): void {
  try {
    if (!fs.existsSync(configPath)) return;
    const raw = fs.readFileSync(configPath, "utf-8").replace(/^\uFEFF/, "");
    const onDisk = JSON.parse(raw);
    if (!Array.isArray(onDisk?.providers)) return;
    const inMemoryIds = new Set((config.providers || []).map((p) => p.id));
    for (const diskProvider of onDisk.providers as ProviderProfile[]) {
      if (diskProvider?.id && !inMemoryIds.has(diskProvider.id)) {
        config.providers.push(diskProvider);
      }
    }
  } catch {
    // If the on-disk file is unreadable, fall through and write what we have.
  }
}

/**
 * Merge the presets we're about to save with whatever presets currently exist on disk.
 * Any preset id (per mode) that exists on disk but is missing from `config` is preserved,
 * so a stale in-memory snapshot from another process can never silently delete a preset
 * the user created in a different process. Presets present in `config` win for matching ids.
 *
 * Intentionally skipped for explicit deletions (see deletePreset).
 */
function mergePresetsWithDisk(config: GlobalModelConfig, configPath: string): void {
  try {
    if (!fs.existsSync(configPath)) return;
    const raw = fs.readFileSync(configPath, "utf-8").replace(/^\uFEFF/, "");
    const onDisk = JSON.parse(raw);
    if (!onDisk?.presets) return;
    for (const mode of ["multi", "single"] as const) {
      const diskList = onDisk.presets?.[mode];
      if (!Array.isArray(diskList)) continue;
      if (!config.presets) continue;
      const memList = config.presets[mode] as any[] | undefined;
      if (!Array.isArray(memList)) continue;
      const memIds = new Set(memList.map((p) => p?.id));
      for (const diskPreset of diskList) {
        if (diskPreset?.id && !memIds.has(diskPreset.id)) {
          memList.push(diskPreset);
        }
      }
    }
  } catch {
    // If the on-disk file is unreadable, fall through and write what we have.
  }
}

function writeConfigAtomically(configPath: string, config: GlobalModelConfig): void {
  ensureGlobalConfigDir();
  const serialized = JSON.stringify(config, null, 2);
  const tmpPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;

  fs.writeFileSync(tmpPath, serialized, "utf-8");

  const MAX_RETRIES = 5;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      try {
        // Try direct rename first (atomic on POSIX and generally works on Windows)
        fs.renameSync(tmpPath, configPath);
        return;
      } catch (renameErr: any) {
        // Fallback to copyFileSync + unlinkSync on Windows if direct rename fails
        try {
          fs.copyFileSync(tmpPath, configPath);
          try { fs.unlinkSync(tmpPath); } catch {}
          return;
        } catch (copyErr: any) {
          // If copy also fails, throw renameErr to let the retry loop handle it
          throw renameErr;
        }
      }
    } catch (renameErr: any) {
      const canRetry = attempt < MAX_RETRIES && (renameErr?.code === "EPERM" || renameErr?.code === "EBUSY" || renameErr?.code === "ENOENT");
      if (renameErr?.code === "ENOENT") {
        try {
          ensureGlobalConfigDir();
          if (!fs.existsSync(tmpPath)) {
            fs.writeFileSync(tmpPath, serialized, "utf-8");
          }
          fs.copyFileSync(tmpPath, configPath);
          try { fs.unlinkSync(tmpPath); } catch {}
          return;
        } catch {}
      }
      if (canRetry) {
        try {
          ensureGlobalConfigDir();
          if (!fs.existsSync(tmpPath)) {
            fs.writeFileSync(tmpPath, serialized, "utf-8");
          }
        } catch {}
        const waitMs = (attempt + 1) * 50;
        sleepSync(waitMs);
        continue;
      }
      try { fs.unlinkSync(tmpPath); } catch {}
      throw renameErr;
    }
  }
}

export function saveModelConfig(
  config: GlobalModelConfig,
  options: { mergeProviders?: boolean; mergePresets?: boolean } = {}
): boolean {
  const { mergeProviders = true, mergePresets = true } = options;
  const configPath = getModelConfigPath();
  ensureGlobalConfigDir();
  const lockPath = getLockPath(configPath);
  const hasLock = acquireLockSync(lockPath);
  if (!hasLock) {
    console.error("CRITICAL: Could not acquire lock to save model-config.json");
    return false;
  }

  try {
    // Guard against stale-snapshot overwrites: if another process added providers or
    // presets since this config was loaded, preserve them instead of clobbering the file.
    if (mergeProviders && Array.isArray(config.providers)) {
      mergeProvidersWithDisk(config, configPath);
    }
    if (mergePresets && config.presets) {
      mergePresetsWithDisk(config, configPath);
    }

    writeConfigAtomically(configPath, config);

    cachedConfig = config;
    cachedConfigMtimeMs = safeMtimeMs(configPath);
    return true;
  } catch (error) {
    console.error("Error writing model-config.json:", error);
    return false;
  } finally {
    releaseLockSync(lockPath);
  }
}

export function getProviders(): ProviderProfile[] {
  return loadModelConfig().providers;
}

export function addProvider(profile: ProviderProfile): void {
  if (profile.baseUrl) {
    profile.baseUrl = ensureProtocol(profile.baseUrl);
  }
  // Note: we do NOT validate apiKey here. Empty keys are valid storage state
  // (e.g. legacy configs, OAuth providers awaiting refresh). Validation lives
  // in getConfiguredProviders().hasValidKey so callers can decide how to react.
  mutateModelConfig((config) => {
    const index = config.providers.findIndex((p) => p.id === profile.id);
    if (index !== -1) {
      config.providers[index] = profile;
    } else {
      config.providers.push(profile);
    }
  });
}

export function removeProvider(id: string): void {
  // Explicit deletion: bypass provider merge guard so removed provider stays deleted.
  mutateModelConfig((config) => {
    config.providers = config.providers.filter((p) => p.id !== id);
  }, { mergeProviders: false });
}

/**
 * Get system settings with defaults filled in for any missing fields.
 */
export function getSettings(): SystemSettings {
  const config = loadModelConfig();
  const s: Partial<SystemSettings> = config.settings || {};

  const rmemoryProvider = s.rmemoryEmbeddingProvider ?? "local";
  let rmemoryModel = s.rmemoryEmbeddingModel;
  let rmemoryDims = s.rmemoryEmbeddingDimensions;
  if (rmemoryProvider === "local") {
    if (!rmemoryModel || rmemoryModel.startsWith("text-embedding-")) {
      rmemoryModel = "Xenova/all-MiniLM-L6-v2";
      rmemoryDims = 384;
    }
  } else if (rmemoryProvider === "openai") {
    if (!rmemoryModel || rmemoryModel.includes("Xenova")) {
      rmemoryModel = "text-embedding-3-small";
      rmemoryDims = 1536;
    }
  }

    return {
      concurrencyLimit: s.concurrencyLimit ?? 0,
      rateLimitRpm: s.rateLimitRpm ?? 60,
      rateLimitCapacity: s.rateLimitCapacity ?? 60,
      disableStreaming: s.disableStreaming ?? false,
      contextWindowLimit: s.contextWindowLimit ?? 0,
      promptContextBudget: s.promptContextBudget ?? 8000,
      maxIterations: s.maxIterations ?? 0,
      simpleTaskFileThreshold: s.simpleTaskFileThreshold ?? 3,
      simpleTaskKeywords: s.simpleTaskKeywords ?? ['lanjut', 'coba', 'go ahead', 'proceed', 'try', 'run', 'execute', 'ok', 'yes', 'y'],
      classifierEnabled: s.classifierEnabled ?? false,
      classifierConfidenceThreshold: s.classifierConfidenceThreshold ?? "high",
      classifierKeywords: s.classifierKeywords ?? {},
      rmemoryGatewayUrl: s.rmemoryGatewayUrl ?? "http://127.0.0.1:8420",
      rmemoryGatewayApiKey: s.rmemoryGatewayApiKey ?? "",
      rmemoryServiceId: s.rmemoryServiceId ?? "default",
      enableRmemory: s.enableRmemory ?? true,
      rmemoryEmbeddingProvider: rmemoryProvider,
      rmemoryEmbeddingModel: rmemoryModel,
      rmemoryEmbeddingDimensions: rmemoryDims ?? 384,
    maxChecklistVisible: s.maxChecklistVisible ?? 3,
    maxHistoryVisible: s.maxHistoryVisible ?? 3,
    maxProcsVisible: s.maxProcsVisible ?? 3,
    hideTimeline: s.hideTimeline ?? false,
    enableAdvisor: s.enableAdvisor ?? true,
    advisorWarningThreshold: s.advisorWarningThreshold ?? 3,
    advisorPauseThreshold: s.advisorPauseThreshold ?? 5,
    advisorErrorThreshold: s.advisorErrorThreshold ?? 5,
    advisorAdaptiveScaling: s.advisorAdaptiveScaling ?? true,
    advisorPatternMemory: s.advisorPatternMemory ?? true,
  };
}

/**
 * Update one or more settings and persist to model-config.json.
 */
export function updateSettings(updates: Partial<SystemSettings>): void {
  const config = loadModelConfig();
  if (!config.settings) {
    config.settings = { ...DEFAULT_CONFIG.settings! };
  }
  const nextSettings = { ...config.settings, ...updates };
  if (JSON.stringify(nextSettings) === JSON.stringify(config.settings)) {
    return;
  }
  config.settings = nextSettings;
  saveModelConfig(config);
}

export function getPresets(mode: "multi" | "single") {
  return loadModelConfig().presets[mode];
}

/**
 * Reload latest config from disk, apply a mutation, then persist in one save.
 * Use this for provider/model/preset writes that would otherwise do read-mutate-save
 * on a possibly stale cached snapshot.
 */
export function mutateModelConfig(
  mutator: (config: GlobalModelConfig) => void,
  options?: Parameters<typeof saveModelConfig>[1]
): void {
  clearModelConfigCache();
  const config = loadModelConfig();
  mutator(config);
  if (!saveModelConfig(config, options)) {
    throw new Error("Failed to save model config to disk. Check permissions for: " + getRootConfigDir());
  }
}

export function savePreset<T>(mode: "multi" | "single", preset: JSONModelPreset<T>): void {
  mutateModelConfig((config) => {
    const presetsList = config.presets[mode] as any[];
    const index = presetsList.findIndex((p) => p.id === preset.id);
    if (index !== -1) {
      presetsList[index] = preset;
    } else {
      presetsList.push(preset);
    }
  });
  if (sessionActivePreset[mode]?.id === preset.id) {
    delete sessionActivePreset[mode];
  }
}

export function deletePreset(mode: "multi" | "single", id: string): void {
  // Reload from disk first so we delete against the current on-disk preset set.
  mutateModelConfig((config) => {
    config.presets[mode] = (config.presets[mode] as any[]).filter((p) => p.id !== id);
  }, { mergePresets: false });
  if (sessionActivePreset[mode]?.id === id) {
    delete sessionActivePreset[mode];
  }
}

export function getActivePresetId(mode: "multi" | "single"): string {
  if (sessionActivePreset[mode]) {
    return sessionActivePreset[mode].id;
  }
  const config = loadModelConfig();
  return config.activePresetId?.[mode] || DEFAULT_CONFIG.activePresetId[mode];
}

export function setActivePresetId(mode: "multi" | "single", id: string): void {
  mutateModelConfig((config) => {
    config.activePresetId[mode] = id;
  });
  delete sessionActivePreset[mode];
}

export function setActivePreset<T>(mode: "multi" | "single", preset: JSONModelPreset<T>): void {
  sessionActivePreset[mode] = JSON.parse(JSON.stringify(preset));
}

export function saveSessionPreset<T>(mode: "multi" | "single", preset: JSONModelPreset<T>): void {
  sessionActivePreset[mode] = JSON.parse(JSON.stringify(preset));
}

export function clearSessionActivePreset(mode?: "multi" | "single"): void {
  if (mode) {
    delete sessionActivePreset[mode];
  } else {
    sessionActivePreset = {};
  }
}

export function getActivePreset<T>(mode: "multi" | "single"): JSONModelPreset<T> {
  if (sessionActivePreset[mode]) {
    return sessionActivePreset[mode] as any;
  }
  const config = loadModelConfig();
  const activeId = getActivePresetId(mode);
  const presetsList = config.presets?.[mode] as any[] | undefined;
  let preset: any;
  if (presetsList) {
    preset = presetsList.find((p) => p.id === activeId);
  }
  if (!preset && presetsList && presetsList.length > 0) {
    preset = presetsList[0];
  }
  if (!preset) {
    preset = JSON.parse(JSON.stringify(DEFAULT_CONFIG.presets[mode][0]));
  }
  return JSON.parse(JSON.stringify(preset)) as any;
}

export function getActiveConfigAudit(overrideMode?: "multi" | "single"): string {
  const mode = overrideMode || (process.argv.includes("--multi") || process.env.SUPERAGENT_MULTI === "true" ? "multi" : "single");
  const preset = getActivePreset<any>(mode);
  
  let lines = [
    `│ ✦ Active Preset   : ${preset.name} (${mode}-agent mode)`
  ];

  if (mode === "multi") {
    const m = preset.models;
    lines.push(`│ ✦ Master Agent    : ${m.master?.providerProfileId || "(default)"} ➔ ${m.master?.model || "(not set)"}`);
    lines.push(`│ ✦ Superagent      : ${m.superagent?.providerProfileId || "(default)"} ➔ ${m.superagent?.model || "(not set)"}`);
    lines.push(`│ ✦ Subagent Default: ${m.subagentDefault?.providerProfileId || "(default)"} ➔ ${m.subagentDefault?.model || "(not set)"}`);
    if (m.subagentDetails && Object.keys(m.subagentDetails).length > 0) {
      for (const [t, cfg] of Object.entries(m.subagentDetails)) {
        lines.push(`│ ✦ Subagent (${t}): ${(cfg as any).providerProfileId} ➔ ${(cfg as any).model}`);
      }
    }
  } else {
    const m = preset.models;
    lines.push(`│ ✦ Superagent      : ${m.superagent?.providerProfileId || "(default)"} ➔ ${m.superagent?.model || "(not set)"}`);
    lines.push(`│ ✦ Subagent Default: ${m.subagentDefault?.providerProfileId || "(default)"} ➔ ${m.subagentDefault?.model || "(not set)"}`);
    if (m.subagentDetails && Object.keys(m.subagentDetails).length > 0) {
      for (const [t, cfg] of Object.entries(m.subagentDetails)) {
        lines.push(`│ ✦ Subagent (${t}): ${(cfg as any).providerProfileId} ➔ ${(cfg as any).model}`);
      }
    }
  }
  return lines.join("\n");
}

/**
 * Get model info for display purposes from JSON config.
 * Returns formatted model strings for each tier.
 */
export function getModelInfoForDisplay(isMulti: boolean): {
  activeProvider: string;
  master: string;
  superagent: string;
  subagentDefault: string;
  subagentDetails: Record<string, string>;
} {
  const mode = isMulti ? "multi" : "single";
  const preset = getActivePreset<any>(mode);
  const config = loadModelConfig();
  const models = preset.models || {};

  // Get active provider from the main tier config
  const mainTier = isMulti ? models.master : models.superagent;
  const activeProvider = mainTier?.providerProfileId || "";

  const formatModel = (tier: any): string => {
    if (!tier?.model) return "(use default)";
    if (tier.providerProfileId) {
      const profile = config.providers.find(p => p.id === tier.providerProfileId);
      if (profile) {
        return `${profile.provider}@${tier.model}`;
      }
    }
    return tier.model;
  };

  const subagentDetails: Record<string, string> = {};
  if (models.subagentDetails) {
    for (const [type, cfg] of Object.entries(models.subagentDetails)) {
      if (cfg && typeof cfg === "object" && "model" in cfg) {
        subagentDetails[type] = formatModel(cfg);
      }
    }
  }

  return {
    activeProvider,
    master: formatModel(models.master),
    superagent: formatModel(models.superagent),
    subagentDefault: formatModel(models.subagentDefault),
    subagentDetails,
  };
}

export function getTrustedDirectories(): string[] {
  const workspaces = getWorkspacesFromDb();
  return workspaces.filter(ws => ws.isTrusted).map(ws => ws.path);
}

export function addTrustedDirectory(dirPath: string, name?: string): void {
  const resolvedPath = dirPath.startsWith("ssh:") ? dirPath : path.resolve(dirPath);
  const id = getWorkspaceId(resolvedPath);
  saveWorkspaceToDb({
    id,
    path: resolvedPath,
    name,
    isTrusted: true
  });
}

export function removeTrustedDirectory(dirPath: string): void {
  const resolvedPath = dirPath.startsWith("ssh:") ? dirPath : path.resolve(dirPath);
  deleteWorkspaceFromDb(resolvedPath);
}

export function isDirectoryTrusted(dirPath: string): boolean {
  const resolvedPath = path.resolve(dirPath);
  const id = getWorkspaceId(resolvedPath);
  const ws = getWorkspaceFromDb(id);
  return ws ? ws.isTrusted : false;
}

/**
 * Ensure a directory is added to Git's global safe.directory configuration
 * to prevent dubious ownership issues on Windows/multi-user systems.
 */
export async function ensureDirectoryTrusted(dirPath: string, cwd: string = process.cwd()): Promise<void> {
  try {
    const resolvedPath = path.resolve(dirPath);
    // Normalize path to use forward slashes for Git config compatibility on Windows
    const normalizedPath = resolvedPath.replace(/\\/g, "/");

    // Check if it's already in safe.directory to avoid duplicates
    const { stdout } = await execa("git", ["config", "--global", "--get-all", "safe.directory"], { cwd, reject: false });
    const safeDirectories = stdout.split(/\r?\n/).map(d => d.trim().replace(/\\/g, "/"));

    if (!safeDirectories.includes(normalizedPath)) {
      await execa("git", ["config", "--global", "--add", "safe.directory", normalizedPath], { cwd });
    }
  } catch (err) {
    // Ignore config errors
  }
}


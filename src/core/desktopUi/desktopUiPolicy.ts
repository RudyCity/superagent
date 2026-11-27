/**
 * Operator-controlled read-only Desktop UI policy.
 *
 * `superagent_desktop_ui` is classified as a dangerous tool, so every call
 * normally needs an operator-approved Execute grant on the active project. That
 * is deliberate for input/launch/close, but it also blocks pure discovery, which
 * returns window titles and process names and is therefore metadata-sensitive.
 *
 * This module keeps the safe default (discovery still requires the dangerous
 * tool path) and only changes behaviour when the operator explicitly opts in
 * with a bounded JSON file. Making it a file rather than a parameter means an
 * MCP client can never grant itself the relaxation.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DESKTOP_UI_POLICY_FILENAME = "desktop-ui-policy.json";
const MAX_POLICY_BYTES = 4_096;

/**
 * How long a cached policy is trusted without touching the filesystem. Every
 * MCP call asks this module whether the call needs the dangerous path, so a
 * stat+read per call was measurable overhead on a hot tool. Within the TTL the
 * cached value is used as-is; after it, one stat decides whether the file
 * changed (mtime or size) before any read. Both directions stay bounded: a new
 * opt-in becomes visible within the TTL, and a removed/broken file can only
 * keep a previously parsed value for that same short window.
 */
export const DESKTOP_UI_POLICY_CACHE_TTL_MS = 1_500;

export interface DesktopUiPolicyOptions {
  configDir?: string;
  /** Test/diagnostic override; production callers use the default TTL. */
  ttlMs?: number;
}

export interface DesktopUiPolicy {
  version: 1;
  /** true (default): discovery needs the dangerous-tool Execute path. */
  discoveryRequiresDangerousTool: boolean;
}

export const DEFAULT_DESKTOP_UI_POLICY: DesktopUiPolicy = Object.freeze({
  version: 1,
  discoveryRequiresDangerousTool: true,
});

/** Commands that only read the host: no input, no lifecycle, no session creation. */
const READ_ONLY_DESKTOP_COMMANDS = new Set([
  "probe",
  "list_windows",
  "list_monitors",
  "get_active_window",
  "find_window",
  "inspect_window",
  "list_installed_apps",
  "inspect_security_prompts",
  "live_inventory",
  "snapshot",
  "wait_ready",
  /** Bounded in-process perception counters; reads no window content. */
  "stats",
]);

const ACTION_KINDS = new Set(["click", "type", "key", "scroll"]);

/** Resolve the command exactly like the dispatcher does, without executing. */
export function resolveDesktopUiCommand(args: unknown): string {
  if (!args || typeof args !== "object" || Array.isArray(args)) return "";
  const record = args as Record<string, unknown>;
  const command = typeof record.command === "string" ? record.command.trim().toLowerCase() : "";
  if (command) return command;
  const action = typeof record.action === "string" ? record.action.trim().toLowerCase() : "";
  if (!action) return "";
  if (READ_ONLY_DESKTOP_COMMANDS.has(action)) return action;
  // Discovery commands are also reachable through the `action` spelling.
  return ACTION_KINDS.has(action) ? "action" : action;
}

export function isReadOnlyDesktopUiCall(args: unknown): boolean {
  const command = resolveDesktopUiCommand(args);
  return command !== "" && READ_ONLY_DESKTOP_COMMANDS.has(command);
}

function parsePolicy(value: unknown): DesktopUiPolicy | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 2 || record.version !== 1 ||
      typeof record.discoveryRequiresDangerousTool !== "boolean") return null;
  return { version: 1, discoveryRequiresDangerousTool: record.discoveryRequiresDangerousTool };
}

interface PolicyCacheEntry {
  dir: string;
  /** -1 when the file is missing; a later creation invalidates by mtime/size. */
  mtimeMs: number;
  size: number;
  checkedAt: number;
  policy: DesktopUiPolicy;
}

let policyCache: PolicyCacheEntry | null = null;

function resolvePolicyDir(options: DesktopUiPolicyOptions): string {
  return options.configDir ?? process.env.SUPERAGENT_CONFIG_DIR ?? path.join(os.homedir(), ".superagent-r");
}

function readPolicyFile(file: string, stats: fs.Stats | null): DesktopUiPolicy {
  if (!stats || !stats.isFile() || stats.isSymbolicLink()) {
    return { ...DEFAULT_DESKTOP_UI_POLICY };
  }
  if (stats.size < 2 || stats.size > MAX_POLICY_BYTES) {
    return { ...DEFAULT_DESKTOP_UI_POLICY };
  }
  try {
    return parsePolicy(JSON.parse(fs.readFileSync(file, "utf8"))) ?? { ...DEFAULT_DESKTOP_UI_POLICY };
  } catch {
    return { ...DEFAULT_DESKTOP_UI_POLICY };
  }
}

function statPolicyFile(file: string): fs.Stats | null {
  try {
    return fs.lstatSync(file);
  } catch {
    return null;
  }
}

/**
 * Read the bounded operator policy through a short-lived cache. Missing,
 * unreadable, oversized or malformed files fail closed to the strict default;
 * they never widen access.
 */
export function readDesktopUiPolicy(options: DesktopUiPolicyOptions = {}): DesktopUiPolicy {
  const dir = resolvePolicyDir(options);
  if (!path.isAbsolute(dir)) return { ...DEFAULT_DESKTOP_UI_POLICY };

  const ttlMs = options.ttlMs ?? DESKTOP_UI_POLICY_CACHE_TTL_MS;
  const now = Date.now();
  // Warm path: neither stat nor read while the entry is fresh.
  if (policyCache && policyCache.dir === dir && now - policyCache.checkedAt < ttlMs) {
    return { ...policyCache.policy };
  }

  const file = path.join(dir, DESKTOP_UI_POLICY_FILENAME);
  const stats = statPolicyFile(file);
  const mtimeMs = stats?.mtimeMs ?? -1;
  const size = stats?.size ?? -1;
  if (policyCache && policyCache.dir === dir
      && policyCache.mtimeMs === mtimeMs && policyCache.size === size) {
    policyCache = { ...policyCache, checkedAt: now };
    return { ...policyCache.policy };
  }

  const policy = readPolicyFile(file, stats);
  policyCache = { dir, mtimeMs, size, checkedAt: now, policy };
  return { ...policy };
}

/** Test seam: drop the cached policy so the next read touches the filesystem. */
export function resetDesktopUiPolicyCache(): void {
  policyCache = null;
}

/**
 * True when this specific call must still pass the dangerous-tool project
 * Execute gate. Only an explicit operator opt-in relaxes read-only discovery.
 */
export function desktopUiRequiresDangerousExecution(
  args: unknown,
  policy: DesktopUiPolicy = readDesktopUiPolicy(),
): boolean {
  if (policy.discoveryRequiresDangerousTool) return true;
  return !isReadOnlyDesktopUiCall(args);
}

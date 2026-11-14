/**
 * Local Tray-owned, bounded trusted-window preferences. A trusted entry is
 * permission to REQUEST a host prompt, never permission to dispatch input.
 * Host consent remains in DesktopUiConsentManager and is checked on each action.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DesktopDiscoveredWindow, DesktopWindowTarget } from "../desktopUi/types.js";

export const TRUSTED_INPUT_FILENAME = "desktop-input-trusted.json";
export const TRUSTED_INPUT_MAX_MS = 30 * 60_000;
export const TRUSTED_INPUT_MAX_ENTRIES = 16;

export interface TrustedInputTarget {
  pid: number;
  nativeId: string;
  title: string;
  application: string;
  approvedAt: number;
  expiresAt: number;
}
export interface TrustedInputPolicy {
  version: 1;
  mode: "off" | "trusted";
  targets: TrustedInputTarget[];
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
}
function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function descriptor(value: unknown, length: number): value is string {
  return typeof value === "string" && value.length > 0 &&
    value.length <= length && !/[\u0000-\u001f\u007f]/.test(value) && value === value.trim();
}
function validTarget(value: unknown, now: number): value is TrustedInputTarget {
  if (!record(value) || !exactKeys(value, ["pid", "nativeId", "title", "application", "approvedAt", "expiresAt"])) return false;
  return Number.isSafeInteger(value.pid) && (value.pid as number) > 0 &&
    (value.pid as number) <= 0xffffffff &&
    descriptor(value.nativeId, 256) && descriptor(value.title, 512) &&
    descriptor(value.application, 256) &&
    Number.isSafeInteger(value.approvedAt) && Number.isSafeInteger(value.expiresAt) &&
    (value.approvedAt as number) <= now + 60_000 &&
    (value.expiresAt as number) > (value.approvedAt as number) &&
    (value.expiresAt as number) - (value.approvedAt as number) <= TRUSTED_INPUT_MAX_MS &&
    (value.expiresAt as number) <= now + TRUSTED_INPUT_MAX_MS;
}

export function parseTrustedInputPolicy(value: unknown, now = Date.now()): TrustedInputPolicy | null {
  if (!record(value) || !exactKeys(value, ["version", "mode", "targets"]) ||
      value.version !== 1 || (value.mode !== "trusted" && value.mode !== "off") ||
      !Array.isArray(value.targets) || value.targets.length > TRUSTED_INPUT_MAX_ENTRIES) return null;
  if (value.targets.some((item: unknown) => !validTarget(item, now))) return null;
  const targets = value.targets as TrustedInputTarget[];
  const identities = new Set(targets.map(t => `${t.pid}:\0${t.nativeId}`));
  if (identities.size !== targets.length) return null;
  return { version: 1, mode: value.mode, targets: targets.filter(t => t.expiresAt > now) };
}

/** Reject symlinks, non-regular files, oversize data, or relative overrides. */
export function readTrustedInputPolicy(options: {
  configDir?: string;
  now?: number;
} = {}): TrustedInputPolicy | null {
  const dir = options.configDir ?? process.env.SUPERAGENT_CONFIG_DIR ?? path.join(os.homedir(), ".superagent-r");
  if (!path.isAbsolute(dir)) return null;
  const file = path.join(dir, TRUSTED_INPUT_FILENAME);
  try {
    const stats = fs.lstatSync(file);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 16384 || stats.size < 2) return null;
    const content = fs.readFileSync(file, "utf8");
    return parseTrustedInputPolicy(JSON.parse(content), options.now ?? Date.now());
  } catch {
    return null;
  }
}

/** Exact target AND fresh OS-discovered identity are mandatory. */
export function trustedWindowMatch(
  policy: TrustedInputPolicy | null,
  target: DesktopWindowTarget,
  observed: DesktopDiscoveredWindow,
  now = Date.now(),
): TrustedInputTarget | null {
  if (policy?.mode !== "trusted" || observed.pid !== target.pid ||
    observed.nativeId !== target.nativeId || observed.title !== target.title ||
    !observed.application || !observed.active) return null;
  return policy.targets.find(entry =>
    entry.pid === target.pid && entry.nativeId === target.nativeId &&
    entry.title === observed.title && entry.application === observed.application &&
    entry.expiresAt > now && entry.expiresAt <= now + TRUSTED_INPUT_MAX_MS
  ) ?? null;
}

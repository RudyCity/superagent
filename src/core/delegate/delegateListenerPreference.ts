/** Owner-scoped, persistent preference for the localhost Chrome Delegate listener.
 * Explicit Start/Stop changes this file. Supervisor handovers never do.
 */
import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getRootConfigDir } from "../config/paths.js";

export interface DelegateListenerPreference {
  version: 1;
  enabled: boolean;
  updatedAt: number;
}

export function delegateListenerPreferencePath(): string {
  return join(getRootConfigDir(), "delegate", "listener-preference-v1.json");
}

export function readDelegateListenerPreference(file = delegateListenerPreferencePath()): boolean {
  let stat;
  try { stat = lstatSync(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; // First install only.
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096 || stat.size === 0)
    throw new Error("DELEGATE_LISTENER_PREFERENCE_UNSAFE");
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(file, "utf8")); }
  catch { throw new Error("DELEGATE_LISTENER_PREFERENCE_INVALID"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("DELEGATE_LISTENER_PREFERENCE_INVALID");
  const record = parsed as Partial<DelegateListenerPreference>;
  if (record.version !== 1 || typeof record.enabled !== "boolean" ||
      !Number.isSafeInteger(record.updatedAt) || record.updatedAt! < 1)
    throw new Error("DELEGATE_LISTENER_PREFERENCE_INVALID");
  return record.enabled;
}

export function writeDelegateListenerPreference(enabled: boolean, file = delegateListenerPreferencePath()): void {
  if (typeof enabled !== "boolean") throw new Error("DELEGATE_LISTENER_PREFERENCE_INVALID");
  const parent = dirname(file);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("DELEGATE_LISTENER_PREFERENCE_UNSAFE");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const tmp = join(parent, ".delegate-preference-" + randomBytes(8).toString("hex") + ".tmp");
  try {
    writeFileSync(tmp, JSON.stringify({ version: 1, enabled, updatedAt: Date.now() } satisfies DelegateListenerPreference), {
      flag: "wx", mode: 0o600, encoding: "utf8",
    });
    renameSync(tmp, file);
  } finally {
    try { rmSync(tmp, { force: true }); } catch { /* atomic rename consumed temporary file */ }
  }
}

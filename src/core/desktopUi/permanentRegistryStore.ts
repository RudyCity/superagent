/**
 * Read-only Core view of Tray-owned permanent access registry.
 * Missing/corrupt/oversize/symlinked state denies registered privileges.
 * The ONLY writer is native Tray after an attended host dialog.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parsePersistentAccessPolicy, EMPTY_ACCESS_POLICY, type PersistentAccessPolicy } from "./persistentAccessPolicy.js";

export const PERMANENT_ACCESS_FILENAME = "desktop-access-registry.json";
export function readPermanentAccessRegistry(options: { configDir?: string } = {}): PersistentAccessPolicy | null {
  const dir = options.configDir ?? process.env.SUPERAGENT_CONFIG_DIR ?? path.join(os.homedir(), ".superagent-r");
  if (!path.isAbsolute(dir)) return EMPTY_ACCESS_POLICY;
  const p = path.join(dir, PERMANENT_ACCESS_FILENAME);
  // Only a genuinely ABSENT v2 file allows legacy v1 migration behavior.
  // A present but corrupt or unreadable v2 file must fail CLOSED, never fall
  // back to a previously trusted short-lived window from the legacy registry.
  try {
    fs.lstatSync(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    return EMPTY_ACCESS_POLICY;
  }
  try {
    const stat = fs.lstatSync(p);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > 128 * 1024)
      return EMPTY_ACCESS_POLICY;
    const parsed = parsePersistentAccessPolicy(JSON.parse(fs.readFileSync(p, "utf8")));
    return parsed ?? EMPTY_ACCESS_POLICY;
  } catch { return EMPTY_ACCESS_POLICY; }
}

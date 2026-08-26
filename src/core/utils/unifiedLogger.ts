import fs from "fs";
import path from "path";
import { getGlobalConfigDir } from "../config/paths.js";

export type LogCategory = "SQL" | "SUPERAGENT-SERVER" | "TLINE-BACKEND" | "TLINE-UI";

// Diagnostic logging must never block the event loop: writes are queued as
// fire-and-forget promises, serialized per file to preserve ordering. The
// directory existence check runs once per process instead of on every call.
// Trade-off: the very last lines may be lost on an abrupt process exit,
// which is acceptable for diagnostic logs.
let dirEnsured = false;
const writeQueues = new Map<string, Promise<void>>();

function enqueueAppend(filePath: string, line: string): void {
  const last = writeQueues.get(filePath) ?? Promise.resolve();
  const next = last
    .then(() => fs.promises.appendFile(filePath, line, "utf-8"))
    .catch(() => {
      // Never let a failed diagnostic write break the caller or the queue.
    });
  writeQueues.set(filePath, next);
}

export function logE2E(category: LogCategory, message: string, meta?: any): void {
  try {
    const dir = getGlobalConfigDir();
    if (!dirEnsured) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      dirEnsured = true;
    }
    const logPath = path.join(dir, "e2e-unified.log");
    const superagentLogPath = path.join(dir, "superagent.log");

    const timestamp = new Date().toISOString();
    const metaStr = meta !== undefined ? ` | ${typeof meta === "string" ? meta : JSON.stringify(meta)}` : "";
    const line = `[${timestamp}] [${category}] ${message}${metaStr}\n`;

    enqueueAppend(logPath, line);
    enqueueAppend(superagentLogPath, line);
  } catch {}
}

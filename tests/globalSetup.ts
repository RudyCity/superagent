import fs from "node:fs";
import path from "node:path";

const testsDir = path.resolve(process.cwd(), "tests");
const tempPrefix = "temp-home-worker-";

function cleanupStaleTestHomes(): void {
  if (!fs.existsSync(testsDir)) return;
  for (const entry of fs.readdirSync(testsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(tempPrefix)) continue;
    try {
      fs.rmSync(path.join(testsDir, entry.name), {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      });
    } catch {
      // Best-effort cleanup; test failures should report the actual fixture issue.
    }
  }
}

export default async function setup(): Promise<() => void> {
  // TEMP-DIAG: the main process also reports unhandled errors; log their raw
  // stacks because Vitest's sourcemap reader can fail with EISDIR first.
  process.on("unhandledRejection", (reason: unknown) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    try {
      console.error("[main-unhandled] " + String(error.stack ?? reason));
    } catch {}
  });
  process.on("uncaughtExceptionMonitor", (error: Error, origin: string) => {
    try {
      console.error("[main-uncaught] " + origin + " " + String(error?.stack ?? error));
    } catch {}
  });
  // Remove leftovers only before workers start and after every worker has exited.
  cleanupStaleTestHomes();
  return cleanupStaleTestHomes;
}

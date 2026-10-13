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
  // Remove leftovers only before workers start and after every worker has exited.
  cleanupStaleTestHomes();
  return cleanupStaleTestHomes;
}

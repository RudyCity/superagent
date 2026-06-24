import { beforeEach, afterEach } from "vitest";
import path from "path";
import fs from "fs";

// Isolate configuration directory per Vitest worker to prevent parallel test lock contention
const workerId = process.env.VITEST_WORKER_ID || "0";
const workerHomeDir = path.join(process.cwd(), "tests", `temp-home-worker-${workerId}`);
const workerConfigDir = path.join(workerHomeDir, ".superagent-r");

// Clean up any stale directory from a previous Vitest run at startup
if (fs.existsSync(workerHomeDir)) {
  try {
    fs.rmSync(workerHomeDir, { recursive: true, force: true });
  } catch {}
}

process.env.SUPERAGENT_CONFIG_DIR = workerConfigDir;

// Protect tests against global environment and command-line argument pollution
let originalArgv: string[];
let originalEnv: Record<string, string | undefined>;

beforeEach(() => {
  originalArgv = [...process.argv];
  originalEnv = { ...process.env };
});

afterEach(() => {
  process.argv = originalArgv;
  process.env = originalEnv;
});

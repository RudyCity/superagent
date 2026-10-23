/**
 * Release acceptance runbook (safe, no daemon restart and no project writes).
 * bun scripts/verify-brain-release.ts [--with-tline]
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dir, "..");
const tline = path.resolve(root, "..", "t-line");
const withTline = process.argv.includes("--with-tline");
const run = (cwd: string, args: string[]) => {
  console.log("CHECK", cwd, "bun", args.join(" "));
  const result = spawnSync("bun", args, { cwd, shell: process.platform === "win32", stdio: "inherit" });
  if (result.status !== 0) throw new Error("Brain release check failed: " + args.join(" "));
};
run(root, ["scripts/check-brain-docs.ts"]);
run(root, ["run", "build"]);
run(root, ["--bun", "x", "vitest", "run",
  "tests/brainWorkspace.test.ts",
  "tests/brainTasks.test.ts",
  "tests/brainCommandDiscovery.test.ts",
  "tests/brainArtifactTransaction.test.ts",
  "tests/brainAgentCredentials.test.ts",
  "tests/brainTaskRecovery.test.ts",
  "tests/brainTaskReconciler.test.ts",
  "tests/brainTaskContinuity.test.ts",
  "tests/brainObservability.test.ts",
  "tests/brainReliability.test.ts",
  "tests/brainProvenance.test.ts",
  "tests/brainStreamingIndex.test.ts",
  "tests/brainStorageMcp.test.ts",
  "tests/brainMcp.test.ts",
  "tests/brainDelegationPromotion.test.ts",
  "tests/brainHistoryLifecycle.test.ts",
  "tests/mcpOAuthHttpE2E.test.ts"]);
if (withTline) {
  if (!fs.existsSync(path.join(tline, "backend", "src", "brainStorageManager.ts"))) {
    throw new Error("T-Line sibling repository required for --with-tline.");
  }
  run(root, ["scripts/sync-brain-runtime.ts", "--check"]);
  run(tline, ["scripts/check-brain-docs.cjs"]);
  run(tline, ["scripts/check-brain-runtime.cjs"]);
  run(tline, ["run", "build:backend"]);
  run(tline, ["run", "build:frontend"]);
  run(tline, ["--bun", "x", "vitest", "run", "backend/tests/brainExplorerRoutes.test.ts"]);
  run(path.join(tline, "frontend"), ["--bun", "x", "vitest", "run", "--config", "vite.config.ts",
    "src/components/__tests__/SuperAgentBrainExplorer.test.tsx",
    "src/components/__tests__/SuperAgentBrainTaskPanel.test.tsx",
    "src/components/__tests__/SuperAgentCliParity.test.ts"]);
}
console.log("PASS: offline Brain release checks. Live tunnel OAuth and installed desktop acceptance remain separate.");

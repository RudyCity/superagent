/**
 * Run benchmark of real independent Bun processes sharing ONE CDP target.
 * Synthetic browser work runs under the same filesystem locks and RBAC as CDP;
 * no real Chrome, cookies or login data are accessed.
 *
 * bun scripts/benchmark-shared-cdp.ts --agents=10 --actions=5 --work-ms=15
 */
import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimCdpTarget, inviteCdpAgent, joinCdpTarget, setCdpSharing } from "../src/core/tools/chromeCdpSessionManager.js";

function arg(name: string, fallback: number): number {
  const found = process.argv.find(a => a.startsWith("--" + name + "="));
  const value = Number(found?.split("=")[1] ?? fallback);
  if (!Number.isSafeInteger(value)) throw new Error("Invalid benchmark parameter " + name);
  return value;
}
const agents = arg("agents", 3), actions = arg("actions", 5), workMs = arg("work-ms", 15);
if (agents < 3 || agents > 10 || actions < 1 || actions > 50 || workMs < 0 || workMs > 250)
  throw new Error("Parameters must satisfy agents 3-10, actions 1-50 and work-ms 0-250.");
const dir = await mkdtemp(join(tmpdir(), "superagent-bench-cdp-"));
const old = process.env.SUPERAGENT_CDP_SESSION_DIR;
process.env.SUPERAGENT_CDP_SESSION_DIR = dir;
const targetId = "SHARED_BENCH", port = 9222;
function childWrite(agentId: string, sessionToken: string): Promise<{ agentId: string; elapsed: number[]; failed: number }> {
  return new Promise((resolve, reject) => {
    const worker = join(import.meta.dir, "../tests/fixtures/cdpSharedBenchWorker.ts");
    const child = spawn(process.execPath, [worker], {
      windowsHide: true, env: { ...process.env, SUPERAGENT_CDP_SESSION_DIR: dir },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "", diagnostics = "";
    child.stdout.on("data", value => output += String(value));
    child.stderr.on("data", value => diagnostics += String(value).slice(0, 500));
    child.once("error", reject);
    child.once("exit", code => {
      if (code !== 0) return reject(new Error("Benchmark child exited " + code + ": " + diagnostics.slice(0, 100)));
      try { resolve(JSON.parse(output.trim())); } catch { reject(new Error("Benchmark child output invalid.")); }
    });
    // Secret is passed over a private pipe, never a process command line or log.
    child.stdin.end(JSON.stringify({ port, targetId, agentId, sessionToken, actions, workMs }));
  });
}
function percentile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))];
}
try {
  const owner = await claimCdpTarget(port, targetId, "benchmark_owner");
  await setCdpSharing(port, targetId, "benchmark_owner", owner.sessionToken, true);
  const members: Array<{ agentId: string; sessionToken: string }> = [];
  for (let i = 0; i < agents; i++) {
    const agentId = "bench-" + i;
    const invite = await inviteCdpAgent(port, targetId, "benchmark_owner", owner.sessionToken, agentId, "contributor");
    const joined = await joinCdpTarget(port, targetId, agentId, invite.inviteId, invite.invitationToken);
    members.push({ agentId, sessionToken: joined.sessionToken });
  }
  const start = performance.now();
  const results = await Promise.all(members.map(x => childWrite(x.agentId, x.sessionToken)));
  const durationMs = performance.now() - start;
  const elapsed = results.flatMap(x => x.elapsed).sort((a, b) => a - b);
  const failures = results.reduce((n, x) => n + x.failed, 0);
  const output = {
    benchmark: "CDP shared-tab coordinator synthetic cross-process",
    agents, operations: agents * actions, completed: elapsed.length, failures,
    durationMs: Number(durationMs.toFixed(1)),
    throughputPerSecond: Number((1000 * elapsed.length / durationMs).toFixed(2)),
    meanMs: Number((elapsed.reduce((a, b) => a + b, 0) / Math.max(1, elapsed.length)).toFixed(1)),
    p50Ms: Number(percentile(elapsed, 0.50).toFixed(1)),
    p95Ms: Number(percentile(elapsed, 0.95).toFixed(1)),
    p99Ms: Number(percentile(elapsed, 0.99).toFixed(1)),
  };
  process.stdout.write(JSON.stringify(output, null, 2) + "\n");
  if (failures) process.exitCode = 1;
} finally {
  if (old === undefined) delete process.env.SUPERAGENT_CDP_SESSION_DIR;
  else process.env.SUPERAGENT_CDP_SESSION_DIR = old;
  await rm(dir, { force: true, recursive: true });
}

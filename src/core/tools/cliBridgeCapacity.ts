/**
 * Host-local bounded delegation capacity. Atomic directories reserve a slot
 * across independent SuperAgent processes. Unknown/orphan slots are never
 * deleted automatically: a process PID alone is not safe ownership evidence.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface CliBridgeCapacityLease {
  index: number;
  path: string;
  token: string;
}
function capacityRoot(): string {
  return process.env.SUPERAGENT_CLI_BRIDGE_CAPACITY_DIR || path.join(os.tmpdir(), "superagent-cli-bridge-capacity-v1");
}
export async function acquireCliBridgeCapacity(maxConcurrent: number, jobId: string): Promise<CliBridgeCapacityLease> {
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 12)
    throw new Error("CLI Bridge capacity must be an integer between 1 and 12.");
  await fs.mkdir(capacityRoot(), { recursive: true });
  for (let index = 0; index < maxConcurrent; index++) {
    const directory = path.join(capacityRoot(), String(index).padStart(2, "0"));
    try {
      await fs.mkdir(directory); // cross-process exclusive
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
    const token = crypto.randomBytes(24).toString("hex");
    try {
      await fs.writeFile(path.join(directory, "owner.json"),
        JSON.stringify({ token, jobId, pid: process.pid, acquiredAt: Date.now() }),
        { encoding: "utf8", flag: "wx" });
      return { index, path: directory, token };
    } catch (error) {
      await fs.rmdir(directory).catch(() => {});
      throw error;
    }
  }
  throw new Error("CLI Bridge host-wide concurrency slots are full (" + maxConcurrent +
    "). Inspect delegations and capacity slots; orphan ownership requires manual review.");
}
export async function releaseCliBridgeCapacity(lease: CliBridgeCapacityLease): Promise<void> {
  const stat = await fs.lstat(lease.path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unexpected capacity directory type.");
  const owner = JSON.parse(await fs.readFile(path.join(lease.path, "owner.json"), "utf8")) as { token?: string };
  if (owner.token !== lease.token) throw new Error("CLI Bridge capacity lease token mismatch; refusing cleanup.");
  await fs.unlink(path.join(lease.path, "owner.json"));
  await fs.rmdir(lease.path);
}
export async function listCliBridgeCapacity(maxConcurrent = 4): Promise<Array<{
  index: number; occupied: boolean; ownerPid?: number; acquiredAt?: number; jobId?: string;
}>> {
  return Promise.all(Array.from({ length: Math.min(12, Math.max(1, maxConcurrent)) }, async (_, index) => {
    const directory = path.join(capacityRoot(), String(index).padStart(2, "0"));
    try {
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return { index, occupied: true };
      const raw = JSON.parse(await fs.readFile(path.join(directory, "owner.json"), "utf8"));
      return { index, occupied: true, ownerPid: raw.pid, acquiredAt: raw.acquiredAt, jobId: raw.jobId };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        try { await fs.lstat(directory); return { index, occupied: true }; }
        catch (nested) { if ((nested as NodeJS.ErrnoException).code === "ENOENT") return { index, occupied: false }; throw nested; }
      }
      return { index, occupied: true };
    }
  }));
}

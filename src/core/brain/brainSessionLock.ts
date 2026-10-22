/**
 * Cross-process, owner-session write lock for Brain mutations.
 * Stale locks are reclaimed ONLY when their owner process is provably dead.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const STALE_GRACE_MS = 5000;

function alive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; }
  catch (err: any) { return err?.code !== "ESRCH"; }
}

export function withBrainSessionLock<T>(dir: string, work: () => T): T {
  const lock = path.join(dir, ".brain-write.lock");
  const marker = crypto.randomBytes(16).toString("hex");
  let fd: number;
  try {
    fd = fs.openSync(lock, "wx", 0o600);
  } catch (error: any) {
    if (error?.code !== "EEXIST") throw error;
    const stat = fs.lstatSync(lock);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("Unsafe Brain lock.");
    let owner: { pid?: number } = {};
    try { owner = JSON.parse(fs.readFileSync(lock, "utf8")); } catch {}
    if (Date.now() - stat.mtimeMs < STALE_GRACE_MS || alive(Number(owner.pid))) {
      throw new Error("Brain session is being modified by another process.");
    }
    // Do not reclaim a recent/uncertain owner. A resumed client can retry.
    fs.unlinkSync(lock);
    fd = fs.openSync(lock, "wx", 0o600);
  }
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, marker, acquiredAt: Date.now() }));
    fs.fsyncSync(fd);
    return work();
  } finally {
    fs.closeSync(fd);
    try {
      const recorded = JSON.parse(fs.readFileSync(lock, "utf8"));
      if (recorded.marker === marker) fs.unlinkSync(lock);
    } catch { /* Never remove a lock with a different owner. */ }
  }
}

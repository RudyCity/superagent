/** Host-local cross-process claims for CLI Bridge output artifacts.
 *
 * Each canonical file identity hashes to one exclusively created lockfile in a
 * shared same-user temp directory, independent of SUPERAGENT_CONFIG_DIR.
 * This is fail-closed on owner crash: child processes may survive parent death,
 * so locks are never auto-stolen based on PID, age, or a guessed lease expiry.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface CrossProcessArtifactClaims {
  readonly jobId: string;
  readonly locks: ReadonlyArray<{ path: string; token: string }>;
}

function claimDir(): string {
  return path.join(os.tmpdir(), "superagent-cli-bridge-artifact-claims-v1");
}

function claimPath(identity: string): string {
  return path.join(claimDir(), crypto.createHash("sha256").update(identity).digest("hex") + ".lock");
}

async function ensureClaimDir(): Promise<void> {
  await fs.mkdir(claimDir(), { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(claimDir());
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("CLI Bridge claim directory is not a safe directory.");
  }
}

export async function acquireCrossProcessArtifactClaims(identities: string[], jobId: string): Promise<CrossProcessArtifactClaims> {
  if (!identities.length) return { jobId, locks: [] };
  await ensureClaimDir();
  const unique = [...new Set(identities)].sort();
  if (unique.length !== identities.length) throw new Error("Duplicate canonical artifact claim.");
  const acquired: Array<{ path: string; token: string }> = [];
  try {
    for (const identity of unique) {
      const lockPath = claimPath(identity);
      const token = crypto.randomBytes(24).toString("hex");
      let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
      try {
        handle = await fs.open(lockPath, "wx", 0o600);
        // Claim is held from successful wx onward. Write metadata and flush
        // before attempting the next claim. Empty/partial locks remain blocked.
        acquired.push({ path: lockPath, token });
        await handle.writeFile(JSON.stringify({
          version: 1, jobId, token, ownerPid: process.pid, createdAt: Date.now(),
          identitySha256: crypto.createHash("sha256").update(identity).digest("hex"),
        }));
        await handle.sync();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new Error("CLI Bridge artifact claim already held by another process; do not retry until it is released or safely recovered.");
        }
        throw error;
      } finally {
        await handle?.close();
      }
    }
    return { jobId, locks: acquired };
  } catch (error) {
    await releaseCrossProcessArtifactClaims({ jobId, locks: acquired });
    throw error;
  }
}

export async function releaseCrossProcessArtifactClaims(claims: CrossProcessArtifactClaims): Promise<void> {
  for (const lock of [...claims.locks].reverse()) {
    try {
      // Owner token prevents a stale job from unlinking somebody else's claim
      // when a file was replaced out-of-band. Never unlink unrecognized locks.
      const stored = JSON.parse(await fs.readFile(lock.path, "utf8")) as { token?: unknown; jobId?: unknown };
      if (stored.token !== lock.token || stored.jobId !== claims.jobId) {
        throw new Error("CLI Bridge claim ownership mismatch; refusing unsafe release.");
      }
      await fs.unlink(lock.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

/** Diagnostic helper; does not reclaim locks. Never trust PID alone for safe recovery. */
export async function inspectCrossProcessArtifactClaim(identity: string): Promise<{
  locked: boolean; ownerPid?: number; jobId?: string; createdAt?: number; recoverManually?: boolean;
}> {
  try {
    const raw = await fs.readFile(claimPath(identity), "utf8");
    try {
      const value = JSON.parse(raw) as { ownerPid?: unknown; jobId?: unknown; createdAt?: unknown };
      return {
        locked: true,
        ownerPid: typeof value.ownerPid === "number" ? value.ownerPid : undefined,
        jobId: typeof value.jobId === "string" ? value.jobId : undefined,
        createdAt: typeof value.createdAt === "number" ? value.createdAt : undefined,
        recoverManually: true,
      };
    } catch {
      return { locked: true, recoverManually: true };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { locked: false };
    // Error reading lock ownership must not be mistaken for an unlocked claim.
    return { locked: true, recoverManually: true };
  }
}

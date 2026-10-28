import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type ResourceClaimType = "file" | "tree" | "git-branch" | "port" | "cdp-tab" | "service";
export type ResourceClaimMode = "read" | "write";

export interface ResourceClaimRequest {
  type: ResourceClaimType;
  target: string;
  mode: ResourceClaimMode;
}

export interface ResourceClaimLease {
  claimId: string;
  identity: string;
  mode: ResourceClaimMode;
  jobId: string;
  token: string;
  lockPath: string;
  acquiredAt: number;
}

export interface ResourceClaimInspection {
  identity: string;
  locked: boolean;
  activeWriters: number;
  activeReaders: number;
  claims: Array<{
    jobId: string;
    mode: ResourceClaimMode;
    token: string;
    ownerPid: number;
    acquiredAt: number;
  }>;
}

function resourceClaimRoot(): string {
  return process.env.SUPERAGENT_CLI_BRIDGE_CLAIMS_DIR || path.join(os.tmpdir(), "superagent-cli-bridge-claims-v2");
}

export function canonicalResourceIdentity(type: ResourceClaimType, target: string): string {
  const normTarget = target.trim().replace(/\\/g, "/").toLowerCase();
  return `${type}:${normTarget}`;
}

function claimDirectoryForIdentity(identity: string): string {
  const hash = crypto.createHash("sha256").update(identity).digest("hex");
  return path.join(resourceClaimRoot(), hash);
}

async function ensureClaimRoot(): Promise<void> {
  const root = resourceClaimRoot();
  await fs.mkdir(root, { recursive: true });
}

/**
 * Cross-process atomic mutual exclusion lock per resource directory.
 * Uses OS-level exclusive creation flag 'wx' to prevent TOCTOU race conditions.
 */
async function withResourceMutex<T>(
  claimDir: string,
  fn: () => Promise<T>,
  timeoutMs = 10_000
): Promise<T> {
  await fs.mkdir(claimDir, { recursive: true });
  const mutexPath = path.join(claimDir, ".claim_mutex");
  const startTime = Date.now();
  let handle: fs.FileHandle | null = null;

  while (Date.now() - startTime < timeoutMs) {
    try {
      handle = await fs.open(mutexPath, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
      await handle.sync();
      break;
    } catch (err: any) {
      if (err.code === "EEXIST") {
        try {
          const stat = await fs.stat(mutexPath);
          if (Date.now() - stat.mtimeMs > 5_000) {
            await fs.rm(mutexPath, { force: true });
          }
        } catch {}
        const delay = 5 + Math.floor(Math.random() * 20);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }

  if (!handle) {
    throw new Error(`Timed out waiting for resource claim mutex in ${claimDir}`);
  }

  try {
    return await fn();
  } finally {
    try {
      await handle.close();
    } catch {}
    try {
      await fs.unlink(mutexPath);
    } catch {}
  }
}

async function inspectClaimsUnlocked(claimDir: string, identity: string): Promise<ResourceClaimInspection> {
  try {
    const files = await fs.readdir(claimDir);
    const claims: ResourceClaimInspection["claims"] = [];
    let writers = 0;
    let readers = 0;

    for (const file of files) {
      if (!file.startsWith("claim-") || !file.endsWith(".json")) continue;
      try {
        const content = JSON.parse(await fs.readFile(path.join(claimDir, file), "utf8"));
        claims.push({
          jobId: content.jobId,
          mode: content.mode,
          token: content.token,
          ownerPid: content.ownerPid,
          acquiredAt: content.acquiredAt,
        });
        if (content.mode === "write") writers++;
        else readers++;
      } catch {
        // Ignore unreadable individual claim files
      }
    }

    return {
      identity,
      locked: claims.length > 0,
      activeWriters: writers,
      activeReaders: readers,
      claims,
    };
  } catch {
    return {
      identity,
      locked: false,
      activeWriters: 0,
      activeReaders: 0,
      claims: [],
    };
  }
}

/**
 * Inspects all active leases for a given resource identity.
 */
export async function inspectResourceClaim(identity: string): Promise<ResourceClaimInspection> {
  const dir = claimDirectoryForIdentity(identity);
  return inspectClaimsUnlocked(dir, identity);
}

/**
 * Acquires a set of resource claims (read or write).
 * Uses atomic mutual exclusion and OS-level exclusive file creation to guarantee
 * that no simultaneous callers can acquire conflicting claims.
 */
export async function acquireResourceClaims(
  requests: ResourceClaimRequest[],
  jobId: string,
  options?: { claimsDir?: string }
): Promise<ResourceClaimLease[]> {
  if (requests.length === 0) return [];
  await ensureClaimRoot();

  // Deduplicate and canonicalize
  const normalized = requests.map((req) => ({
    identity: canonicalResourceIdentity(req.type, req.target),
    mode: req.mode,
  }));

  // Check for internal conflicts within the same request batch
  const writeIdentities = new Set<string>();
  const readIdentities = new Set<string>();
  for (const item of normalized) {
    if (item.mode === "write") {
      if (writeIdentities.has(item.identity) || readIdentities.has(item.identity)) {
        throw new Error(`Conflicting claims for identity: ${item.identity}`);
      }
      writeIdentities.add(item.identity);
    } else {
      if (writeIdentities.has(item.identity)) {
        throw new Error(`Conflicting claims for identity: ${item.identity}`);
      }
      readIdentities.add(item.identity);
    }
  }

  const acquired: ResourceClaimLease[] = [];

  try {
    for (const item of normalized) {
      const claimDir = claimDirectoryForIdentity(item.identity);
      await fs.mkdir(claimDir, { recursive: true });

      const lease = await withResourceMutex(claimDir, async () => {
        // Check existing claims under atomic lock
        const existing = await inspectClaimsUnlocked(claimDir, item.identity);
        if (item.mode === "write") {
          if (existing.locked) {
            throw new Error(
              `Resource '${item.identity}' is currently locked by active ${existing.activeWriters > 0 ? "writer" : "readers"} (job ${existing.claims[0]?.jobId}).`
            );
          }
        } else {
          // read mode
          if (existing.activeWriters > 0) {
            throw new Error(
              `Resource '${item.identity}' is currently exclusively locked by writer job ${existing.claims[0]?.jobId}.`
            );
          }
        }

        const token = crypto.randomBytes(16).toString("hex");
        const claimFile = path.join(claimDir, `claim-${jobId}-${token}.json`);
        const payload = {
          identity: item.identity,
          jobId,
          mode: item.mode,
          token,
          ownerPid: process.pid,
          acquiredAt: Date.now(),
        };

        // Write atomic claim file
        await fs.mkdir(claimDir, { recursive: true });
        await fs.writeFile(claimFile, JSON.stringify(payload, null, 2), {
          encoding: "utf8",
          flag: "wx",
        });

        // In write mode, create write.lock as secondary exclusive guard
        if (item.mode === "write") {
          const writeLock = path.join(claimDir, "write.lock");
          let wh: fs.FileHandle | null = null;
          try {
            wh = await fs.open(writeLock, "wx", 0o600);
            await wh.writeFile(JSON.stringify({ jobId, token, acquiredAt: Date.now() }));
            await wh.sync();
          } catch (err: any) {
            // Unwind claimFile if write.lock collided
            await fs.unlink(claimFile).catch(() => {});
            if (err.code === "EEXIST") {
              throw new Error(`Resource '${item.identity}' is currently locked by active writer (job ${existing.claims[0]?.jobId ?? "unknown"}).`);
            }
            throw err;
          } finally {
            await wh?.close().catch(() => {});
          }
        }

        return {
          claimId: `claim_${jobId}_${token.slice(0, 8)}`,
          identity: item.identity,
          mode: item.mode,
          jobId,
          token,
          lockPath: claimFile,
          acquiredAt: payload.acquiredAt,
        };
      });

      acquired.push(lease);
    }

    return acquired;
  } catch (error) {
    // Release any claims acquired in this partial attempt
    await releaseResourceClaims(acquired).catch(() => {});
    throw error;
  }
}

/**
 * Releases resource claims with strict token verification.
 */
export async function releaseResourceClaims(leases: ResourceClaimLease[]): Promise<void> {
  for (const lease of leases) {
    const claimDir = path.dirname(lease.lockPath);
    try {
      await withResourceMutex(claimDir, async () => {
        try {
          const raw = await fs.readFile(lease.lockPath, "utf8");
          const meta = JSON.parse(raw);
          if (meta.token === lease.token && meta.jobId === lease.jobId) {
            await fs.unlink(lease.lockPath);
            if (lease.mode === "write") {
              await fs.unlink(path.join(claimDir, "write.lock")).catch(() => {});
            }
          }
        } catch {
          // Ignore missing or already-removed claim files
        }
      });
    } catch {
      // Fallback direct cleanup if mutex error
      try {
        await fs.unlink(lease.lockPath);
        if (lease.mode === "write") {
          await fs.unlink(path.join(claimDir, "write.lock")).catch(() => {});
        }
      } catch {}
    }
  }
}

/**
 * Host-local bounded delegation capacity. Atomic directories reserve a slot
 * across independent SuperAgent processes. Unknown slots fail closed. Only a
 * slot whose owner/child evidence is proven dead may be recovered; PID alone
 * is never treated as safe ownership evidence.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getRootConfigDir } from "../config/paths.js";
import { readProcessStartIdentity } from "./cliBridgeProcessIdentity.js";
import {
  observeProcessId,
  classifyCapacitySlot,
  type CapacitySlotClassification,
  type CapacitySlotState,
  type SlotOwnerMetadata,
} from "./cliBridgeRecovery.js";
import { jobShardPath } from "./cliBridgeJobStore.js";

export interface CliBridgeCapacityLease {
  index: number;
  path: string;
  token: string;
}

export type CliBridgeCapacityOwnerMetadata = SlotOwnerMetadata;

export interface DetailedCapacitySlotDiagnostic extends CapacitySlotClassification {
  readonly index: number;
  readonly path: string;
  readonly ownerData?: Partial<CliBridgeCapacityOwnerMetadata> | null;
  readonly jobId?: string;
  readonly ownerPid: number | null;
  readonly childPid: number | null;
  readonly acquiredAt?: number;
  readonly heartbeatAt?: number;
}

export function capacityRoot(): string {
  return process.env.SUPERAGENT_CLI_BRIDGE_CAPACITY_DIR || path.join(os.tmpdir(), "superagent-cli-bridge-capacity-v1");
}

const capacityUpdateQueues = new Map<string, Promise<void>>();

function delegationsDir(): string {
  return path.join(getRootConfigDir(), "cli-bridge", "delegations");
}

const VALID_SNAPSHOT = /^\d{13}-\d{10}-[a-f0-9]{16}\.json$/;

async function readLatestJobShard(jobId: string, jobsDir = delegationsDir()): Promise<any | null> {
  try {
    const dir = jobShardPath(jobsDir, jobId);
    const files = (await fs.readdir(dir)).filter(name => VALID_SNAPSHOT.test(name)).sort().reverse();
    if (!files.length) return null;
    return JSON.parse(await fs.readFile(path.join(dir, files[0]), "utf8"));
  } catch {
    return null;
  }
}

export async function inspectCapacitySlot(
  index: number,
  options?: { capacityDir?: string; jobsDir?: string }
): Promise<DetailedCapacitySlotDiagnostic> {
  const root = options?.capacityDir || capacityRoot();
  const directory = path.join(root, String(index).padStart(2, "0"));

  let stat;
  try {
    stat = await fs.lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      const cls = classifyCapacitySlot({ exists: false });
      return {
        ...cls,
        index,
        path: directory,
        ownerPid: null,
        childPid: null,
      };
    }
    const cls = classifyCapacitySlot({ exists: true, corruptReason: "Cannot inspect slot directory: " + (error as Error).message });
    return {
      ...cls,
      index,
      path: directory,
      ownerPid: null,
      childPid: null,
    };
  }

  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    const cls = classifyCapacitySlot({ exists: true, isDir: stat.isDirectory(), isSymlink: stat.isSymbolicLink() });
    return {
      ...cls,
      index,
      path: directory,
      ownerPid: null,
      childPid: null,
    };
  }

  const ownerPath = path.join(directory, "owner.json");
  let ownerData: Partial<CliBridgeCapacityOwnerMetadata> | null = null;
  try {
    ownerData = JSON.parse(await fs.readFile(ownerPath, "utf8"));
  } catch (error) {
    const cls = classifyCapacitySlot({ exists: true, isDir: true, isSymlink: false, corruptReason: "owner.json unreadable: " + (error as Error).message });
    return {
      ...cls,
      index,
      path: directory,
      ownerPid: null,
      childPid: null,
    };
  }

  // Attempt to enrich from job shard if child info or process identity is missing
  let jobShard: any = null;
  if (ownerData?.jobId) {
    jobShard = await readLatestJobShard(ownerData.jobId, options?.jobsDir);
  }

  const enrichedOwnerData: Partial<CliBridgeCapacityOwnerMetadata> = {
    ...ownerData,
    ownerProcessIdentity: ownerData?.ownerProcessIdentity || jobShard?.ownerProcessIdentity,
    childPid: ownerData?.childPid ?? jobShard?.pid,
    childProcessIdentity: ownerData?.childProcessIdentity || jobShard?.childProcessIdentity,
    heartbeatAt: ownerData?.heartbeatAt ?? jobShard?.heartbeatAt,
  };

  const ownerPid = typeof enrichedOwnerData.pid === "number" ? enrichedOwnerData.pid : null;
  const childPid = typeof enrichedOwnerData.childPid === "number" ? enrichedOwnerData.childPid : null;

  const ownerPidObs = observeProcessId(ownerPid);
  const childPidObs = childPid !== null ? observeProcessId(childPid) : "pid_absent";

  const ownerIdentityObs = ownerPidObs === "pid_present_unverified"
    ? await readProcessStartIdentity(ownerPid)
    : null;
  const childIdentityObs = childPidObs === "pid_present_unverified"
    ? await readProcessStartIdentity(childPid)
    : null;

  const cls = classifyCapacitySlot({
    exists: true,
    isDir: true,
    isSymlink: false,
    ownerData: enrichedOwnerData,
    ownerPidObservation: ownerPidObs,
    ownerIdentityObservation: ownerIdentityObs,
    childPidObservation: childPidObs,
    childIdentityObservation: childIdentityObs,
    jobStatus: jobShard?.status,
    ownedByCurrentRuntime: ownerPid === process.pid && !jobShard?.endedAt,
  });

  return {
    ...cls,
    index,
    path: directory,
    ownerData: enrichedOwnerData,
    jobId: enrichedOwnerData.jobId,
    ownerPid,
    childPid,
    acquiredAt: enrichedOwnerData.acquiredAt,
    heartbeatAt: enrichedOwnerData.heartbeatAt,
  };
}

export async function recoverProvenOrphanSlot(
  index: number,
  options?: { capacityDir?: string; jobsDir?: string }
): Promise<{ ok: boolean; slot: number; previousState: CapacitySlotState; reason: string }> {
  const diag = await inspectCapacitySlot(index, options);
  if (diag.state !== "owner_dead_child_dead_recoverable") {
    throw new Error(
      `Cannot recover capacity slot ${index}: state is '${diag.state}' (${diag.reason}). ` +
      `Only proven orphans in 'owner_dead_child_dead_recoverable' state may be safely recovered.`
    );
  }
  const expectedToken = diag.ownerData?.token;
  const expectedJobId = diag.ownerData?.jobId;
  if (typeof expectedToken !== "string" || typeof expectedJobId !== "string") {
    throw new Error("Cannot recover capacity slot: immutable owner identity is unavailable.");
  }

  // Serialize recovery of this exact directory. Without an exclusive marker,
  // two recovery attempts could both inspect the old lease and one could race
  // with a new owner after the other removed/recreated the slot directory.
  const recoveryLock = path.join(diag.path, ".recovery.lock");
  let lockCreated = false;
  try {
    await fs.writeFile(recoveryLock,
      JSON.stringify({ token: crypto.randomBytes(16).toString("hex"), pid: process.pid }),
      { encoding: "utf8", flag: "wx", mode: 0o600 });
    lockCreated = true;

    const currentOwner = JSON.parse(
      await fs.readFile(path.join(diag.path, "owner.json"), "utf8")
    ) as Partial<CliBridgeCapacityOwnerMetadata>;
    if (currentOwner.token !== expectedToken || currentOwner.jobId !== expectedJobId) {
      throw new Error("Capacity slot ownership changed during recovery; refusing cleanup.");
    }

    const rechecked = await inspectCapacitySlot(index, options);
    if (rechecked.state !== "owner_dead_child_dead_recoverable" ||
        rechecked.ownerData?.token !== expectedToken ||
        rechecked.ownerData?.jobId !== expectedJobId) {
      throw new Error("Capacity slot recovery evidence changed; refusing cleanup.");
    }

    // Rename the entire old slot atomically before deletion. Once renamed, a
    // new owner may safely create the canonical slot path while this process
    // deletes only the quarantined, token-verified old lease.
    const quarantine = diag.path + ".recover-" + process.pid + "-" +
      crypto.randomBytes(8).toString("hex");
    await fs.rename(diag.path, quarantine);
    lockCreated = false;
    await fs.rm(quarantine, { recursive: true, force: true });

    return {
      ok: true,
      slot: index,
      previousState: diag.state,
      reason: diag.reason,
    };
  } finally {
    if (lockCreated) await fs.rm(recoveryLock, { force: true }).catch(() => {});
  }
}

export async function acquireCliBridgeCapacity(
  maxConcurrent: number,
  jobId: string,
  extraMetadata?: Partial<CliBridgeCapacityOwnerMetadata>,
  options?: { autoRecoverOrphans?: boolean; capacityDir?: string; jobsDir?: string }
): Promise<CliBridgeCapacityLease> {
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 12)
    throw new Error("CLI Bridge capacity must be an integer between 1 and 12.");
  const root = options?.capacityDir || capacityRoot();
  await fs.mkdir(root, { recursive: true });

  for (let index = 0; index < maxConcurrent; index++) {
    const directory = path.join(root, String(index).padStart(2, "0"));
    try {
      await fs.mkdir(directory); // cross-process exclusive
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        if (options?.autoRecoverOrphans !== false) {
          try {
            const diag = await inspectCapacitySlot(index, options);
            if (diag.state === "owner_dead_child_dead_recoverable") {
              await recoverProvenOrphanSlot(index, options);
              await fs.mkdir(directory);
            } else {
              continue;
            }
          } catch {
            continue;
          }
        } else {
          continue;
        }
      } else {
        throw error;
      }
    }

    const token = crypto.randomBytes(24).toString("hex");
    const payload: CliBridgeCapacityOwnerMetadata = {
      token,
      jobId,
      pid: process.pid,
      acquiredAt: Date.now(),
      ...extraMetadata,
    };

    try {
      await fs.writeFile(
        path.join(directory, "owner.json"),
        JSON.stringify(payload),
        { encoding: "utf8", flag: "wx" }
      );
      return { index, path: directory, token };
    } catch (error) {
      await fs.rmdir(directory).catch(() => {});
      throw error;
    }
  }

  throw new Error("CLI Bridge host-wide concurrency slots are full (" + maxConcurrent +
    "). Inspect delegations and capacity slots; orphan ownership requires manual review.");
}

export async function updateCliBridgeCapacity(
  lease: CliBridgeCapacityLease,
  patch: Partial<CliBridgeCapacityOwnerMetadata>
): Promise<void> {
  const key = lease.path;
  const previous = capacityUpdateQueues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    try {
      const ownerFile = path.join(lease.path, "owner.json");
      const existing = JSON.parse(await fs.readFile(ownerFile, "utf8")) as CliBridgeCapacityOwnerMetadata;
      if (existing.token !== lease.token) return;
      const updated: CliBridgeCapacityOwnerMetadata = { ...existing, ...patch, token: existing.token };
      await fs.writeFile(ownerFile, JSON.stringify(updated), "utf8");
    } catch {
      // Metadata enrichment is best effort. Recovery still fails closed when
      // required ownership evidence is unavailable.
    }
  });
  capacityUpdateQueues.set(key, next);
  try { await next; }
  finally {
    if (capacityUpdateQueues.get(key) === next) capacityUpdateQueues.delete(key);
  }
}

export async function releaseCliBridgeCapacity(lease: CliBridgeCapacityLease): Promise<void> {
  await capacityUpdateQueues.get(lease.path)?.catch(() => {});
  const stat = await fs.lstat(lease.path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unexpected capacity directory type.");
  const owner = JSON.parse(await fs.readFile(path.join(lease.path, "owner.json"), "utf8")) as { token?: string };
  if (owner.token !== lease.token) throw new Error("CLI Bridge capacity lease token mismatch; refusing cleanup.");
  await fs.unlink(path.join(lease.path, "owner.json"));
  await fs.rmdir(lease.path);
}

export async function listDetailedCapacitySlots(
  maxConcurrent = 4,
  options?: { capacityDir?: string; jobsDir?: string }
): Promise<DetailedCapacitySlotDiagnostic[]> {
  const count = Math.min(12, Math.max(1, maxConcurrent));
  return Promise.all(
    Array.from({ length: count }, (_, index) => inspectCapacitySlot(index, options))
  );
}

export async function listCliBridgeCapacity(maxConcurrent = 4): Promise<Array<{
  index: number; occupied: boolean; ownerPid?: number; acquiredAt?: number; jobId?: string;
}>> {
  const detailed = await listDetailedCapacitySlots(maxConcurrent);
  return detailed.map(slot => ({
    index: slot.index,
    occupied: slot.occupied,
    ownerPid: slot.ownerPid ?? undefined,
    acquiredAt: slot.acquiredAt,
    jobId: slot.jobId,
  }));
}

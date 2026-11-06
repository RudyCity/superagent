/**
 * Durable Delegate-CDP Core bootstrap. Explicit, opt-in and fail-closed.
 *
 * The lifecycle supervisor (not an MCP request, env var or browser parameter)
 * must inject an independently verified Core fencing capability and stable key.
 * An owner file persists across crashes. Recovery cannot silently break it.
 */
import {
  closeSync, existsSync, lstatSync, openSync, readdirSync, readFileSync, renameSync,
  unlinkSync, writeFileSync, fsyncSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { createDelegateLeaseJournal, type DelegateLeaseJournal } from "./delegateLeaseJournal.js";
import {
  blockDelegateLeaseActivation, configureDelegateLeaseJournal,
  type DelegateLeaseOperationFence,
} from "./sessionCoordinator.js";

type CoreProof = {
  /** New, unpredictable 128-bit epoch established by a trusted Core supervisor. */
  epoch: string;
  /** Human-readable supervisor-owned generation identity (not a user agentId). */
  ownerId: string;
  /** Synchronous, independent proof that THIS process still owns the Core epoch. */
  assertCurrent: () => boolean;
  /** Synchronous proof of exclusive/private storage, including Windows ACLs. */
  assertPrivateStorage: (directory: string) => boolean;
  /** Independent supervisor proof of prior generation retirement + fencing. */
  isEpochRetired: (epoch: string) => boolean;
};
export interface DelegateLeaseRuntimeOptions {
  directory: string;
  /** Vetted lifecycle-caller supplied key; never read from environment or written to disk. */
  integrityKey: Uint8Array;
  /** Must be injected in-process from trusted supervisor wiring. Never accept from RPC. */
  verifiedCoreOwner: CoreProof;
  /** Explicit initial provisioning only, when no journal or prior owner exists. */
  initializeEmptyJournal?: boolean;
}
export type DelegateLeaseRuntimeStatus = {
  status: "DISABLED" | "BLOCKED" | "ACTIVE";
  reason: string;
  epoch?: string;
  ownerId?: string;
  journalSequence?: number;
  recoveredClaims?: number;
};
const EPOCH = /^[a-f0-9]{32}$/;
const LOCK = "delegate-core-owner.v1.lock";
const BOOT = "delegate-core-bootstrap.v1.lock";
const OP = "delegate-core-operation.v1.lock";
const MAX_LOCK_BYTES = 4096;
let state: DelegateLeaseRuntimeStatus = {
  status: "DISABLED", reason: "No verified Core lifecycle owner supplied; durable integration is not enabled.",
};
let active: { lockPath: string; nonce: string; epoch: string; ownerId: string;
  assertFence: () => void; operationPath: string } | undefined;

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}
function inspectLock(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const st = lstatSync(path);
  if (!st.isFile() || st.isSymbolicLink() || st.size > MAX_LOCK_BYTES ||
      (process.platform !== "win32" && (st.mode & 0o077) !== 0)) {
    fail("DELEGATE_LEASE_LOCK_UNSAFE", "Unsafe Core ownership/operation lock file.");
  }
  return readFileSync(path, "utf8");
}
function readOwner(path: string): { epoch: string; ownerId: string; nonce: string } | undefined {
  const raw = inspectLock(path);
  if (raw === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw Error();
    const record = parsed as Record<string, unknown>;
    if (!EPOCH.test(String(record.epoch)) || typeof record.ownerId !== "string" ||
        !record.ownerId || typeof record.nonce !== "string" || !EPOCH.test(record.nonce) ||
        Object.keys(record).sort().join(",") !== "epoch,nonce,ownerId") throw Error();
    return record as { epoch: string; ownerId: string; nonce: string };
  } catch {
    fail("DELEGATE_LEASE_LOCK_UNSAFE", "Core owner lock is malformed; manual review required.");
  }
}
function createLock(path: string, content: string): void {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, content, "utf8");
    fsyncSync(fd);
  } finally { closeSync(fd); }
}
function sameOwner(path: string, nonce: string, epoch: string): boolean {
  const owner = readOwner(path);
  return owner?.nonce === nonce && owner?.epoch === epoch;
}
/** Safe, non-mutating status. Disabled by default even when an old journal exists. */
export function getDelegateLeaseRuntimeStatus(): DelegateLeaseRuntimeStatus {
  if (active && state.status === "ACTIVE") {
    try { active.assertFence(); } catch (error) {
      state = { status: "BLOCKED", reason: "Core ownership proof/fence was lost: " + String((error as Error).message) };
      blockDelegateLeaseActivation(state.reason);
    }
  }
  return { ...state };
}

/**
 * Only call from trusted Core lifecycle owner bootstrap, after its own identity
 * and fencing checks. No automatic wiring to env, MCP or service status claims.
 */
export function activateDelegateLeaseRuntime(options?: DelegateLeaseRuntimeOptions): DelegateLeaseRuntimeStatus {
  if (state.status !== "DISABLED") return getDelegateLeaseRuntimeStatus();
  const proof = options?.verifiedCoreOwner;
  if (!options || !proof || !EPOCH.test(proof.epoch ?? "") ||
      typeof proof.ownerId !== "string" || !/^[a-zA-Z0-9_.:@-]{1,96}$/.test(proof.ownerId) ||
      typeof proof.assertCurrent !== "function" ||
      typeof proof.assertPrivateStorage !== "function" ||
      typeof proof.isEpochRetired !== "function" ||
      !options.integrityKey || options.integrityKey.length < 32) {
    state = { status: "BLOCKED", reason: "Missing verified supervisor owner, epoch, protected key or fencing callbacks." };
    blockDelegateLeaseActivation(state.reason);
    return { ...state };
  }
  let lockPath: string | undefined;
  let nonce: string | undefined;
  let bootPath: string | undefined;
  let bootHeld = false;
  try {
    if (proof.assertCurrent() !== true || proof.assertPrivateStorage(options.directory) !== true) {
      fail("DELEGATE_LEASE_EVIDENCE", "Core ownership or protected storage evidence failed.");
    }
    // Also validates absolute canonical directory and directory protection.
    const journal: DelegateLeaseJournal = createDelegateLeaseJournal({
      directory: options.directory, integrityKey: options.integrityKey, epoch: proof.epoch,
      previousEpochRetired: (epoch) => epoch !== proof.epoch && proof.assertCurrent() === true &&
        proof.isEpochRetired(epoch) === true,
    });
    lockPath = join(options.directory, LOCK);
    bootPath = join(options.directory, BOOT);
    const operationPath = join(options.directory, OP);
    createLock(bootPath, JSON.stringify({ epoch: proof.epoch }));
    bootHeld = true;
    // Never adopt a previous in-flight command after a Core crash.
    if (inspectLock(operationPath) !== undefined)
      fail("DELEGATE_LEASE_PENDING_WRITE", "Unreconciled Core browser operation marker; do not replay or recover.");
    const retiredOwners = readdirSync(options.directory).filter(name => name.startsWith(LOCK + ".retired."));
    if (retiredOwners.length > 1024)
      fail("DELEGATE_LEASE_EPOCH_HISTORY", "Core generation history requires manual archival review.");
    for (const name of retiredOwners) {
      if (!EPOCH.test(name.slice((LOCK + ".retired.").length)))
        fail("DELEGATE_LEASE_LOCK_UNSAFE", "Unexpected retired Core lock filename.");
      if (readOwner(join(options.directory, name))?.epoch === proof.epoch)
        fail("DELEGATE_LEASE_EPOCH_REPLAY", "Core generation epoch has already been used.");
    }
    const oldOwner = readOwner(lockPath);
    if (oldOwner) {
      if (oldOwner.epoch === proof.epoch || proof.isEpochRetired(oldOwner.epoch) !== true) {
        fail("DELEGATE_LEASE_OWNER_COLLISION", "Other Core ownership is active or prior epoch not proven retired.");
      }
    }
    const hasJournal = existsSync(journal.path);
    if (!hasJournal && (oldOwner || options.initializeEmptyJournal !== true)) {
      fail("DELEGATE_LEASE_MISSING", "Existing journal required; explicit first-time initialization not authorized.");
    }
    if (hasJournal) {
      const snapshot = journal.read(); // HMAC validation before claiming anything.
      if (snapshot.writerEpoch === proof.epoch)
        fail("DELEGATE_LEASE_EPOCH_REPLAY", "A prior Core journal may not restart with the same epoch.");
      if (proof.isEpochRetired(snapshot.writerEpoch) !== true) {
        fail("DELEGATE_LEASE_EPOCH_AMBIGUOUS", "Journal writer epoch not independently fenced.");
      }
    }
    if (proof.assertCurrent() !== true)
      fail("DELEGATE_LEASE_EVIDENCE", "Core ownership changed during bootstrap.");
    if (oldOwner) {
      // Under the exclusive bootstrap gate; never unlink someone else's lock.
      renameSync(lockPath, lockPath + ".retired." + oldOwner.nonce);
    }
    nonce = randomBytes(16).toString("hex");
    createLock(lockPath, JSON.stringify({ epoch: proof.epoch, ownerId: proof.ownerId, nonce }));
    const expectedLock = lockPath;
    const expectedNonce = nonce;
    const assertFence = () => {
      if (proof.assertCurrent() !== true || !sameOwner(expectedLock, expectedNonce, proof.epoch))
        fail("DELEGATE_LEASE_FENCED", "Core epoch no longer holds its verified on-disk ownership fence.");
    };
    const operationFence: DelegateLeaseOperationFence = {
      assertCurrent: assertFence,
      beginOperation: () => {
        assertFence();
        const opNonce = randomBytes(16).toString("hex");
        try { createLock(operationPath, JSON.stringify({ epoch: proof.epoch, nonce: opNonce })); }
        catch { fail("DELEGATE_LEASE_PENDING_WRITE", "Another Core operation is active or marker is unresolved."); }
        try { assertFence(); }
        catch (error) { // Keep marker when the epoch changed mid-operation.
          throw error;
        }
        return (completed = true) => {
          // Unknown completion must be reconciled externally, not automatically replayed.
          if (!completed) {
            state = { status: "BLOCKED", reason: "Unresolved browser command; operation marker retained for manual reconciliation." };
            blockDelegateLeaseActivation(state.reason);
            return;
          }
          const raw = inspectLock(operationPath);
          let match = false;
          try { const parsed = JSON.parse(raw ?? "null"); match = parsed?.nonce === opNonce && parsed?.epoch === proof.epoch; }
          catch { /* keep ambiguous marker */ }
          if (!match) fail("DELEGATE_LEASE_PENDING_WRITE", "Operation marker changed; refusing unsafe release.");
          unlinkSync(operationPath);
        };
      },
    };
    if (!hasJournal) journal.initialize();
    configureDelegateLeaseJournal(journal, operationFence);
    const snapshot = journal.read();
    assertFence();
    active = { lockPath, nonce, epoch: proof.epoch, ownerId: proof.ownerId, operationPath, assertFence };
    state = {
      status: "ACTIVE", reason: snapshot.writerEpoch === proof.epoch
        ? "Verified, exclusive Core owner; durable operations fenced."
        : "Verified successor owner; prior claims quarantined until explicit token recovery.",
      epoch: proof.epoch, ownerId: proof.ownerId, journalSequence: snapshot.sequence,
      recoveredClaims: snapshot.leases.filter(l => l.recoveredEpoch === proof.epoch).length,
    };
    return { ...state };
  } catch (error) {
    const reason = String((error as Error & {code?: string}).code || "DELEGATE_LEASE_BLOCKED") + ": " + String((error as Error).message);
    state = { status: "BLOCKED", reason };
    blockDelegateLeaseActivation(reason);
    if (lockPath && nonce) {
      try {
        if (sameOwner(lockPath, nonce, proof.epoch)) unlinkSync(lockPath);
      } catch { /* Leave ambiguous state fail-closed. */ }
    }
    return { ...state };
  } finally {
    if (bootHeld && bootPath) {
      // Release only bootstrap gate we created, never forcibly break a foreign lock.
      try { unlinkSync(bootPath); } catch { /* Ambiguous bootstrap state blocks future activation. */ }
    }
  }
}
/** Explicit graceful retirement; never shuts down Core or alters the journal. */
export function retireDelegateLeaseRuntime(): DelegateLeaseRuntimeStatus {
  if (!active || state.status !== "ACTIVE") return getDelegateLeaseRuntimeStatus();
  try {
    active.assertFence();
    if (inspectLock(active.operationPath) !== undefined)
      fail("DELEGATE_LEASE_PENDING_WRITE", "Cannot retire while a browser command is unresolved.");
    if (!sameOwner(active.lockPath, active.nonce, active.epoch))
      fail("DELEGATE_LEASE_FENCED", "Core owner changed; cannot release another owner's fence.");
    unlinkSync(active.lockPath);
    active = undefined;
    state = { status: "BLOCKED", reason: "Core owner voluntarily retired; process restart required to re-arm." };
    blockDelegateLeaseActivation(state.reason);
  } catch (error) {
    state = { status: "BLOCKED", reason: "Core owner retirement uncertain: " + String((error as Error).message) };
    blockDelegateLeaseActivation(state.reason);
  }
  return { ...state };
}

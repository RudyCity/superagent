/**
 * M4-B2: crash-safe, operator-reconcilable verification mutex.
 *
 * The target takeover reservation and the native human hold are NEVER removed
 * by reconciliation. The sole permission granted is to clear a defunct
 * verification mutex so a fresh, operator-authenticated Return can retry.
 *
 * An owner PID with unknown status, missing birth identity or a legacy empty
 * lock stays blocked. We do not infer process death from lock age.
 */
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { getTakeoverSessionsDir } from "./takeoverStateMachine.js";
import { readProcessStartIdentity } from "../tools/cliBridgeProcessIdentity.js";
import { observeProcessId } from "../tools/cliBridgeRecovery.js";

const SESSION_ID = /^[a-f0-9-]{36}$/;
const BIRTH = /^(?:linux:[a-f0-9-]{36}:\d+|win:\d{15,20})$/;
export interface VerificationOwner {
  sessionId: string;
  pid: number;
  creationIdentity: string | null;
  nonce: string;
  acquiredAt: number;
}
export interface VerificationTicket {
  lock: string;
  owner: VerificationOwner;
}

function lockPath(sessionId: string, dir?: string): string {
  if (!SESSION_ID.test(sessionId)) throw new Error("Invalid takeover session identity.");
  return path.join(getTakeoverSessionsDir(dir), sessionId + ".verify.lock");
}

async function readOwnerAt(lock: string): Promise<VerificationOwner> {
  try {
    const lockStat = await fsp.lstat(lock);
    if (!lockStat.isDirectory() || lockStat.isSymbolicLink()) throw new Error("Invalid lock type.");
    const file = path.join(lock, "owner.json");
    const stat = await fsp.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2048) throw new Error("Invalid owner file.");
    const owner = JSON.parse(await fsp.readFile(file, "utf8")) as VerificationOwner;
    if (!SESSION_ID.test(owner.sessionId) ||
        !Number.isSafeInteger(owner.pid) || owner.pid <= 0 ||
        !/^[a-f0-9-]{36}$/.test(owner.nonce) ||
        !Number.isSafeInteger(owner.acquiredAt) || owner.acquiredAt <= 0 ||
        (owner.creationIdentity !== null && (typeof owner.creationIdentity !== "string" ||
          !BIRTH.test(owner.creationIdentity)))) {
      throw new Error("Invalid verification lock identity.");
    }
    return owner;
  } catch {
    throw new Error("Verification lock is missing, malformed or has unknown ownership; manual investigation required.");
  }
}

export async function claimVerificationLock(sessionId: string, dir?: string): Promise<VerificationTicket> {
  const lock = lockPath(sessionId, dir);
  const owner: VerificationOwner = {
    sessionId, pid: process.pid, creationIdentity: await readProcessStartIdentity(process.pid),
    nonce: crypto.randomUUID(), acquiredAt: Date.now(),
  };
  await fsp.mkdir(path.dirname(lock), { recursive: true, mode: 0o700 });
  try {
    await fsp.mkdir(lock, { mode: 0o700 });
  } catch {
    throw new Error("Another Return to Agent verification is active or interrupted; operator reconciliation required.");
  }
  // A crash between directory creation and metadata persistence leaves a
  // deliberately unrecoverable legacy/ambiguous lock (fail closed).
  await fsp.writeFile(path.join(lock, "owner.json"), JSON.stringify(owner), {
    flag: "wx", mode: 0o600,
  });
  return { lock, owner };
}

/** Release only the matching in-process verifier; never delete an alien lock. */
export async function releaseVerificationLock(ticket: VerificationTicket): Promise<void> {
  const owner = await readOwnerAt(ticket.lock);
  if (owner.sessionId !== ticket.owner.sessionId ||
      owner.pid !== ticket.owner.pid || owner.nonce !== ticket.owner.nonce ||
      owner.creationIdentity !== ticket.owner.creationIdentity) {
    throw new Error("Verification mutex owner changed; refusing unlock.");
  }
  await fsp.unlink(path.join(ticket.lock, "owner.json"));
  await fsp.rmdir(ticket.lock);
}

/** Read-only eligibility proof. Recheck immediately before the actual
 * quarantine rename; a positive result is never a transferable unlock token. */
export async function assertStaleVerificationLockRecoverable(
  sessionId: string, dir?: string,
): Promise<VerificationOwner> {
  const owner = await readOwnerAt(lockPath(sessionId, dir));
  if (owner.sessionId !== sessionId || !owner.creationIdentity ||
      !BIRTH.test(owner.creationIdentity)) {
    throw new Error("Verification lock has no trusted process identity; manual investigation required.");
  }
  if (observeProcessId(owner.pid) !== "pid_absent") {
    throw new Error("Verification owner process is present or unverified; refusing unlock.");
  }
  return owner;
}

/** Operator reconciliation only: no browser hold/target lease is changed.
 * Caller MUST validate human authorization, session state and target lease. */
export async function reconcileStaleVerificationLock(
  sessionId: string, dir?: string,
): Promise<{ previousOwnerPid: number; recovered: true }> {
  const lock = lockPath(sessionId, dir);
  const owner = await assertStaleVerificationLockRecoverable(sessionId, dir);
  // Compare again immediately before atomic quarantine rename: no PID-age
  // shortcut, no possible removal of an actively running known verifier.
  const current = await readOwnerAt(lock);
  if (current.nonce !== owner.nonce || current.creationIdentity !== owner.creationIdentity ||
      current.pid !== owner.pid || observeProcessId(owner.pid) !== "pid_absent") {
    throw new Error("Verification mutex ownership changed; refusing unlock.");
  }
  const archived = lock + ".reconciled-" + crypto.randomUUID();
  await fsp.rename(lock, archived);
  // A quarantined old mutex is no longer advertised as active. Preserve its
  // owner evidence if removing it fails; never touch a new verification lock.
  await fsp.rm(archived, { recursive: true, force: false }).catch(() => {});
  return { previousOwnerPid: owner.pid, recovered: true };
}

/**
 * Opt-in, fail-closed durable Delegate-CDP lease journal.
 *
 * The caller must supply an ABSOLUTE, already-existing private directory and a
 * stable, separately protected 32+ byte integrity key. Neither is inferred from
 * the live Core configuration. This module never performs browser actions.
 */
import {
  closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync,
  realpathSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export type DurableDelegateRole = "observer" | "contributor";
export type DurableDelegateMember = {
  agentId: string; role: DurableDelegateRole; tokenHash: string;
  joinedAt: number; expiresAt: number;
};
export type DurableDelegateInvite = {
  inviteId: string; memberId: string; role: DurableDelegateRole;
  tokenHash: string; expiresAt: number;
};
export type DurableDelegateLease = {
  clientId: string; tabId: number; agentId: string; tokenHash: string;
  claimedAt: number; expiresAt: number; revision: number; sharing: boolean;
  participants: DurableDelegateMember[]; invitations: DurableDelegateInvite[];
  /** Process epoch in which this target was explicitly recovered or created. */
  recoveredEpoch: string;
};
export type DelegateLeaseSnapshot = {
  schema: 1; sequence: number; writerEpoch: string; writtenAt: number;
  leases: DurableDelegateLease[];
};
type SealedSnapshot = DelegateLeaseSnapshot & { mac: string };

export class DelegateLeaseJournalError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "DelegateLeaseJournalError";
  }
}
const MAX_BYTES = 512 * 1024;
const MAX_LEASES = 128;
const MAX_MEMBERS = 16;
const MAX_INVITES = 24;
const MAX_TTL = 90_000;
const MAX_INVITE_TTL = 60_000;
const HEX_64 = /^[a-f0-9]{64}$/;
const EPOCH = /^[a-f0-9]{32}$/;
const AGENT = /^[a-zA-Z0-9][a-zA-Z0-9_.:@-]{0,95}$/;
const PROFILE = /^[a-zA-Z0-9][a-zA-Z0-9_.:@|-]{0,191}$/;
const INVITE = /^[a-f0-9]{32}$/;
const FILE_NAME = "delegate-leases.v1.json";
function fail(code: string, message: string): never {
  throw new DelegateLeaseJournalError(code, message);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    fail("DELEGATE_LEASE_CORRUPT", "Invalid lease journal object.");
  }
  return value as Record<string, unknown>;
}
function shape(value: unknown, expected: string[]): Record<string, unknown> {
  const v = object(value);
  if (Object.keys(v).sort().join("|") !== [...expected].sort().join("|")) {
    fail("DELEGATE_LEASE_CORRUPT", "Unexpected lease journal fields.");
  }
  return v;
}
function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function assertTimestamp(n: unknown): asserts n is number {
  if (!integer(n)) fail("DELEGATE_LEASE_CORRUPT", "Invalid lease timestamp.");
}
function assertHash(n: unknown): asserts n is string {
  if (typeof n !== "string" || !HEX_64.test(n)) fail("DELEGATE_LEASE_CORRUPT", "Invalid capability digest.");
}
function assertAgent(n: unknown): asserts n is string {
  if (typeof n !== "string" || !AGENT.test(n)) fail("DELEGATE_LEASE_CORRUPT", "Invalid agent identity.");
}
function assertEpoch(n: unknown): asserts n is string {
  if (typeof n !== "string" || !EPOCH.test(n)) fail("DELEGATE_LEASE_CORRUPT", "Invalid writer epoch.");
}
function assertRole(n: unknown): asserts n is DurableDelegateRole {
  if (n !== "observer" && n !== "contributor") fail("DELEGATE_LEASE_CORRUPT", "Invalid participant role.");
}
function validateLeases(leases: unknown, now: number): asserts leases is DurableDelegateLease[] {
  if (!Array.isArray(leases)) {
    fail("DELEGATE_LEASE_CORRUPT", "Lease list is invalid.");
  }
  if (leases.length > MAX_LEASES) {
    fail("DELEGATE_LEASE_CORRUPT", "Lease count exceeds the journal limit.");
  }
  const targets = new Set<string>();
  for (const raw of leases) {
    const l = shape(raw, [
      "clientId", "tabId", "agentId", "tokenHash", "claimedAt", "expiresAt",
      "revision", "sharing", "participants", "invitations", "recoveredEpoch",
    ]);
    if (typeof l.clientId !== "string" || !PROFILE.test(l.clientId)
      || !integer(l.tabId) || l.tabId > 2_147_483_647) {
      fail("DELEGATE_LEASE_CORRUPT", "Invalid profile/tab identity.");
    }
    const target = JSON.stringify([l.clientId, l.tabId]);
    if (targets.has(target)) fail("DELEGATE_LEASE_CORRUPT", "Duplicate lease target.");
    targets.add(target);
    assertAgent(l.agentId);
    assertHash(l.tokenHash);
    assertEpoch(l.recoveredEpoch);
    assertTimestamp(l.claimedAt);
    assertTimestamp(l.expiresAt);
    if (l.expiresAt < l.claimedAt || l.expiresAt > now + MAX_TTL + 5_000
      || l.claimedAt > now + 5_000 || !integer(l.revision)
      || l.revision > Number.MAX_SAFE_INTEGER - 1 || typeof l.sharing !== "boolean") {
      fail("DELEGATE_LEASE_CORRUPT", "Invalid lease expiry or revision.");
    }
    if (!Array.isArray(l.participants) || !Array.isArray(l.invitations)) {
      fail("DELEGATE_LEASE_CORRUPT", "Invalid membership/invitation list.");
    }
    if (l.participants.length > MAX_MEMBERS || l.invitations.length > MAX_INVITES) {
      fail("DELEGATE_LEASE_CORRUPT", "Invalid membership/invitation count.");
    }
    const members = new Set<string>();
    for (const rawMember of l.participants) {
      const m = shape(rawMember, ["agentId", "role", "tokenHash", "joinedAt", "expiresAt"]);
      assertAgent(m.agentId);
      assertRole(m.role);
      assertHash(m.tokenHash);
      assertTimestamp(m.joinedAt);
      assertTimestamp(m.expiresAt);
      if (members.has(m.agentId) || m.agentId === l.agentId || !l.sharing
        || m.expiresAt < m.joinedAt || m.expiresAt > now + MAX_TTL + 5_000) {
        fail("DELEGATE_LEASE_CORRUPT", "Invalid shared-tab membership.");
      }
      members.add(m.agentId);
    }
    const invitations = new Set<string>();
    for (const rawInvite of l.invitations) {
      const i = shape(rawInvite, ["inviteId", "memberId", "role", "tokenHash", "expiresAt"]);
      if (typeof i.inviteId !== "string") fail("DELEGATE_LEASE_CORRUPT", "Invalid invitation identity.");
      if (!INVITE.test(i.inviteId)) fail("DELEGATE_LEASE_CORRUPT", "Invalid invitation identity.");
      assertAgent(i.memberId);
      assertRole(i.role);
      assertHash(i.tokenHash);
      assertTimestamp(i.expiresAt);
      if (invitations.has(i.inviteId) || members.has(i.memberId)
        || i.memberId === l.agentId || !l.sharing
        || i.expiresAt > now + MAX_INVITE_TTL + 5_000) {
        fail("DELEGATE_LEASE_CORRUPT", "Invalid shared-tab invitation.");
      }
      invitations.add(i.inviteId);
    }
  }
}
function sameToken(token: string, expectedHex: string): boolean {
  if (typeof token !== "string" || token.length < 20 || token.length > 256) return false;
  const digest = createHash("sha256").update(token).digest();
  return timingSafeEqual(digest, Buffer.from(expectedHex, "hex"));
}
function exactPath(directory: string): string {
  if (typeof directory !== "string" || !isAbsolute(directory)
    || basename(resolve(directory)) === "..") {
    fail("DELEGATE_LEASE_PATH", "An explicit absolute private directory is required.");
  }
  const resolved = resolve(directory);
  const st = lstatSync(resolved);
  if (!st.isDirectory() || st.isSymbolicLink()
    || realpathSync.native(resolved).toLowerCase() !== resolved.toLowerCase()) {
    fail("DELEGATE_LEASE_PATH", "Lease journal directory must not be a symlink.");
  }
  if (process.platform !== "win32" && (st.mode & 0o077) !== 0) {
    fail("DELEGATE_LEASE_PERMISSIONS", "Lease directory must have owner-only permissions.");
  }
  return join(resolved, FILE_NAME);
}
function protectedFile(path: string): void {
  if (!existsSync(path)) return;
  const st = lstatSync(path);
  if (!st.isFile() || st.isSymbolicLink()
    || st.size > MAX_BYTES || (process.platform !== "win32" && (st.mode & 0o077) !== 0)) {
    fail("DELEGATE_LEASE_PERMISSIONS", "Unsafe or oversized lease journal file.");
  }
}
export interface DelegateLeaseJournalOptions {
  directory: string;
  /** Stable external integrity secret; NEVER serialized to the journal. */
  integrityKey: Uint8Array;
  /** Injected for deterministic tests; unique per process in production. */
  epoch?: string;
  now?: () => number;
  /** Must independently prove a prior Core writer has retired; default deny. */
  previousEpochRetired?: (previousEpoch: string) => boolean;
}
export function createDelegateLeaseJournal(options: DelegateLeaseJournalOptions) {
  const key = Buffer.from(options.integrityKey ?? []);
  if (key.length < 32) fail("DELEGATE_LEASE_KEY", "A 32-byte external integrity key is required.");
  const epoch = options.epoch ?? randomBytes(16).toString("hex");
  assertEpoch(epoch);
  const now = options.now ?? Date.now;
  const path = exactPath(options.directory);
  const mac = (data: DelegateLeaseSnapshot): string =>
    createHmac("sha256", key).update(JSON.stringify(data)).digest("hex");
  function read(): DelegateLeaseSnapshot {
    exactPath(options.directory);
    protectedFile(path);
    if (!existsSync(path)) fail("DELEGATE_LEASE_MISSING", "Lease journal is absent; explicit initialization is required.");
    let data: unknown;
    try {
      const raw = readFileSync(path);
      if (raw.length > MAX_BYTES) fail("DELEGATE_LEASE_CORRUPT", "Lease journal too large.");
      data = JSON.parse(raw.toString("utf8"));
    } catch (error) {
      if (error instanceof DelegateLeaseJournalError) throw error;
      fail("DELEGATE_LEASE_CORRUPT", "Lease journal cannot be read.");
    }
    const record = shape(data, ["schema", "sequence", "writerEpoch", "writtenAt", "leases", "mac"]);
    if (record.schema !== 1) fail("DELEGATE_LEASE_CORRUPT", "Unsupported lease journal schema.");
    if (!integer(record.sequence)) fail("DELEGATE_LEASE_CORRUPT", "Invalid lease sequence.");
    if (!integer(record.writtenAt)) fail("DELEGATE_LEASE_CORRUPT", "Invalid lease timestamp.");
    assertEpoch(record.writerEpoch);
    assertHash(record.mac);
    const payload: DelegateLeaseSnapshot = {
      schema: 1, sequence: record.sequence, writerEpoch: record.writerEpoch,
      writtenAt: record.writtenAt, leases: record.leases as DurableDelegateLease[],
    };
    const actual = Buffer.from(mac(payload), "hex");
    if (!timingSafeEqual(actual, Buffer.from(record.mac, "hex"))) {
      fail("DELEGATE_LEASE_CORRUPT", "Lease journal integrity verification failed.");
    }
    validateLeases(payload.leases, now());
    return structuredClone(payload);
  }
  function locked<T>(fn: () => T): T {
    exactPath(options.directory);
    const lockPath = path + ".lock";
    let fd: number;
    try { fd = openSync(lockPath, "wx", 0o600); }
    catch { return fail("DELEGATE_LEASE_LOCKED", "Lease journal locked or lock state ambiguous."); }
    try { return fn(); }
    finally {
      closeSync(fd);
      unlinkSync(lockPath);
    }
  }
  function write(payload: DelegateLeaseSnapshot): DelegateLeaseSnapshot {
    validateLeases(payload.leases, now());
    const sealed: SealedSnapshot = { ...payload, mac: mac(payload) };
    const content = JSON.stringify(sealed);
    if (Buffer.byteLength(content) > MAX_BYTES) {
      fail("DELEGATE_LEASE_LIMIT", "Lease journal size limit exceeded.");
    }
    const temp = path + "." + randomBytes(12).toString("hex") + ".tmp";
    let fd: number | undefined;
    try {
      fd = openSync(temp, "wx", 0o600);
      writeFileSync(fd, content, { encoding: "utf8" });
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      protectedFile(path);
      renameSync(temp, path);
      if (process.platform !== "win32") {
        // Persist the directory entry as well as the file on POSIX filesystems.
        let directoryFd: number | undefined;
        try {
          directoryFd = openSync(dirname(path), "r");
          fsyncSync(directoryFd);
        } finally {
          if (directoryFd !== undefined) closeSync(directoryFd);
        }
      }
      // No browser command or in-flight action is ever serialized.
      return structuredClone(payload);
    } finally {
      if (fd !== undefined) closeSync(fd);
      if (existsSync(temp)) unlinkSync(temp);
    }
  }
  function initialize(): DelegateLeaseSnapshot {
    return locked(() => {
      if (existsSync(path)) fail("DELEGATE_LEASE_EXISTS", "Refusing to overwrite existing lease state.");
      return write({ schema: 1, sequence: 0, writerEpoch: epoch, writtenAt: now(), leases: [] });
    });
  }
  function commit(expectedSequence: number, leases: DurableDelegateLease[]): DelegateLeaseSnapshot {
    return locked(() => {
      const previous = read();
      if (previous.writerEpoch !== epoch || previous.sequence !== expectedSequence) {
        fail("DELEGATE_LEASE_STALE", "The journal is owned by another process or revision.");
      }
      return write({
        schema: 1, sequence: previous.sequence + 1, writerEpoch: epoch,
        writtenAt: now(), leases: structuredClone(leases),
      });
    });
  }
  function recover(
    clientId: string, tabId: number, agentId: string, token: string,
    expectedSequence: number,
  ): DelegateLeaseSnapshot {
    return locked(() => {
      const previous = read();
      if (previous.sequence !== expectedSequence) {
        fail("DELEGATE_LEASE_STALE", "Lease changed during recovery.");
      }
      const lease = previous.leases.find(l => l.clientId === clientId && l.tabId === tabId);
      if (!lease) fail("DELEGATE_LEASE_RECOVERY_DENIED", "No matching lease for recovery.");
      if (lease.agentId !== agentId || lease.expiresAt <= now()
        || !sameToken(token, lease.tokenHash)) {
        fail("DELEGATE_LEASE_RECOVERY_DENIED", "Recovery requires the unexpired original owner capability.");
      }
      if (previous.writerEpoch !== epoch
        && options.previousEpochRetired?.(previous.writerEpoch) !== true) {
        fail("DELEGATE_LEASE_EPOCH_AMBIGUOUS", "Previous Core epoch not proven retired; recovery denied.");
      }
      if (lease.recoveredEpoch === epoch) {
        fail("DELEGATE_LEASE_RECOVERY_REPLAY", "This owner token has already recovered this tab in this Core epoch.");
      }
      // A restart never authorizes pending/in-flight actions and never replays them.
      // Bump the tab revision: old contributor expectedRevision is fenced.
      lease.recoveredEpoch = epoch;
      lease.expiresAt = now() + MAX_TTL;
      lease.revision++;
      return write({
        schema: 1, sequence: previous.sequence + 1, writerEpoch: epoch,
        writtenAt: now(), leases: previous.leases,
      });
    });
  }
  /**
   * Allow a new Core epoch to start fresh ONLY when every prior claim expired
   * and the previous writer was independently verified retired. Never break
   * an unexpired owner lease just because its owner is unavailable.
   */
  function retireExpired(expectedSequence: number): DelegateLeaseSnapshot {
    return locked(() => {
      const previous = read();
      if (previous.sequence !== expectedSequence) {
        fail("DELEGATE_LEASE_STALE", "Lease changed while retiring expired state.");
      }
      if (previous.leases.some(l => l.expiresAt > now())) {
        fail("DELEGATE_LEASE_ACTIVE", "An unexpired owner must recover with its original token.");
      }
      if (previous.writerEpoch !== epoch
        && options.previousEpochRetired?.(previous.writerEpoch) !== true) {
        fail("DELEGATE_LEASE_EPOCH_AMBIGUOUS", "Previous Core epoch not proven retired.");
      }
      return write({
        schema: 1, sequence: previous.sequence + 1,
        writerEpoch: epoch, writtenAt: now(), leases: [],
      });
    });
  }
  return { epoch, path, read, initialize, commit, recover, retireExpired };
}
export type DelegateLeaseJournal = ReturnType<typeof createDelegateLeaseJournal>;

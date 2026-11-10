/** Native-authenticated human/agent handoff for an existing managed CDP target.
 * No cookies or owner capabilities are persisted. Manual ownership is tied to
 * the verified browser fingerprint and never expires merely on registry TTL.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { join } from "node:path";
import { cdpGatewayRoot, withCdpTargetCoordination, listCdpSessions } from "./chromeCdpSessionManager.js";
import { browserFingerprintForPort, listManagedBrowserRegistrations, validateManagedBrowserRegistration } from "./managedBrowserRegistry.js";
import { discoverCdpPages } from "./chromeCdpTools.js";
import { readTakeoverTargetReservation } from "../browserTakeover/takeoverTargetLease.js";

export type ManagedControlMode = "human" | "agent";
type HumanHold = { port: number; targetId: string; fingerprint: string; generation: string; mode: "human" };
const folder = () => join(cdpGatewayRoot(), "human-holds");
const fileFor = (port: number, targetId: string) =>
  join(folder(), createHash("sha256").update(port + ":" + targetId).digest("hex") + ".json");

/** Internal-only proof supplied after operator-token verification.
 * HTTP JSON bodies cannot supply this optional second argument. */
export interface VerifiedTakeoverRelease {
  takeoverSessionId: string;
  takeoverSessionsDir?: string;
}

export async function setManagedBrowserControl(
  input: unknown, verifiedTakeoverRelease?: VerifiedTakeoverRelease,
  expectedRevision?: number,
): Promise<{ mode: ManagedControlMode }> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid control request.");
  const body = input as Record<string, unknown>;
  if (body.mode !== "human" && body.mode !== "agent") throw new Error("Invalid control mode.");
  const { mode, ...identity } = body;
  const verified = validateManagedBrowserRegistration(identity);
  return withCdpTargetCoordination(verified.port, verified.targetId, async () => {
    const registered = listManagedBrowserRegistrations().find(r =>
      r.port === verified.port && r.targetId === verified.targetId &&
      r.generation === verified.generation && r.profileId === verified.profileId &&
      r.browserFingerprint === verified.browserFingerprint);
    if (!registered) throw new Error("Managed target must be registered with Core before handoff.");
    if (expectedRevision !== undefined) {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
        throw new Error("Invalid expected CDP revision.");
      const claimed = (await listCdpSessions()).find(s =>
        s.port === verified.port && s.targetId === verified.targetId);
      if (!claimed || claimed.revision !== expectedRevision)
        throw new Error("Managed CDP revision changed; refresh before handoff.");
    }
    if (await browserFingerprintForPort(verified.port) !== verified.browserFingerprint)
      throw new Error("Owned browser identity changed; refresh pairing.");
    if (!(await discoverCdpPages(verified.port)).some(page => page.targetId === verified.targetId))
      throw new Error("Managed browser tab closed or changed.");
    // A human-control transition invalidates existing replay approvals even
    // when CDP lease revision does not change. Failure leaves the hold intact.
    const { revokeReplayApprovalsForTarget } = await import("./chromeCdpReplayApprovals.js");
    await revokeReplayApprovalsForTarget(verified.port, verified.targetId);
    const file = fileFor(verified.port, verified.targetId);
    mkdirSync(folder(), { recursive: true, mode: 0o700 });
    if (mode === "agent") {
      // A desktop handoff must not bypass a reserved human takeover. Only
      // operator-authorized internal Return may release its matching session.
      const reservation = await readTakeoverTargetReservation(
        verified.port, verified.targetId, verifiedTakeoverRelease?.takeoverSessionsDir
      );
      if (reservation && reservation.sessionId !== verifiedTakeoverRelease?.takeoverSessionId) {
        throw new Error("Browser takeover reservation requires verified operator Return to Agent.");
      }
      if (!reservation && verifiedTakeoverRelease) {
        throw new Error("Verified takeover reservation is missing; refusing release.");
      }
      // Only the same live identity may release an existing human hold.
      const prior = loadHold(verified.port, verified.targetId);
      if (prior && (prior.fingerprint !== verified.browserFingerprint || prior.generation !== verified.generation))
        throw new Error("Prior manual control belongs to another browser generation.");
      rmSync(file, { force: true });
    } else {
      const hold: HumanHold = {
        port: verified.port, targetId: verified.targetId,
        generation: verified.generation, fingerprint: verified.browserFingerprint, mode: "human",
      };
      const temp = file + "." + randomUUID() + ".tmp";
      try { writeFileSync(temp, JSON.stringify(hold), { flag: "wx", mode: 0o600 }); renameSync(temp, file); }
      finally { rmSync(temp, { force: true }); }
    }
    return { mode };
  });
}
function loadHold(port: number, targetId: string): HumanHold | null {
  const path = fileFor(port, targetId);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    if (raw.length > 1024) throw new Error("Oversized control state.");
    const v = JSON.parse(raw) as HumanHold;
    if (v.mode !== "human" || v.port !== port || v.targetId !== targetId ||
      !/^[a-f0-9]{64}$/.test(v.fingerprint) || typeof v.generation !== "string")
      throw new Error("Invalid control state.");
    return v;
  } catch { throw new Error("Managed browser control state cannot be verified; refusing agent mutation."); }
}
/** Operator-facing status only; no control capabilities or browser data exposed. */
export async function readManagedControlStatus(
  port: number, targetId: string,
): Promise<"human" | "agent"> {
  if (!Number.isInteger(port) || port < 1024 || port > 65535 ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(targetId)) throw new Error("Invalid target.");
  if (loadHold(port, targetId)) return "human";
  if (await readTakeoverTargetReservation(port, targetId)) return "human";
  return "agent";
}

/** Called inside the per-target CDP write lock. Any live human hold blocks writes. */
export async function assertManagedAgentMayWrite(port: number, targetId: string): Promise<void> {
  const hold = loadHold(port, targetId);
  if (!hold) {
    // A durable reservation also fences writes when the native hold is lost
    // after restart or between release and lease cleanup.
    const reservation = await readTakeoverTargetReservation(port, targetId);
    if (reservation) throw new Error("Human takeover reservation still owns this tab; agent writes blocked.");
    return;
  }
  // Stale/forked browser identities fail closed: a new native handoff is required.
  let fingerprint: string;
  try { fingerprint = await browserFingerprintForPort(port); }
  catch { throw new Error("Browser identity unavailable while human has control."); }
  if (fingerprint !== hold.fingerprint)
    throw new Error("Managed browser identity changed; a fresh handoff is required.");
  throw new Error("Human has control of this tab. Wait for Return to Agent.");
}

import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { getTakeoverSessionsDir } from "./takeoverStateMachine.js";

/**
 * A durable, atomic per-CDP-target takeover reservation. Its directory is held
 * until the verified operator Return to Agent succeeds. Crash, cancellation,
 * expiry, or an ambiguous owner leaves the reservation locked (fail closed).
 *
 * This is distinct from the native CDP human hold: the hold fences agent
 * writes, while this reservation prevents competing human takeover sessions.
 */
function reservationPath(port: number, targetId: string, customDir?: string): string {
  const digest = crypto.createHash("sha256").update(`${port}:\0${targetId}`).digest("hex");
  return path.join(getTakeoverSessionsDir(customDir), `.target-${digest}.lock`);
}

interface TargetReservation {
  sessionId: string;
  targetId: string;
  port: number;
}

export async function claimTakeoverTarget(
  port: number, targetId: string, sessionId: string, customDir?: string
): Promise<void> {
  if (!Number.isInteger(port) || port < 1024 || port > 65535 ||
      !targetId || !/^[a-f0-9-]{36}$/.test(sessionId)) {
    throw new Error("Invalid takeover target reservation identity.");
  }
  const directory = getTakeoverSessionsDir(customDir);
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = reservationPath(port, targetId, customDir);
  try {
    await fsp.mkdir(lock, { mode: 0o700 });
  } catch (error: any) {
    if (error?.code === "EEXIST") {
      throw new Error("Another takeover already reserves this browser tab; operator reconciliation is required.");
    }
    throw error;
  }
  const owner: TargetReservation = { port, targetId, sessionId };
  try {
    await fsp.writeFile(path.join(lock, "owner.json"), JSON.stringify(owner), { flag: "wx", mode: 0o600 });
  } catch (error) {
    // This request created the directory and no hold exists yet. On normal
    // write failures remove our empty directory; a crash leaves a safe lock.
    await fsp.rmdir(lock).catch(() => {});
    throw error;
  }
}

export async function releaseTakeoverTarget(
  port: number, targetId: string, sessionId: string, customDir?: string
): Promise<void> {
  const lock = reservationPath(port, targetId, customDir);
  const ownerPath = path.join(lock, "owner.json");
  let owner: TargetReservation;
  try {
    owner = JSON.parse(await fsp.readFile(ownerPath, "utf8")) as TargetReservation;
  } catch {
    throw new Error("Takeover reservation missing or unreadable; operator reconciliation required.");
  }
  if (owner.sessionId !== sessionId || owner.port !== port || owner.targetId !== targetId) {
    throw new Error("Takeover reservation belongs to another session; refusing release.");
  }
  await fsp.unlink(ownerPath);
  await fsp.rmdir(lock);
}

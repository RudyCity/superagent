/** Cross-process, local managed browser registration announcements.
 * Directory entries contain no CDP owner capability. Claims remain canonical in
 * chromeCdpSessionManager. Native T-Line alone authenticates directly to Core.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cdpGatewayRoot, withCdpGatewayRegistryLock } from "./chromeCdpSessionManager.js";
import { discoverCdpPages } from "./chromeCdpTools.js";

export type ManagedBrowserRegistration = {
  profileId: string; generation: string; port: number; targetId: string;
  browserFingerprint: string; expiresAt: number; registeredAt: number;
};
const TTL_MS = 90_000;
const root = () => join(cdpGatewayRoot(), "managed-runtimes");
const keyFor = (port: number, targetId: string) => createHash("sha256").update(port + ":" + targetId).digest("hex");
const pathFor = (port: number, targetId: string) => join(root(), keyFor(port, targetId) + ".json");

export function validateManagedBrowserRegistration(input: unknown): {
  profileId: string; generation: string; port: number; targetId: string;
  browserFingerprint: string;
} {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid registration body.");
  const body = input as Record<string, unknown>;
  if (typeof body.profileId !== "string" || !/^[a-z0-9][a-z0-9_-]{0,39}$/.test(body.profileId) ||
      typeof body.generation !== "string" || !/^[0-9]+-[0-9]{8,32}$/.test(body.generation) ||
      !Number.isInteger(body.port) || Number(body.port) < 1024 || Number(body.port) > 65535 ||
      typeof body.targetId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(body.targetId) ||
      typeof body.browserFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(body.browserFingerprint) ||
      Object.keys(body).some(k => !["profileId", "generation", "port", "targetId", "browserFingerprint"].includes(k))) {
    throw new Error("Invalid managed browser registration.");
  }
  return { profileId: body.profileId, generation: body.generation, port: body.port as number,
    targetId: body.targetId, browserFingerprint: body.browserFingerprint };
}
function readOne(path: string, now: number): ManagedBrowserRegistration | null {
  try {
    const meta = lstatSync(path);
    if (!meta.isFile() || meta.isSymbolicLink() || meta.size > 2048) return null;
    const row = JSON.parse(readFileSync(path, "utf8"));
    const identity = validateManagedBrowserRegistration({
      profileId: row.profileId, generation: row.generation, port: row.port,
      targetId: row.targetId, browserFingerprint: row.browserFingerprint,
    });
    if (typeof row.registeredAt !== "number" || row.registeredAt > now ||
        !Number.isFinite(row.expiresAt) || row.expiresAt <= now || row.expiresAt - row.registeredAt > TTL_MS ||
        path !== pathFor(identity.port, identity.targetId)) return null;
    return { ...identity, registeredAt: row.registeredAt, expiresAt: row.expiresAt };
  } catch { return null; }
}
export function listManagedBrowserRegistrations(now = Date.now()): ManagedBrowserRegistration[] {
  if (!existsSync(root())) return [];
  const result: ManagedBrowserRegistration[] = [];
  for (const name of readdirSync(root()).filter(n => /^[a-f0-9]{64}\.json$/.test(n)).slice(0, 128)) {
    const path = join(root(), name);
    const row = readOne(path, now);
    if (row) result.push(row);
    else { try { rmSync(path, { force: true }); } catch {} }
    if (result.length >= 32) break;
  }
  return result;
}
/** No remote-supplied URL or host is used. Browser websocket ID is hashed
 * before registry persistence; a reused CDP port is not a surviving runtime. */
export async function browserFingerprintForPort(port: number): Promise<string> {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid CDP port.");
  const response = await fetch("http://127.0.0.1:" + port + "/json/version", {
    signal: AbortSignal.timeout(1500), redirect: "error",
  });
  if (!response.ok) throw new Error("Local Chrome browser identity endpoint unavailable.");
  const json = await response.json() as { webSocketDebuggerUrl?: unknown };
  if (typeof json.webSocketDebuggerUrl !== "string") throw new Error("Missing Chrome browser identity.");
  const ws = new URL(json.webSocketDebuggerUrl);
  if (ws.protocol !== "ws:" || ws.hostname !== "127.0.0.1" ||
      Number(ws.port) !== port || ws.username || ws.password ||
      !/^\/devtools\/browser\/[a-fA-F0-9-]{36}$/.test(ws.pathname)) {
    throw new Error("Untrusted local Chrome browser identity.");
  }
  return createHash("sha256").update(ws.pathname).digest("hex");
}
/** Enforce the browser identity for any agent action that was originally
 * paired to a managed runtime. Unregistered external Chrome is unaffected. */
export async function currentManagedBrowserFingerprint(
  port: number, targetId: string,
  verify: (port: number) => Promise<string> = browserFingerprintForPort,
): Promise<string | null> {
  const registration = listManagedBrowserRegistrations().find(
    row => row.port === port && row.targetId === targetId,
  );
  if (!registration) return null;
  const observed = await verify(port);
  if (observed !== registration.browserFingerprint) {
    throw new Error("Managed browser runtime changed; a fresh desktop pairing is required.");
  }
  return observed;
}
export async function listVerifiedManagedBrowserRegistrations(
  now = Date.now(),
  verify: (port: number) => Promise<string> = browserFingerprintForPort,
): Promise<Omit<ManagedBrowserRegistration, "browserFingerprint">[]> {
  const registrations = listManagedBrowserRegistrations(now);
  const verified = await Promise.all(registrations.map(async row => {
    try {
      if (await verify(row.port) !== row.browserFingerprint) return null;
      const { browserFingerprint: _privateFingerprint, ...publicRow } = row;
      return publicRow;
    } catch { return null; }
  }));
  return verified.filter((row): row is Omit<ManagedBrowserRegistration, "browserFingerprint"> => row !== null);
}
export async function registerManagedBrowser(
  input: unknown,
  discover: typeof discoverCdpPages = discoverCdpPages,
  now = Date.now(),
  verify: (port: number) => Promise<string> = browserFingerprintForPort,
): Promise<ManagedBrowserRegistration> {
  const valid = validateManagedBrowserRegistration(input);
  if (await verify(valid.port) !== valid.browserFingerprint) {
    throw new Error("Managed browser identity changed; stale or reused CDP port.");
  }
  const pages = await discover(valid.port);
  if (!pages.some(page => page.targetId === valid.targetId)) {
    throw new Error("Managed browser CDP target is no longer available.");
  }
  return withCdpGatewayRegistryLock(async () => {
    const existing = listManagedBrowserRegistrations(now);
    const previous = existing.find(r => r.port === valid.port && r.targetId === valid.targetId);
    if (previous && (previous.profileId !== valid.profileId || previous.generation !== valid.generation ||
        previous.browserFingerprint !== valid.browserFingerprint)) {
      throw new Error("Managed browser registration generation conflict.");
    }
    if (existing.length >= 32 && !previous) throw new Error("Managed browser registry capacity reached.");
    const registration = { ...valid, registeredAt: now, expiresAt: now + TTL_MS };
    mkdirSync(root(), { recursive: true, mode: 0o700 });
    const destination = pathFor(valid.port, valid.targetId);
    const temp = destination + "." + randomUUID() + ".tmp";
    try {
      writeFileSync(temp, JSON.stringify(registration), { flag: "wx", mode: 0o600 });
      renameSync(temp, destination);
    } finally { try { rmSync(temp, { force: true }); } catch {} }
    return { ...registration };
  });
}
export function resetManagedBrowserRegistrationsForTests(): void {
  rmSync(root(), { recursive: true, force: true });
}

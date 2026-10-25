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
  expiresAt: number; registeredAt: number;
};
const TTL_MS = 90_000;
const root = () => join(cdpGatewayRoot(), "managed-runtimes");
const keyFor = (port: number, targetId: string) => createHash("sha256").update(port + ":" + targetId).digest("hex");
const pathFor = (port: number, targetId: string) => join(root(), keyFor(port, targetId) + ".json");

export function validateManagedBrowserRegistration(input: unknown): {
  profileId: string; generation: string; port: number; targetId: string;
} {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid registration body.");
  const body = input as Record<string, unknown>;
  if (typeof body.profileId !== "string" || !/^[a-z0-9][a-z0-9_-]{0,39}$/.test(body.profileId) ||
      typeof body.generation !== "string" || !/^[0-9]+-[0-9]{8,32}$/.test(body.generation) ||
      !Number.isInteger(body.port) || Number(body.port) < 1024 || Number(body.port) > 65535 ||
      typeof body.targetId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(body.targetId) ||
      Object.keys(body).some(k => !["profileId", "generation", "port", "targetId"].includes(k))) {
    throw new Error("Invalid managed browser registration.");
  }
  return { profileId: body.profileId, generation: body.generation, port: body.port as number, targetId: body.targetId };
}
function readOne(path: string, now: number): ManagedBrowserRegistration | null {
  try {
    const meta = lstatSync(path);
    if (!meta.isFile() || meta.isSymbolicLink() || meta.size > 2048) return null;
    const row = JSON.parse(readFileSync(path, "utf8"));
    const identity = validateManagedBrowserRegistration({
      profileId: row.profileId, generation: row.generation, port: row.port, targetId: row.targetId,
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
export async function registerManagedBrowser(
  input: unknown,
  discover: typeof discoverCdpPages = discoverCdpPages,
  now = Date.now(),
): Promise<ManagedBrowserRegistration> {
  const valid = validateManagedBrowserRegistration(input);
  const pages = await discover(valid.port);
  if (!pages.some(page => page.targetId === valid.targetId)) {
    throw new Error("Managed browser CDP target is no longer available.");
  }
  return withCdpGatewayRegistryLock(async () => {
    const existing = listManagedBrowserRegistrations(now);
    const previous = existing.find(r => r.port === valid.port && r.targetId === valid.targetId);
    if (previous && (previous.profileId !== valid.profileId || previous.generation !== valid.generation)) {
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

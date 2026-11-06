import fs from "node:fs";
import path from "node:path";
import { getRootConfigDir } from "../config/paths.js";

const DEFAULT_DELEGATE_CORE_PORT = 7888;
const DISCOVERY_RE = /^core-supervisor-(\d{4,5})\.json$/;

function validPort(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1024 && Number(value) <= 65535;
}

function pidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function configuredPort(): number | undefined {
  for (const key of ["SUPERAGENT_CORE_PUBLIC_PORT", "SUPERAGENT_CORE_PORT"]) {
    const raw = process.env[key];
    if (raw === undefined || raw === "") continue;
    const port = Number(raw);
    if (!validPort(port)) throw new Error("DELEGATE_CORE_PORT_INVALID");
    return port;
  }
  return undefined;
}

function liveDiscoveryPorts(root = getRootConfigDir()): number[] {
  let names: string[];
  try { names = fs.readdirSync(root); }
  catch { return []; }
  const ports = new Set<number>();
  for (const name of names) {
    const match = DISCOVERY_RE.exec(name);
    if (!match) continue;
    const file = path.join(root, name);
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > 4096) continue;
      const value = JSON.parse(fs.readFileSync(file, "utf8")) as {
        publicPort?: unknown; supervisorPid?: unknown; controlPort?: unknown; controlToken?: unknown;
      };
      const port = Number(value.publicPort);
      const pid = Number(value.supervisorPid);
      if (!validPort(port) || port !== Number(match[1]) ||
          !Number.isSafeInteger(pid) || pid <= 0 ||
          !validPort(Number(value.controlPort)) ||
          typeof value.controlToken !== "string" || !/^[a-f0-9]{64}$/.test(value.controlToken) ||
          !pidAlive(pid)) continue;
      ports.add(port);
    } catch {
      // Ignore malformed/stale candidates. Ambiguity is handled below.
    }
  }
  return [...ports].sort((a, b) => a - b);
}

/**
 * Resolve the Core endpoint used by MCP -> Core Delegate forwarding.
 *
 * Precedence:
 * 1) explicit process configuration;
 * 2) exactly one live authenticated supervisor discovery record;
 * 3) production default 7888 for backward compatibility.
 *
 * Multiple live Core supervisors require an explicit port so a Delegate
 * operation can never be routed to an arbitrary owner.
 */
export function resolveDelegateCorePort(root = getRootConfigDir()): number {
  const explicit = configuredPort();
  if (explicit !== undefined) return explicit;
  const discovered = liveDiscoveryPorts(root);
  if (discovered.length === 1) return discovered[0];
  if (discovered.length > 1) throw new Error("DELEGATE_CORE_SELECTION_REQUIRED");
  return DEFAULT_DELEGATE_CORE_PORT;
}

export function delegateCoreEndpoint(root = getRootConfigDir()): { port: number; baseUrl: string } {
  const port = resolveDelegateCorePort(root);
  return { port, baseUrl: "http://127.0.0.1:" + port };
}

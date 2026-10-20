/**
 * Authenticated T-Line / SuperAgent capability contract.
 * Declares runtime registry names separately from HTTP actions: listing a slash
 * command NEVER implies it can execute through the desktop bridge.
 */
import { registry } from "../commands/index.js";

export const TLINE_CAPABILITY_CONTRACT_VERSION = 1 as const;
export const TLINE_HTTP_ACTIONS = [
  { id: "daemon.status", method: "GET", path: "/api/daemon/status", access: "read" },

  { id: "gateway.status", method: "GET", path: "/api/gateway/status", access: "read" },
] as const;

export function buildTlineCapabilityManifest(version: string) {
  const commands = registry.getAll()
    .map((c) => ({
      name: c.name,
      aliases: [...(c.aliases || [])].filter((a) => /^[a-z][a-z0-9-]*$/.test(a)),
      description: c.description,
      desktopExecution: "cli-only" as const,
    }))
    .filter((c) => /^[a-z][a-z0-9-]*$/.test(c.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    schemaVersion: TLINE_CAPABILITY_CONTRACT_VERSION,
    server: "superagent",
    version,
    commands,
    httpActions: TLINE_HTTP_ACTIONS,
    note: "Command names describe the CLI registry; HTTP actions are independently allowlisted. No general shell or arbitrary slash executor is exposed.",
  };
}

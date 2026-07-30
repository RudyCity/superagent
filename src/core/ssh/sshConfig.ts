import fs from "fs";
import os from "os";
import path from "path";
import { sshLogger } from "./sshLogger.js";

export interface SshConfigEntry {
  host: string;
  hostname?: string;
  port?: number;
  user?: string;
  identityFile?: string;
  proxyJump?: string;
  compression?: boolean;
  forwardAgent?: boolean;
}

export function parseSshConfig(): Map<string, SshConfigEntry> {
  const entries = new Map<string, SshConfigEntry>();
  try {
    const configPath = path.join(os.homedir(), ".ssh", "config");
    if (!fs.existsSync(configPath)) return entries;
    const content = fs.readFileSync(configPath, "utf-8");
    let currentHost: string | null = null;
    let currentEntry: SshConfigEntry | null = null;
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const match = trimmed.match(/^(\S+)\s+(.+)$/);
      if (!match) continue;
      const key = match[1].toLowerCase();
      const value = match[2].trim();
      if (key === "host") {
        if (currentHost && currentEntry) entries.set(currentHost, currentEntry);
        currentHost = value;
        currentEntry = { host: value };
      } else if (currentEntry) {
        switch (key) {
          case "hostname": currentEntry.hostname = value; break;
          case "port": currentEntry.port = parseInt(value, 10); break;
          case "user": currentEntry.user = value; break;
          case "identityfile": currentEntry.identityFile = value.replace(/^~/, os.homedir()); break;
          case "proxyjump": currentEntry.proxyJump = value; break;
          case "compression": currentEntry.compression = value === "yes"; break;
          case "forwardagent": currentEntry.forwardAgent = value === "yes"; break;
        }
      }
    }
    if (currentHost && currentEntry) entries.set(currentHost, currentEntry);
    sshLogger.info("ssh_config", `parsed ${entries.size} host entries from ~/.ssh/config`);
  } catch (err) {
    sshLogger.warn("ssh_config", `failed to parse ~/.ssh/config: ${(err as Error).message}`);
  }
  return entries;
}

export function resolveHostAlias(host: string): SshConfigEntry | null {
  const config = parseSshConfig();
  let entry = config.get(host);
  if (!entry) {
    for (const [pattern, e] of config.entries()) {
      if (pattern.includes("*")) {
        const regex = new RegExp("^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$");
        if (regex.test(host)) { entry = e; break; }
      }
    }
  }
  return entry || null;
}

export function parseProxyJump(proxyJump: string): { host: string; port: number; user: string } | null {
  try {
    let user = "root";
    let hostPort = proxyJump.trim();
    if (hostPort.includes("@")) {
      const atIdx = hostPort.indexOf("@");
      user = hostPort.slice(0, atIdx);
      hostPort = hostPort.slice(atIdx + 1);
    }
    let host = hostPort;
    let port = 22;
    if (hostPort.includes(":")) {
      const portIdx = hostPort.lastIndexOf(":");
      host = hostPort.slice(0, portIdx);
      const parsedPort = parseInt(hostPort.slice(portIdx + 1), 10);
      port = isNaN(parsedPort) ? 22 : parsedPort;
    }
    if (!host) return null;
    return { host, port, user };
  } catch { return null; }
}

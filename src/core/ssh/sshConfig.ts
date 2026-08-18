import fs from "fs";
import os from "os";
import path from "path";
import ssh2 from "ssh2";
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

/** Find default SSH private key — scans standard names first, then *.pem and other key files in ~/.ssh/, validating parsability */
export function findDefaultPrivateKey(): Buffer | undefined {
  const sshDir = path.join(os.homedir(), ".ssh");
  const standardKeys = ["id_ed25519", "id_rsa", "id_ecdsa"];

  // Helper to validate with ssh2 utils
  const tryLoadKey = (filePath: string): Buffer | undefined => {
    try {
      const buf = fs.readFileSync(filePath);
      const utils = ssh2.utils || (ssh2 as any).default?.utils;
      const parsed = utils ? utils.parseKey(buf) : undefined;
      if (parsed && !(parsed instanceof Error)) {
        return buf;
      }
    } catch {}
    return undefined;
  };

  // Priority 1: Standard key names
  for (const key of standardKeys) {
    const keyPath = path.join(sshDir, key);
    if (fs.existsSync(keyPath)) {
      const validBuf = tryLoadKey(keyPath);
      if (validBuf) return validBuf;
    }
  }

  // Priority 2: Scan all files in ~/.ssh/ for any parsable private key file
  try {
    if (!fs.existsSync(sshDir)) return undefined;
    const files = fs.readdirSync(sshDir);
    for (const file of files) {
      if (
        file.endsWith(".pub") ||
        file === "known_hosts" ||
        file === "known_hosts.old" ||
        file === "config" ||
        file === "authorized_keys"
      ) {
        continue;
      }
      const filePath = path.join(sshDir, file);
      try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile() || stat.size > 32768) continue;
        const validBuf = tryLoadKey(filePath);
        if (validBuf) {
          sshLogger.info("key_discovery", `found valid SSH private key: ${file}`);
          return validBuf;
        }
      } catch {}
    }
  } catch {}

  sshLogger.warn("key_discovery", "no valid SSH private key found in ~/.ssh/");
  return undefined;
}


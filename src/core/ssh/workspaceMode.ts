export interface SshWorkspaceConfig {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKeyPath?: string;
  remoteCwd: string;
  /** Connection timeout in ms (default 15000) */
  readyTimeout?: number;
  /** Enable SSH compression (default false) */
  compression?: boolean;
  /** Enable SSH agent forwarding (default false) */
  agentForward?: boolean;
  /** ProxyJump / bastion host (e.g., "user@bastion:2222") */
  proxyJump?: string;
  /** Bandwidth throttle limit in bytes/sec (0 = unlimited) */
  bandwidthLimit?: number;
}

import { sshLogger } from "./sshLogger.js";

class WorkspaceModeManager {
  private mode: "local" | "ssh-proxy" = "local";
  private config?: SshWorkspaceConfig;

  public setSshMode(config: SshWorkspaceConfig) {
    this.mode = "ssh-proxy";
    this.config = config;
    sshLogger.info("workspace.mode", "switched to ssh-proxy", {
      host: config.host,
      user: config.username,
      remoteCwd: config.remoteCwd,
    });
  }

  public setLocalMode() {
    const prev = this.mode;
    this.mode = "local";
    this.config = undefined;
    sshLogger.info("workspace.mode", "switched to local", { meta: { previous: prev } });
  }

  public getMode(): "local" | "ssh-proxy" {
    return this.mode;
  }

  public getConfig(): SshWorkspaceConfig | undefined {
    return this.config;
  }

  public isSsh(): boolean {
    return this.mode === "ssh-proxy";
  }

  public parseSshTarget(target: string): SshWorkspaceConfig | null {
    // Format 1: ssh://user@host[:port]/path
    // Format 2: user@host[:port]:/path
    try {
      let cleanTarget = target.trim();
      if (cleanTarget.startsWith("ssh://")) {
        cleanTarget = cleanTarget.slice(6);
      }

      let userHostPort = "";
      let remotePath = "";

      if (cleanTarget.includes(":/")) {
        const colonIdx = cleanTarget.indexOf(":/");
        userHostPort = cleanTarget.slice(0, colonIdx);
        remotePath = cleanTarget.slice(colonIdx + 1);
      } else if (cleanTarget.includes("/")) {
        const slashIdx = cleanTarget.indexOf("/");
        userHostPort = cleanTarget.slice(0, slashIdx);
        remotePath = cleanTarget.slice(slashIdx);
      } else {
        return null;
      }

      let username = "root";
      let hostPort = userHostPort;

      if (userHostPort.includes("@")) {
        const atIdx = userHostPort.indexOf("@");
        username = userHostPort.slice(0, atIdx);
        hostPort = userHostPort.slice(atIdx + 1);
      }

      let host = hostPort;
      let port = 22;

      if (hostPort.includes(":")) {
        const portIdx = hostPort.lastIndexOf(":");
        host = hostPort.slice(0, portIdx);
        const parsedPort = parseInt(hostPort.slice(portIdx + 1), 10);
        // Use isNaN check instead of || to handle port 0 correctly
        port = isNaN(parsedPort) ? 22 : parsedPort;
      }

      let privateKeyPath: string | undefined;
      let readyTimeout: number | undefined;
      let compression: boolean | undefined;
      let agentForward: boolean | undefined;
      let proxyJump: string | undefined;
      let bandwidthLimit: number | undefined;

      if (remotePath.includes("?")) {
        const [basePath, queryString] = remotePath.split("?");
        remotePath = basePath;
        const params = new URLSearchParams(queryString);
        if (params.has("key")) {
          privateKeyPath = params.get("key") || undefined;
        }
        if (params.has("timeout")) {
          const t = parseInt(params.get("timeout")!, 10);
          if (!isNaN(t) && t > 0) readyTimeout = t;
        }
        if (params.has("compress")) {
          compression = params.get("compress") === "yes";
        }
        if (params.has("agentForward")) {
          agentForward = params.get("agentForward") === "yes";
        }
        if (params.has("proxyJump")) {
          proxyJump = params.get("proxyJump") || undefined;
        }
        if (params.has("bwlimit")) {
          const bw = parseInt(params.get("bwlimit")!, 10);
          if (!isNaN(bw) && bw >= 0) bandwidthLimit = bw;
        }
      }

      if (!host || !remotePath) return null;

      // Q1: Validate host format — must be a valid hostname or IP address
      const hostnameRegex = /^[a-zA-Z0-9]([a-zA-Z0-9\-\.]*[a-zA-Z0-9])?$/;
      const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
      const ipv6Regex = /^\[?[a-fA-F0-9:]+\]?$/;
      const isValidHost = hostnameRegex.test(host) || ipv4Regex.test(host) || ipv6Regex.test(host);
      if (!isValidHost) return null;

      // Q1: Validate port range — must be between 1 and 65535
      if (port < 1 || port > 65535) return null;

      // Validation: remoteCwd must be non-empty, start with '/', and have no invalid segments.
      const normalizedRemote = remotePath.startsWith("/") ? remotePath : `/${remotePath}`;
      if (normalizedRemote === "/" || normalizedRemote.includes("\0") || normalizedRemote.includes("//")) {
        return null;
      }

      return {
        host,
        port,
        username: username || "root",
        privateKeyPath,
        remoteCwd: normalizedRemote,
        readyTimeout,
        compression,
        agentForward,
        proxyJump,
        bandwidthLimit,
      };
    } catch {
      return null;
    }
  }
}

export const workspaceMode = new WorkspaceModeManager();
export interface SshWorkspaceConfig {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKeyPath?: string;
  remoteCwd: string;
}

class WorkspaceModeManager {
  private mode: "local" | "ssh-proxy" = "local";
  private config?: SshWorkspaceConfig;

  public setSshMode(config: SshWorkspaceConfig) {
    this.mode = "ssh-proxy";
    this.config = config;
  }

  public setLocalMode() {
    this.mode = "local";
    this.config = undefined;
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
        port = parseInt(hostPort.slice(portIdx + 1), 10) || 22;
      }

      let privateKeyPath: string | undefined;
      if (remotePath.includes("?")) {
        const [basePath, queryString] = remotePath.split("?");
        remotePath = basePath;
        const params = new URLSearchParams(queryString);
        if (params.has("key")) {
          privateKeyPath = params.get("key") || undefined;
        }
      }

      if (!host || !remotePath) return null;

      return {
        host,
        port,
        username,
        privateKeyPath,
        remoteCwd: remotePath.startsWith("/") ? remotePath : `/${remotePath}`,
      };
    } catch {
      return null;
    }
  }
}

export const workspaceMode = new WorkspaceModeManager();

import { spawn, execSync, ChildProcess } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import { execa } from "execa";
import { logE2E } from "../utils/unifiedLogger.js";
import { loadRemoteAgentConfig, updateRemoteAgentConfig } from "./config.js";

export interface TunnelMetadata {
  pid: number;
  publicUrl: string;
  wssUrl: string;
  localUrl: string;
  port: number;
  startedAt: number;
}

export interface TunnelStatus {
  isRunning: boolean;
  publicUrl?: string;
  wssUrl?: string;
  localUrl?: string;
  pid?: number;
  port?: number;
  startedAt?: number;
  uptimeSeconds?: number;
  error?: string;
}

export interface StartTunnelOptions {
  port?: number;
  host?: string;
  path?: string;
  timeoutMs?: number;
  customConfigPath?: string;
  onLog?: (line: string) => void;
  onUrlDetected?: (publicUrl: string, wssUrl: string) => void;
}

export function getTunnelStateFile(port?: number): string {
  const dir = path.join(os.homedir(), ".superagent-r");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (port) {
    return path.join(dir, `tunnel-${port}.json`);
  }
  return path.join(dir, "tunnel.json");
}

export function saveTunnelState(meta: TunnelMetadata, port?: number): void {
  try {
    const targetPort = port || meta.port;
    if (targetPort) {
      const portFile = getTunnelStateFile(targetPort);
      fs.writeFileSync(portFile, JSON.stringify(meta, null, 2), "utf-8");
    }
    const defaultFile = getTunnelStateFile();
    fs.writeFileSync(defaultFile, JSON.stringify(meta, null, 2), "utf-8");
  } catch {}
}

export function readTunnelState(port?: number): TunnelMetadata | null {
  try {
    if (port) {
      const portFile = getTunnelStateFile(port);
      if (fs.existsSync(portFile)) {
        const raw = fs.readFileSync(portFile, "utf-8");
        return JSON.parse(raw);
      }
    }
    const file = getTunnelStateFile();
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, "utf-8");
    const parsed = JSON.parse(raw);
    if (port && parsed?.port && parsed.port !== port) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function clearTunnelState(port?: number): void {
  try {
    if (port) {
      const portFile = getTunnelStateFile(port);
      if (fs.existsSync(portFile)) {
        fs.unlinkSync(portFile);
      }
    }
    const file = getTunnelStateFile();
    if (fs.existsSync(file)) {
      try {
        const raw = fs.readFileSync(file, "utf-8");
        const parsed = JSON.parse(raw);
        if (!port || parsed?.port === port) {
          fs.unlinkSync(file);
        }
      } catch {
        fs.unlinkSync(file);
      }
    }
  } catch {}
}

export function isProcessRunning(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM";
  }
}

/**
 * Searches for the cloudflared executable in system PATH and common installation directories.
 */
export async function findCloudflaredBinary(): Promise<string | null> {
  const isWin = process.platform === "win32";
  const cmd = isWin ? "where.exe" : "which";

  // 1. Try system PATH
  try {
    const { stdout } = await execa(cmd, ["cloudflared"]);
    const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length > 0 && fs.existsSync(lines[0])) {
      return lines[0];
    }
  } catch {}

  // 2. Known Windows paths
  if (isWin) {
    const winCandidates = [
      "C:\\ProgramData\\chocolatey\\bin\\cloudflared.exe",
      "C:\\Program Files\\cloudflared\\cloudflared.exe",
      "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe",
      path.join(os.homedir(), "scoop", "shims", "cloudflared.exe"),
    ];

    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    const wingetBase = path.join(localAppData, "Microsoft", "WinGet", "Packages");
    if (fs.existsSync(wingetBase)) {
      try {
        const pkgs = fs.readdirSync(wingetBase);
        for (const pkg of pkgs) {
          if (pkg.toLowerCase().includes("cloudflare.cloudflared")) {
            const exe = path.join(wingetBase, pkg, "cloudflared.exe");
            if (fs.existsSync(exe)) {
              winCandidates.unshift(exe);
            }
          }
        }
      } catch {}
    }

    for (const cand of winCandidates) {
      if (fs.existsSync(cand)) return cand;
    }
  } else {
    // macOS / Linux candidates
    const posixCandidates = [
      "/usr/local/bin/cloudflared",
      "/opt/homebrew/bin/cloudflared",
      "/usr/bin/cloudflared",
      "/snap/bin/cloudflared",
      path.join(os.homedir(), ".local", "bin", "cloudflared"),
    ];
    for (const cand of posixCandidates) {
      if (fs.existsSync(cand)) return cand;
    }
  }

  return null;
}

export class CloudflareTunnelManager {
  private static instance: CloudflareTunnelManager | null = null;
  private currentProcess: ChildProcess | null = null;
  private currentMetadata: TunnelMetadata | null = null;

  public static getInstance(): CloudflareTunnelManager {
    if (!CloudflareTunnelManager.instance) {
      CloudflareTunnelManager.instance = new CloudflareTunnelManager();
    }
    return CloudflareTunnelManager.instance;
  }

  /**
   * Starts a quick ephemeral tunnel pointing to the local WebSocket server port.
   * Scans stderr/stdout for the https://*.trycloudflare.com URL and resolves once ready.
   */
  public async startQuickTunnel(options: StartTunnelOptions = {}): Promise<TunnelMetadata> {
    const cfg = loadRemoteAgentConfig(options.customConfigPath);
    const host = options.host || cfg.wsHost || "127.0.0.1";
    const port = options.port || cfg.wsPort || 9225;
    const wsPath = options.path || cfg.wsPath || "/muse";

    // Check if in-process instance is active for this port
    if (
      this.currentProcess &&
      this.currentMetadata &&
      (!this.currentMetadata.port || this.currentMetadata.port === port) &&
      isProcessRunning(this.currentMetadata.pid)
    ) {
      return this.currentMetadata;
    }

    // Check if an external detached instance is active for this port
    const persisted = readTunnelState(port);
    if (persisted && isProcessRunning(persisted.pid)) {
      this.currentMetadata = persisted;
      return persisted;
    }

    const binary = await findCloudflaredBinary();
    if (!binary) {
      throw new Error(
        "cloudflared binary not found. Please install Cloudflare Tunnel:\n" +
          "  Windows: winget install Cloudflare.cloudflared (or choco install cloudflared)\n" +
          "  macOS  : brew install cloudflared\n" +
          "  Linux  : sudo apt install cloudflared"
      );
    }
    const localTarget = `http://${host}:${port}`;
    const timeoutMs = options.timeoutMs || 30000;

    logE2E("REMOTE-AGENT", `Launching quick Cloudflare tunnel targeting ${localTarget}...`);

    return new Promise<TunnelMetadata>((resolve, reject) => {
      let isResolved = false;

      const child = spawn(binary, ["tunnel", "--url", localTarget], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });

      this.currentProcess = child;

      const exitHandler = () => {
        try {
          if (child && child.pid && !child.killed) {
            if (process.platform === "win32") {
              try {
                execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: "ignore" });
              } catch {
                child.kill();
              }
            } else {
              child.kill("SIGTERM");
            }
          }
        } catch {}
      };

      process.once("exit", exitHandler);

      const timeoutTimer = setTimeout(() => {
        if (!isResolved) {
          isResolved = true;
          this.stopQuickTunnel().catch(() => {});
          reject(
            new Error(
              `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for Cloudflare Tunnel URL.`
            )
          );
        }
      }, timeoutMs);

      const handleOutput = (chunk: Buffer | string) => {
        const text = chunk.toString();
        options.onLog?.(text);

        if (!isResolved) {
          const match = text.match(/https:\/\/([a-zA-Z0-9-]+\.trycloudflare\.com)/i);
          if (match) {
            isResolved = true;
            clearTimeout(timeoutTimer);

            const publicUrl = `https://${match[1]}`;
            const wssUrl = `wss://${match[1]}${wsPath}`;

            const meta: TunnelMetadata = {
              pid: child.pid!,
              publicUrl,
              wssUrl,
              localUrl: localTarget,
              port,
              startedAt: Date.now(),
            };

            this.currentMetadata = meta;
            saveTunnelState(meta);

            try {
              updateRemoteAgentConfig({ wsRemoteUrl: wssUrl }, options.customConfigPath);
            } catch {}

            logE2E("REMOTE-AGENT", `Cloudflare quick tunnel established: ${publicUrl} -> ${wssUrl}`);
            options.onUrlDetected?.(publicUrl, wssUrl);
            resolve(meta);
          }
        }
      };

      child.stdout?.on("data", handleOutput);
      child.stderr?.on("data", handleOutput);

      child.on("error", (err) => {
        if (!isResolved) {
          isResolved = true;
          clearTimeout(timeoutTimer);
          clearTunnelState();
          reject(new Error(`Failed to spawn cloudflared: ${err.message}`));
        }
      });

      child.on("close", (code) => {
        process.removeListener("exit", exitHandler);
        clearTunnelState();
        this.currentProcess = null;
        this.currentMetadata = null;
        if (!isResolved) {
          isResolved = true;
          clearTimeout(timeoutTimer);
          reject(new Error(`cloudflared exited prematurely with code ${code}`));
        }
      });
    });
  }

  /**
   * Stops the active quick Cloudflare tunnel if running.
   */
  public async stopQuickTunnel(port?: number): Promise<boolean> {
    let stopped = false;

    if (this.currentProcess) {
      if (!port || this.currentMetadata?.port === port) {
        try {
          if (this.currentProcess.pid) {
            if (process.platform === "win32") {
              try {
                execSync(`taskkill /pid ${this.currentProcess.pid} /T /F`, { stdio: "ignore" });
              } catch {
                this.currentProcess.kill("SIGTERM");
              }
            } else {
              this.currentProcess.kill("SIGTERM");
            }
          } else {
            this.currentProcess.kill("SIGTERM");
          }
          stopped = true;
        } catch {}
        this.currentProcess = null;
      }
    }

    const persisted = readTunnelState(port);
    if (persisted && persisted.pid) {
      try {
        if (isProcessRunning(persisted.pid)) {
          if (process.platform === "win32") {
            try {
              await execa("taskkill", ["/pid", String(persisted.pid), "/T", "/F"]);
            } catch {
              process.kill(persisted.pid, "SIGTERM");
            }
          } else {
            process.kill(persisted.pid, "SIGTERM");
          }
          stopped = true;
        }
      } catch {}
      clearTunnelState(persisted.port || port);
    }

    if (!port || this.currentMetadata?.port === port) {
      this.currentMetadata = null;
    }
    logE2E("REMOTE-AGENT", `Cloudflare quick tunnel stopped${port ? ` (port ${port})` : ""}.`);
    return stopped;
  }

  /**
   * Retrieves the current status of the quick tunnel.
   */
  public getStatus(port?: number): TunnelStatus {
    const meta =
      this.currentMetadata && (!port || this.currentMetadata.port === port)
        ? this.currentMetadata
        : readTunnelState(port);
    if (!meta || !meta.pid) {
      return { isRunning: false };
    }

    const alive = isProcessRunning(meta.pid);
    if (!alive) {
      clearTunnelState(meta.port || port);
      return { isRunning: false };
    }

    const uptime = Math.floor((Date.now() - meta.startedAt) / 1000);
    return {
      isRunning: true,
      pid: meta.pid,
      publicUrl: meta.publicUrl,
      wssUrl: meta.wssUrl,
      localUrl: meta.localUrl,
      port: meta.port,
      startedAt: meta.startedAt,
      uptimeSeconds: uptime,
    };
  }
}

export const cloudflareTunnel = CloudflareTunnelManager.getInstance();

export async function startQuickTunnel(options?: StartTunnelOptions): Promise<TunnelMetadata> {
  return cloudflareTunnel.startQuickTunnel(options);
}

export async function stopQuickTunnel(port?: number): Promise<boolean> {
  return cloudflareTunnel.stopQuickTunnel(port);
}

export function getTunnelStatus(port?: number): TunnelStatus {
  return cloudflareTunnel.getStatus(port);
}


export interface BuildMusePromptOptions {
  wssUrl: string;
  token?: string;
  publicUrl?: string;
  localUrl?: string;
  workspaces?: string[];
  cfClientId?: string;
  cfClientSecret?: string;
  task?: string;
}

export function buildMuseConnectionPrompt(opts: BuildMusePromptOptions): string {
  const lines: string[] = [
    "Connect to my local Superagent workstation via WebSocket:",
    `- Endpoint: ${opts.wssUrl}`,
  ];
  if (opts.token) {
    lines.push(`- Bearer Token: ${opts.token}`);
  }
  if (opts.cfClientId) {
    lines.push(`- CF-Access-Client-Id: ${opts.cfClientId}`);
  }
  if (opts.cfClientSecret) {
    lines.push(`- CF-Access-Client-Secret: ${opts.cfClientSecret}`);
  }
  if (opts.workspaces && opts.workspaces.length > 0) {
    lines.push(`- Watched Projects: ${opts.workspaces.map((w) => path.basename(w)).join(", ")}`);
  }
  lines.push("");
  if (opts.task && opts.task.trim()) {
    lines.push("Task:");
    lines.push(opts.task.trim());
    lines.push("");
    lines.push("Please connect to the WebSocket endpoint, inspect the workspace, and execute the task above.");
  } else {
    lines.push("Please connect to the WebSocket endpoint and confirm when you are ready to receive tasks.");
  }
  return lines.join("\n");
}

export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (process.platform === "win32") {
      await execa("powershell", ["-NoProfile", "-Command", "Set-Clipboard", "-Value", "$input"], {
        input: text,
        timeout: 2000,
        reject: false,
      });
      return true;
    } else if (process.platform === "darwin") {
      await execa("pbcopy", [], {
        input: text,
        timeout: 2000,
        reject: false,
      });
      return true;
    } else if (process.platform === "linux") {
      try {
        await execa("wl-copy", [], { input: text, timeout: 1500, reject: false });
        return true;
      } catch {
        await execa("xclip", ["-selection", "clipboard"], { input: text, timeout: 1500, reject: false });
        return true;
      }
    }
  } catch {
    // Non-fatal fallback
  }
  return false;
}


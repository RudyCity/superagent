import { spawn, execSync, ChildProcess } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import { execa } from "execa";
import { logE2E } from "../utils/unifiedLogger.js";
import { loadRemoteAgentConfig, updateRemoteAgentConfig } from "./config.js";
import { scrubSecrets } from "./contextSanitizer.js";


export interface TunnelMetadata {
  pid: number;
  publicUrl: string;
  wssUrl: string;
  localUrl: string;
  port: number;
  startedAt: number;
  workspace?: string;
  workspaces?: string[];
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
  workspace?: string;
  workspaces?: string[];
  error?: string;
}

export interface ActiveTunnelInfo {
  port: number;
  pid: number;
  publicUrl: string;
  wssUrl: string;
  localUrl: string;
  startedAt: number;
  uptimeSeconds: number;
  workspace?: string;
  workspaces?: string[];
}


export interface StartTunnelOptions {
  port?: number;
  host?: string;
  path?: string;
  timeoutMs?: number;
  customConfigPath?: string;
  workspace?: string;
  workspaces?: string[];
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

export function readTunnelState(portOrWorkspace?: number | string): TunnelMetadata | null {
  try {
    const dir = path.join(os.homedir(), ".superagent-r");
    if (typeof portOrWorkspace === "number") {
      const portFile = getTunnelStateFile(portOrWorkspace);
      if (fs.existsSync(portFile)) {
        const raw = fs.readFileSync(portFile, "utf-8");
        return JSON.parse(raw);
      }
    } else if (typeof portOrWorkspace === "string" && portOrWorkspace.trim()) {
      const targetWs = path.resolve(portOrWorkspace);
      if (fs.existsSync(dir)) {
        const files = fs.readdirSync(dir);
        for (const f of files) {
          if (f === "tunnel.json" || /^tunnel-\d+\.json$/.test(f)) {
            try {
              const raw = fs.readFileSync(path.join(dir, f), "utf-8");
              const meta = JSON.parse(raw);
              if (
                meta &&
                ((meta.workspace && path.resolve(meta.workspace) === targetWs) ||
                 (meta.workspaces && meta.workspaces.some((w: string) => path.resolve(w) === targetWs)))
              ) {
                return meta;
              }
            } catch {}
          }
        }
      }
    }
    const file = getTunnelStateFile();
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof portOrWorkspace === "number" && parsed?.port && parsed.port !== portOrWorkspace) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function clearTunnelState(port?: number | "all"): void {
  try {
    const dir = path.join(os.homedir(), ".superagent-r");
    if (typeof port === "number") {
      const portFile = getTunnelStateFile(port);
      if (fs.existsSync(portFile)) {
        try { fs.unlinkSync(portFile); } catch {}
      }
      const defaultFile = path.join(dir, "tunnel.json");
      if (fs.existsSync(defaultFile)) {
        try {
          const raw = fs.readFileSync(defaultFile, "utf-8");
          const parsed = JSON.parse(raw);
          if (parsed?.port === port) {
            fs.unlinkSync(defaultFile);
          }
        } catch {
          try { fs.unlinkSync(defaultFile); } catch {}
        }
      }
    } else if (port === "all" || port === undefined) {
      if (fs.existsSync(dir)) {
        const files = fs.readdirSync(dir);
        for (const f of files) {
          if (f === "tunnel.json" || /^tunnel-\d+\.json$/.test(f)) {
            try {
              fs.unlinkSync(path.join(dir, f));
            } catch {}
          }
        }
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
  private activeProcesses = new Map<number, ChildProcess>();
  private activeMetadata = new Map<number, TunnelMetadata>();
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
    const workspace = options.workspace || (options.workspaces && options.workspaces[0]) || process.cwd();
    const workspaces = options.workspaces && options.workspaces.length > 0 ? options.workspaces : [workspace];

    // Check if in-process instance is active for this port
    const inProcChild = this.activeProcesses.get(port);
    const inProcMeta = this.activeMetadata.get(port);
    if (inProcChild && inProcMeta && inProcMeta.pid && isProcessRunning(inProcMeta.pid)) {
      return inProcMeta;
    }

    // Check if an external detached instance is active for this port
    const persisted = readTunnelState(port);
    if (persisted && isProcessRunning(persisted.pid)) {
      this.activeMetadata.set(port, persisted);
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

      this.activeProcesses.set(port, child);
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
          this.stopQuickTunnel(port).catch(() => {});
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
              workspace,
              workspaces,
              startedAt: Date.now(),
            };

            this.activeMetadata.set(port, meta);
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
          clearTunnelState(port);
          this.activeProcesses.delete(port);
          this.activeMetadata.delete(port);
          if (this.currentProcess === child) {
            this.currentProcess = null;
            this.currentMetadata = null;
          }
          reject(new Error(`Failed to spawn cloudflared: ${err.message}`));
        }
      });

      child.on("close", (code) => {
        process.removeListener("exit", exitHandler);
        clearTunnelState(port);
        this.activeProcesses.delete(port);
        this.activeMetadata.delete(port);
        if (this.currentProcess === child) {
          this.currentProcess = null;
          this.currentMetadata = null;
        }
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
   * If port is "all", stops all active quick tunnels across all ports.
   */
  public async stopQuickTunnel(port?: number | "all"): Promise<boolean> {
    if (port === "all") {
      const count = await this.stopAll();
      return count > 0;
    }

    let stopped = false;

    // Determine target ports to stop
    const targetPorts: number[] = [];
    if (typeof port === "number") {
      targetPorts.push(port);
    } else {
      // If port is not specified, stop all in-process tunnels or fallback to active tunnels
      if (this.activeProcesses.size > 0) {
        targetPorts.push(...Array.from(this.activeProcesses.keys()));
      } else {
        const persisted = readTunnelState();
        if (persisted?.port) {
          targetPorts.push(persisted.port);
        }
      }
    }

    for (const p of targetPorts) {
      const proc = this.activeProcesses.get(p);
      if (proc) {
        try {
          if (proc.pid) {
            if (process.platform === "win32") {
              try {
                execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: "ignore" });
              } catch {
                proc.kill("SIGTERM");
              }
            } else {
              proc.kill("SIGTERM");
            }
          } else {
            proc.kill("SIGTERM");
          }
          stopped = true;
        } catch {}
        this.activeProcesses.delete(p);
        this.activeMetadata.delete(p);
        if (this.currentProcess === proc) {
          this.currentProcess = null;
          this.currentMetadata = null;
        }
      }

      const persisted = readTunnelState(p);
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
        clearTunnelState(p);
      }
    }

    if (typeof port === "number") {
      logE2E("REMOTE-AGENT", `Cloudflare quick tunnel stopped (port ${port}).`);
    } else {
      logE2E("REMOTE-AGENT", `Cloudflare quick tunnel stopped.`);
    }
    return stopped;
  }

  /**
   * Lists all currently active quick Cloudflare tunnels across all ports.
   */
  public listActive(): ActiveTunnelInfo[] {
    const dir = path.join(os.homedir(), ".superagent-r");
    const activeMap = new Map<number, ActiveTunnelInfo>();

    // 1. Check in-memory metadata if running in this process
    for (const [p, meta] of this.activeMetadata.entries()) {
      if (meta && meta.pid && isProcessRunning(meta.pid)) {
        const uptime = Math.floor((Date.now() - meta.startedAt) / 1000);
        activeMap.set(meta.port, {
          port: meta.port,
          pid: meta.pid,
          publicUrl: meta.publicUrl,
          wssUrl: meta.wssUrl,
          localUrl: meta.localUrl,
          workspace: meta.workspace,
          workspaces: meta.workspaces,
          startedAt: meta.startedAt,
          uptimeSeconds: Math.max(0, uptime),
        });
      }
    }

    // 2. Scan ~/.superagent-r directory for tunnel state files
    if (fs.existsSync(dir)) {
      try {
        const files = fs.readdirSync(dir);
        for (const f of files) {
          if (f === "tunnel.json" || /^tunnel-\d+\.json$/.test(f)) {
            const filePath = path.join(dir, f);
            try {
              const raw = fs.readFileSync(filePath, "utf-8");
              const meta = JSON.parse(raw) as TunnelMetadata;
              if (meta && meta.pid) {
                if (isProcessRunning(meta.pid)) {
                  let effectivePort = meta.port;
                  if (!effectivePort) {
                    const match = f.match(/^tunnel-(\d+)\.json$/);
                    if (match) {
                      effectivePort = parseInt(match[1], 10);
                    } else if (meta.localUrl) {
                      const urlMatch = meta.localUrl.match(/:(\d+)/);
                      if (urlMatch) effectivePort = parseInt(urlMatch[1], 10);
                    }
                    effectivePort = effectivePort || 9225;
                  }
                  const uptime = Math.floor((Date.now() - (meta.startedAt || Date.now())) / 1000);
                  if (!activeMap.has(effectivePort)) {
                    activeMap.set(effectivePort, {
                      port: effectivePort,
                      pid: meta.pid,
                      publicUrl: meta.publicUrl,
                      wssUrl: meta.wssUrl,
                      localUrl: meta.localUrl,
                      workspace: meta.workspace,
                      workspaces: meta.workspaces,
                      startedAt: meta.startedAt,
                      uptimeSeconds: Math.max(0, uptime),
                    });
                  }
                } else {
                  // Clean up stale file
                  try {
                    fs.unlinkSync(filePath);
                  } catch {}
                }
              }
            } catch {}
          }
        }
      } catch {}
    }

    return Array.from(activeMap.values()).sort((a, b) => a.port - b.port);
  }

  /**
   * Stops all running quick Cloudflare tunnels across all ports and workspaces,
   * including orphaned quick-tunnel processes that have no state file.
   */
  public async stopAll(): Promise<number> {
    const active = this.listActive();
    let stoppedCount = 0;
    const handledPids = new Set<number>();
    for (const t of active) {
      try {
        handledPids.add(t.pid);
        const stopped = await this.stopQuickTunnel(t.port);
        if (stopped) stoppedCount++;
      } catch {}
    }
    stoppedCount += await this.killOrphanQuickTunnels(handledPids);
    clearTunnelState("all");
    return stoppedCount;
  }

  /**
   * Finds and terminates cloudflared quick-tunnel processes (`tunnel --url http://<local>:<port>`)
   * that are not tracked by any state file. Named/managed tunnels are left untouched.
   */
  private async killOrphanQuickTunnels(skipPids: Set<number>): Promise<number> {
    const pids: number[] = [];
    try {
      if (process.platform === "win32") {
        const { stdout } = await execa(
          "powershell",
          [
            "-NoProfile",
            "-Command",
            "Get-CimInstance Win32_Process -Filter \"Name = 'cloudflared.exe'\" | Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress",
          ],
          { timeout: 5000, reject: false },
        );
        if (stdout && stdout.trim()) {
          const parsed = JSON.parse(stdout);
          const list = Array.isArray(parsed) ? parsed : [parsed];
          for (const p of list) {
            if (p?.ProcessId && /tunnel\s+--url\s+https?:\/\/(127\.0\.0\.1|localhost)/i.test(p.CommandLine || "")) {
              pids.push(Number(p.ProcessId));
            }
          }
        }
      } else {
        const { stdout } = await execa("pgrep", ["-af", "cloudflared"], { timeout: 3000, reject: false });
        for (const line of (stdout || "").split("\n")) {
          const m = line.match(/^(\d+)\s+.*tunnel\s+--url\s+https?:\/\/(127\.0\.0\.1|localhost)/i);
          if (m) pids.push(Number(m[1]));
        }
      }
    } catch {
      return 0;
    }

    let killed = 0;
    for (const pid of pids) {
      if (skipPids.has(pid) || pid === process.pid || !isProcessRunning(pid)) continue;
      try {
        if (process.platform === "win32") {
          await execa("taskkill", ["/pid", String(pid), "/T", "/F"], { reject: false });
        } else {
          process.kill(pid, "SIGTERM");
        }
        killed++;
      } catch {}
    }
    return killed;
  }

  /**
   * Retrieves the current status of the quick tunnel.
   */
  public getStatus(port?: number): TunnelStatus {
    const meta =
      (port ? this.activeMetadata.get(port) : this.currentMetadata) ||
      readTunnelState(port);
    if (!meta || !meta.pid) {
      return { isRunning: false };
    }

    const alive = isProcessRunning(meta.pid);
    if (!alive) {
      if (typeof meta.port === "number") {
        clearTunnelState(meta.port);
      } else if (typeof port === "number") {
        clearTunnelState(port);
      } else {
        clearTunnelState(undefined);
      }
      if (meta.port) {
        this.activeProcesses.delete(meta.port);
        this.activeMetadata.delete(meta.port);
      }
      if (this.currentMetadata === meta) {
        this.currentMetadata = null;
      }
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
      workspace: meta.workspace,
      workspaces: meta.workspaces,
      startedAt: meta.startedAt,
      uptimeSeconds: uptime,
    };
  }
}

export const cloudflareTunnel = CloudflareTunnelManager.getInstance();

export async function startQuickTunnel(options?: StartTunnelOptions): Promise<TunnelMetadata> {
  return cloudflareTunnel.startQuickTunnel(options);
}

export async function stopQuickTunnel(port?: number | "all"): Promise<boolean> {
  return cloudflareTunnel.stopQuickTunnel(port);
}

export function listActiveTunnels(): ActiveTunnelInfo[] {
  return cloudflareTunnel.listActive();
}

export async function stopAllQuickTunnels(): Promise<number> {
  return cloudflareTunnel.stopAll();
}

export function getTunnelStatus(port?: number): TunnelStatus {
  return cloudflareTunnel.getStatus(port);
}

export function formatActiveTunnels(tunnels: ActiveTunnelInfo[]): string {
  if (!tunnels || tunnels.length === 0) {
    return [
      "Cloudflare Quick Tunnels: NONE ACTIVE",
      "No active quick tunnels found.",
      "Run '/muse tunnel start' (or 'superagent muse tunnel start') to launch a tunnel.",
    ].join("\n");
  }

  const lines: string[] = [
    `Active Cloudflare Quick Tunnels (${tunnels.length}):`,
  ];

  tunnels.forEach((t, i) => {
    lines.push(
      `${i + 1}. Port ${t.port} (PID: ${t.pid}, Uptime: ${t.uptimeSeconds}s)`,
      `   - Public URL   : ${t.publicUrl}`,
      `   - WSS Endpoint : ${t.wssUrl}`,
      `   - Local Target : ${t.localUrl}`,
    );
    if (t.workspace) {
      lines.push(`   - Workspace    : ${t.workspace}`);
    }
  });

  lines.push(
    "",
    "Commands:",
    "  Stop specific tunnel : /muse tunnel stop --port <port>",
    "  Stop all tunnels     : /muse tunnel stop all  (all running tunnels and watchers across all workspaces)",
  );

  return lines.join("\n");
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
    const cleanTask = scrubSecrets(opts.task.trim(), [opts.token, opts.cfClientSecret]);
    lines.push("Task:");
    lines.push(cleanTask);
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

export interface BuildHttpsPromptOptions {
  publicUrl: string;
  localUrl: string;
  token?: string;
  port: number;
}

export function buildHttpsConnectionPrompt(opts: BuildHttpsPromptOptions): string {
  const lines: string[] = [
    `Superagent HTTP REST/SSE Server is accessible over Cloudflare HTTPS:`,
    `- Public HTTPS URL : ${opts.publicUrl}`,
    `- Local Target     : ${opts.localUrl}`,
    `- Server Port      : ${opts.port}`,
  ];
  if (opts.token) {
    lines.push(`- Bearer Token     : ${opts.token}`);
    lines.push("");
    lines.push("Test with curl:");
    lines.push(`curl -H "Authorization: Bearer ${opts.token}" ${opts.publicUrl}/api/status`);
  }
  return lines.join("\n");
}

export function isServerRunningOnPort(port = 7888): boolean {
  try {
    const specificPath = path.join(os.homedir(), ".superagent-r", `server-info-${port}.json`);
    const serverInfoPath = path.join(os.homedir(), ".superagent-r", "server-info.json");
    const targetPath = fs.existsSync(specificPath) ? specificPath : serverInfoPath;
    if (fs.existsSync(targetPath)) {
      const data = JSON.parse(fs.readFileSync(targetPath, "utf-8"));
      if (data?.port === port && data?.pid && isProcessRunning(data.pid)) {
        return true;
      }
    }
  } catch {}
  return false;
}

export async function ensureSuperagentServer(port = 7888): Promise<void> {
  if (isServerRunningOnPort(port)) {
    return;
  }
  try {
    const { runServer } = await import("../../server.js");
    await runServer(port, true, "tline");
  } catch (err: any) {
    logE2E("REMOTE-AGENT", `ensureSuperagentServer error: ${err?.message}`);
  }
}



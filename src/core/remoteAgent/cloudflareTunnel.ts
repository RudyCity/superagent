import { spawn, execSync, ChildProcess } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import { execa } from "execa";
import { logE2E } from "../utils/unifiedLogger.js";
import { loadRemoteAgentConfig, updateRemoteAgentConfig } from "./config.js";
import { scrubSecrets } from "./contextSanitizer.js";
import { applyProcessIntent, execHiddenTaskkillSync, traceChildProcess } from "../process/processSpawnPolicy.js";
import { getProcessSupervisor } from "../process/processSupervisor.js";

function headlessOpts<T extends Record<string, any>>(opts?: T, caller = "cloudflareTunnel") {
  return applyProcessIntent(opts ?? ({} as T), "headless", { caller });
}

export type TunnelServiceKind = "muse-websocket" | "mcp-http" | "superagent-http" | "unknown";

export interface TunnelMetadata {
  pid: number;
  publicUrl: string;
  /** Present only when this tunnel exposes a Muse WebSocket endpoint. */
  wssUrl?: string;
  localUrl: string;
  port: number;
  startedAt: number;
  /** Missing on legacy state files; unknown legacy records must not be assumed to be Muse. */
  serviceKind?: TunnelServiceKind;
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
  serviceKind?: TunnelServiceKind;
  workspace?: string;
  workspaces?: string[];
  error?: string;
}
export interface ActiveTunnelInfo {
  port: number;
  pid: number;
  publicUrl: string;
  /** Present only for Muse WebSocket tunnels. */
  wssUrl?: string;
  localUrl: string;
  startedAt: number;
  uptimeSeconds: number;
  serviceKind?: TunnelServiceKind;
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
  /** Defaults to Muse WebSocket for backwards compatibility with legacy Muse callers. */
  serviceKind?: Exclude<TunnelServiceKind, "unknown">;
  onLog?: (line: string) => void;
  onUrlDetected?: (publicUrl: string, wssUrl?: string) => void;
  /** Service-owned cleanup hook; generic tunnel management never changes service config. */
  onExit?: (metadata: TunnelMetadata) => void;
}

/** Compare the local HTTP origin a tunnel forwards to, independent of path/trailing slash. */
export function isSameTunnelTarget(actualUrl: string | undefined, expectedUrl: string): boolean {
  if (!actualUrl || !expectedUrl) return false;
  try {
    const actual = new URL(actualUrl);
    const expected = new URL(expectedUrl);
    return actual.protocol === expected.protocol &&
      actual.hostname.toLowerCase() === expected.hostname.toLowerCase() &&
      actual.port === expected.port;
  } catch {
    return false;
  }
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
      CloudflareTunnelManager.getInstance().setMemoryState(targetPort, meta);
      const portFile = getTunnelStateFile(targetPort);
      fs.writeFileSync(portFile, JSON.stringify(meta, null, 2), "utf-8");
    }
    // The default tunnel.json is sticky, not last-write-wins: it keeps pointing
    // at the first-started tunnel and is only overwritten when it does not exist
    // yet, is unreadable, already belongs to the same port, or when the
    // currently recorded tunnel process has died. This keeps getTunnelStatus()
    // (no port) unambiguous while never leaving a dead tunnel as default.
    const defaultFile = getTunnelStateFile();
    let writeDefault = true;
    if (targetPort && fs.existsSync(defaultFile)) {
      try {
        const existing = JSON.parse(fs.readFileSync(defaultFile, "utf-8"));
        if (existing && typeof existing.port === "number" && existing.port !== targetPort) {
          writeDefault = false;
        }
      } catch {
        // Unreadable default holds no valid claim; overwrite it below.
      }
    }
    if (writeDefault) {
      fs.writeFileSync(defaultFile, JSON.stringify(meta, null, 2), "utf-8");
    }
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
    if (!fs.existsSync(file)) {
      return null;
    }
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
    CloudflareTunnelManager.getInstance().clearMemoryState(port);
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
    } else if (port === "all") {
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
    } else if (port === undefined) {
      const defaultFile = path.join(dir, "tunnel.json");
      if (fs.existsSync(defaultFile)) {
        try {
          const raw = fs.readFileSync(defaultFile, "utf-8");
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed.port === "number") {
            const portFile = getTunnelStateFile(parsed.port);
            if (fs.existsSync(portFile)) {
              try { fs.unlinkSync(portFile); } catch {}
            }
          }
          fs.unlinkSync(defaultFile);
        } catch {
          try { fs.unlinkSync(defaultFile); } catch {}
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
 * Regex matching the public Cloudflare quick-tunnel URL printed by cloudflared.
 */
const TUNNEL_URL_REGEX = /https:\/\/([a-zA-Z0-9-]+\.trycloudflare\.com)/i;

/**
 * Incrementally scans cloudflared stdout/stderr for the public tunnel URL.
 *
 * Keeps a bounded rolling buffer so a URL split across chunk boundaries
 * (stdout vs stderr, or two consecutive data events) is still detected.
 * Matching each chunk in isolation would miss it and wrongly time out a
 * healthy tunnel.
 */
export class TunnelUrlScanner {
  private static readonly MAX_BUFFER_CHARS = 4096;
  private buffer = "";

  /**
   * Feeds one output chunk. Returns the detected public URL, or null.
   */
  push(chunk: Buffer | string): string | null {
    this.buffer = (this.buffer + chunk.toString()).slice(
      -TunnelUrlScanner.MAX_BUFFER_CHARS
    );
    const match = this.buffer.match(TUNNEL_URL_REGEX);
    return match ? `https://${match[1]}` : null;
  }
}

/**
 * Verifies that a PID recorded in a tunnel state file still belongs to the
 * cloudflared quick-tunnel process started for the given local URL.
 *
 * Guards against PID reuse: a process is only ever signaled when its command
 * line proves it is our `cloudflared tunnel --url <localUrl>` instance.
 * Foreign cloudflared processes (e.g. started manually) are never touched.
 */
export async function isOwnQuickTunnelProcess(
  pid: number,
  localUrl: string
): Promise<boolean> {
  if (!pid || pid <= 0 || !Number.isInteger(pid) || !localUrl) return false;
  const cmdline = await readProcessCommandLine(pid);
  const lower = (cmdline || "").toLowerCase();
  if (!lower.includes("cloudflared")) return false;
  // Pin the exact local target (host AND port) so a foreign quick tunnel
  // on another port can never match.
  return lower.includes(`tunnel --url ${localUrl.toLowerCase()}`);
}

/** Synchronous identity check for status/list APIs, which intentionally remain synchronous. */
const OWN_PROCESS_CACHE_TTL_MS = 2000;
const ownProcessCache = new Map<string, { checkedAt: number; owns: boolean }>();

export function isOwnQuickTunnelProcessSync(pid: number, localUrl: string): boolean {
  if (!pid || pid <= 0 || !Number.isInteger(pid) || !localUrl) return false;
  const cacheKey = `${pid}:${localUrl.toLowerCase()}`;
  if (!isProcessRunning(pid)) {
    ownProcessCache.delete(cacheKey);
    return false;
  }
  const cached = ownProcessCache.get(cacheKey);
  if (cached?.owns && Date.now() - cached.checkedAt < OWN_PROCESS_CACHE_TTL_MS) return true;
  let owns = false;
  try {
    let cmdline = "";
    if (process.platform === "win32") {
      cmdline = execSync(
        `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -eq ${pid} } | Select-Object -ExpandProperty CommandLine"`,
        headlessOpts({ encoding: "utf-8" as const, timeout: 2500, stdio: ["ignore", "pipe", "ignore"] }, "cloudflareTunnel.isOwnQuickTunnelProcessSync.win")
      );
    } else if (process.platform === "darwin") {
      cmdline = execSync(`ps -p ${pid} -o command=`, headlessOpts({
        encoding: "utf-8" as const,
        timeout: 2500,
        stdio: ["ignore", "pipe", "ignore"],
      }, "cloudflareTunnel.isOwnQuickTunnelProcessSync.mac"));
    } else {
      cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf-8").replace(/\0/g, " ");
    }
    const lower = cmdline.toLowerCase();
    owns = lower.includes("cloudflared") && lower.includes(`tunnel --url ${localUrl.toLowerCase()}`);
  } catch {
    owns = false;
  }
  ownProcessCache.set(cacheKey, { checkedAt: Date.now(), owns });
  return owns;
}

/**
 * Reads a process command line cross-platform. Returns "" when unavailable.
 */
async function readProcessCommandLine(pid: number): Promise<string> {
  try {
    if (process.platform === "win32") {
      const { stdout } = await execa(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" | Select-Object -ExpandProperty CommandLine`,
        ],
        headlessOpts({ timeout: 3000, reject: false }, "cloudflareTunnel.readProcessCommandLine.win")
      );
      return stdout || "";
    }
    if (process.platform === "darwin") {
      const { stdout } = await execa("ps", ["-p", String(pid), "-o", "command="], headlessOpts({
        timeout: 3000,
        reject: false,
      }, "cloudflareTunnel.readProcessCommandLine.mac"));
      return stdout || "";
    }
    try {
      return fs.readFileSync(`/proc/${pid}/cmdline`, "utf-8").replace(/\0/g, " ");
    } catch {
      const { stdout } = await execa("ps", ["-p", String(pid), "-o", "args="], headlessOpts({
        timeout: 3000,
        reject: false,
      }, "cloudflareTunnel.readProcessCommandLine.linux"));
      return stdout || "";
    }
  } catch {
    return "";
  }
}

/**
 * Clears a stale quick-tunnel URL from the remote-agent config.
 *
 * When expectedWssUrl is given, the stored value is cleared only if it
 * matches, so stopping one tunnel never wipes another tunnel's live URL.
 * Called with no argument (stop-all), whatever is stored is cleared.
 */
export function clearWsRemoteUrl(expectedWssUrl?: string, customConfigPath?: string): void {
  try {
    const cfg = loadRemoteAgentConfig(customConfigPath);
    if (!cfg.wsRemoteUrl) return;
    if (expectedWssUrl !== undefined && cfg.wsRemoteUrl !== expectedWssUrl) return;
    updateRemoteAgentConfig({ wsRemoteUrl: undefined }, customConfigPath);
  } catch {}
}

/**
 * Searches for the cloudflared executable in system PATH and common installation directories.
 */
export async function findCloudflaredBinary(): Promise<string | null> {
  const isWin = process.platform === "win32";
  const cmd = isWin ? "where.exe" : "which";

  // 1. Try system PATH
  try {
    const { stdout } = await execa(cmd, ["cloudflared"], headlessOpts({}, "cloudflareTunnel.findCloudflaredBinary"));
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

  public clearMemoryState(port?: number | "all"): void {
    if (typeof port === "number") {
      this.activeProcesses.delete(port);
      this.activeMetadata.delete(port);
      if (this.currentMetadata?.port === port) {
        this.currentMetadata = null;
      }
    } else if (port === "all") {
      this.activeProcesses.clear();
      this.activeMetadata.clear();
      this.currentProcess = null;
      this.currentMetadata = null;
    } else {
      if (this.currentMetadata?.port) {
        this.activeProcesses.delete(this.currentMetadata.port);
        this.activeMetadata.delete(this.currentMetadata.port);
      }
      this.currentProcess = null;
      this.currentMetadata = null;
    }
  }

  public setMemoryState(port: number, meta: TunnelMetadata): void {
    this.activeMetadata.set(port, meta);
    if (!this.currentMetadata || this.currentMetadata.port === port) {
      this.currentMetadata = meta;
    }
  }

  private isTunnelCommandOwned(meta: TunnelMetadata): boolean {
    if (!meta.pid || !meta.localUrl || !isProcessRunning(meta.pid)) return false;
    const child = this.activeProcesses.get(meta.port);
    if (child?.pid === meta.pid && child.exitCode === null && child.signalCode === null) return true;
    return isOwnQuickTunnelProcessSync(meta.pid, meta.localUrl);
  }

  private isTunnelProcessAlive(meta: TunnelMetadata): boolean {
    return this.hasExpectedTargetPort(meta) && this.isTunnelCommandOwned(meta);
  }

  private hasExpectedTargetPort(meta: TunnelMetadata): boolean {
    if (typeof meta.port !== "number" || !meta.localUrl) return false;
    try {
      const target = new URL(meta.localUrl);
      const targetPort = target.port ? Number(target.port) : (target.protocol === "https:" ? 443 : 80);
      return target.protocol === "http:" && targetPort === meta.port;
    } catch {
      return false;
    }
  }

  /**
   * Claims a legacy/unknown tunnel only after the caller has confirmed its local
   * service is ready. A known, different service kind can never be reclassified.
   */
  public claimServiceKind(
    port: number,
    serviceKind: Exclude<TunnelServiceKind, "unknown">,
    customConfigPath?: string
  ): TunnelMetadata | null {
    const meta = this.activeMetadata.get(port) || readTunnelState(port);
    if (!meta || !this.hasExpectedTargetPort(meta)) return null;
    if (meta.serviceKind && meta.serviceKind !== "unknown" && meta.serviceKind !== serviceKind) {
      return null;
    }
    const next: TunnelMetadata = { ...meta, serviceKind };
    if (serviceKind !== "muse-websocket") delete next.wssUrl;
    this.activeMetadata.set(port, next);
    if (this.currentMetadata?.port === port) this.currentMetadata = next;
    saveTunnelState(next, port);
    // Config publication belongs to the service owner, not the generic tunnel manager.
    return next;
  }

  /**
   * Starts a quick ephemeral tunnel pointing to the local WebSocket server port.
   * Scans stderr/stdout for the https://*.trycloudflare.com URL and resolves once ready.
   */
  public async startQuickTunnel(options: StartTunnelOptions = {}): Promise<TunnelMetadata> {
    const cfg = loadRemoteAgentConfig(options.customConfigPath);
    const host = options.host || cfg.wsHost || "127.0.0.1";
    const port = options.port || cfg.wsPort || 9225;
    const serviceKind = options.serviceKind || "muse-websocket";
    const localTarget = `http://${host}:${port}`;
    // An explicitly empty path means the HTTP service is mounted at the root.
    const wsPath = options.path !== undefined ? options.path : (cfg.wsPath || "/muse");
    const workspace = options.workspace || (options.workspaces && options.workspaces[0]) || process.cwd();
    const workspaces = options.workspaces && options.workspaces.length > 0 ? options.workspaces : [workspace];
    const assertCompatibleService = (meta: TunnelMetadata) => {
      if (meta.serviceKind && meta.serviceKind !== "unknown" && meta.serviceKind !== serviceKind) {
        throw new Error(
          `Cloudflare tunnel on port ${port} belongs to ${meta.serviceKind}, not ${serviceKind}. Stop that service or choose another port.`
        );
      }
      if (!isSameTunnelTarget(meta.localUrl, localTarget)) {
        throw new Error(
          `Cloudflare tunnel state on port ${port} forwards to ${meta.localUrl || "an unknown local target"}, not ${localTarget}. Reconcile/stop that tunnel before reuse.`
        );
      }
    };

    // Check if in-process instance is active for this port.
    const inProcChild = this.activeProcesses.get(port);
    const inProcMeta = this.activeMetadata.get(port);
    if (
      inProcChild && inProcMeta && inProcMeta.pid === inProcChild.pid &&
      inProcChild.exitCode === null && inProcChild.signalCode === null &&
      isProcessRunning(inProcMeta.pid)
    ) {
      assertCompatibleService(inProcMeta);
      return inProcMeta;
    }

    // Reuse a detached tunnel only if its PID still belongs to cloudflared
    // and its command line targets this exact local endpoint.
    const persisted = readTunnelState(port);
    if (persisted && isProcessRunning(persisted.pid)) {
      const localTarget = persisted.localUrl || `http://127.0.0.1:${port}`;
      if (await isOwnQuickTunnelProcess(persisted.pid, localTarget)) {
        assertCompatibleService(persisted);
        this.activeMetadata.set(port, persisted);
        this.currentMetadata = persisted;
        return persisted;
      }
      clearTunnelState(port);
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
    const timeoutMs = options.timeoutMs || 30000;

    logE2E("REMOTE-AGENT", `Launching quick Cloudflare tunnel targeting ${localTarget}...`);

    return new Promise<TunnelMetadata>((resolve, reject) => {
      let isResolved = false;
      let cfTunnelRecordId: string | undefined;
      let earlyExit: { code: number | null; signal: string | null } | null = null;

      const child = traceChildProcess(
        spawn(
          binary,
          ["tunnel", "--url", localTarget],
          headlessOpts({
            stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"],
          }, "cloudflareTunnel.startQuickTunnel")
        ),
        {
          caller: "cloudflareTunnel.startQuickTunnel",
          executable: binary,
          args: ["tunnel", "--url", localTarget],
          intent: "headless",
        }
      );

      void getProcessSupervisor().registerProcess({
        component: "cloudflare_tunnel",
        executable: binary,
        args: ["tunnel", "--url", localTarget],
        launchIntent: "headless",
        lifecycle: "persistent",
        cleanupPolicy: "keep_alive",
      }).then(async (reg) => {
        cfTunnelRecordId = reg.recordId;
        if (child.pid) {
          await getProcessSupervisor().recordProcessSpawn(reg.recordId, child.pid).catch(() => {});
        }
        if (earlyExit) {
          await getProcessSupervisor().recordProcessExit(reg.recordId, {
            exitCode: earlyExit.code, signal: earlyExit.signal, source: "cloudflareTunnel.early_exit",
          }).catch(() => {});
        }
      }).catch(() => {});

      child.on("exit", (code: number | null, signal: string | null) => {
        if (cfTunnelRecordId) {
          void getProcessSupervisor().recordProcessExit(cfTunnelRecordId, {
            exitCode: code, signal, source: "cloudflareTunnel.exit",
          }).catch(() => {});
        } else {
          earlyExit = { code, signal };
        }
      });

      this.activeProcesses.set(port, child);
      this.currentProcess = child;

      const exitHandler = () => {
        try {
          if (child && child.pid && !child.killed) {
            if (process.platform === "win32") {
              if (!execHiddenTaskkillSync(child.pid, true, 3000, "cloudflareTunnel.exitHandler")) {
                child.kill();
              }
            } else {
              child.kill("SIGTERM");
            }
          }
        } catch {}
        // Notify the owning service; the generic manager must not mutate service config.
        try {
          const meta = this.activeMetadata.get(port);
          if (meta) options.onExit?.(meta);
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

      // Bounded rolling scanner: a URL split across chunk boundaries is still detected.
      const urlScanner = new TunnelUrlScanner();

      const handleOutput = (chunk: Buffer | string) => {
        const text = chunk.toString();
        options.onLog?.(text);

        if (!isResolved) {
          const publicUrl = urlScanner.push(text);
          if (publicUrl) {
            isResolved = true;
            clearTimeout(timeoutTimer);

            const wssUrl = serviceKind === "muse-websocket"
              ? `wss://${publicUrl.slice("https://".length)}${wsPath}`
              : undefined;
            const meta: TunnelMetadata = {
              pid: child.pid!,
              publicUrl,
              ...(wssUrl ? { wssUrl } : {}),
              localUrl: localTarget,
              port,
              serviceKind,
              workspace,
              workspaces,
              startedAt: Date.now(),
            };

            this.activeMetadata.set(port, meta);
            this.currentMetadata = meta;
            saveTunnelState(meta);

            logE2E("REMOTE-AGENT", `Cloudflare quick tunnel established (${serviceKind}): ${publicUrl}${wssUrl ? ` -> ${wssUrl}` : ""}`);
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
        const closedMeta = this.activeMetadata.get(port);
        clearTunnelState(port);
        this.activeProcesses.delete(port);
        this.activeMetadata.delete(port);
        // Service-specific cleanup is performed through the caller-owned hook.
        if (closedMeta) {
          try { options.onExit?.(closedMeta); } catch {}
        }
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
  public async stopQuickTunnel(
    port?: number | "all",
    expectedServiceKind?: TunnelServiceKind
  ): Promise<boolean> {
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
      const inProcMeta = this.activeMetadata.get(p);
      const persistedForKind = inProcMeta || readTunnelState(p);
      const proc = this.activeProcesses.get(p);
      if (!persistedForKind) {
        // A URL may not have been detected yet; the child reference is still proof
        // that this process created the pending tunnel, so timeout rollback can stop it.
        if (proc && !expectedServiceKind) {
          try {
            if (proc.pid && process.platform === "win32") {
              if (!execHiddenTaskkillSync(proc.pid, true, 3000, "cloudflareTunnel.stopPending")) {
                proc.kill("SIGTERM");
              }
            } else {
              proc.kill("SIGTERM");
            }
            stopped = true;
          } catch {}
          this.activeProcesses.delete(p);
          if (this.currentProcess === proc) this.currentProcess = null;
          clearTunnelState(p);
          continue;
        }
        logE2E("REMOTE-AGENT", `Skipped tunnel stop on port ${p}: no verifiable tunnel state or owned pending child.`);
        continue;
      }
      if (!this.hasExpectedTargetPort(persistedForKind)) {
        logE2E("REMOTE-AGENT", `Skipped tunnel stop on port ${p}: local target/port identity is inconsistent.`);
        continue;
      }
      if (
        expectedServiceKind &&
        (!persistedForKind.serviceKind ||
          persistedForKind.serviceKind === "unknown" ||
          persistedForKind.serviceKind !== expectedServiceKind)
      ) {
        logE2E(
          "REMOTE-AGENT",
          `Skipped tunnel stop on port ${p}: expected ${expectedServiceKind}, found ${persistedForKind.serviceKind || "unknown (legacy state)"}.`
        );
        continue;
      }
      // Use the manager-owned child captured above, if present.
      if (proc) {
        try {
          if (proc.pid) {
            if (process.platform === "win32") {
              if (!execHiddenTaskkillSync(proc.pid, true, 3000, "cloudflareTunnel.stopQuickTunnel")) {
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
        // No service configuration is changed by a generic stop.
      }

      const persisted = readTunnelState(p);
      if (persisted && persisted.pid) {
        try {
          // Only PIDs recorded in our own state files are ever signaled, and
          // only after the command line proves the PID still belongs to our
          // quick tunnel (never a broad pattern: foreign cloudflared
          // processes and reused PIDs are left alone).
          const localTarget = persisted.localUrl || `http://127.0.0.1:${persisted.port || p}`;
          if (
            isProcessRunning(persisted.pid) &&
            (await isOwnQuickTunnelProcess(persisted.pid, localTarget))
          ) {
            if (process.platform === "win32") {
              try {
                await execa("taskkill", ["/pid", String(persisted.pid), "/T", "/F"], headlessOpts({}, "cloudflareTunnel.stopPersisted"));
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
        // No service configuration is changed by a generic stop.
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

    // 1. Check in-memory metadata. A cached PID is not sufficient evidence
    // unless this manager owns its child or the OS command line still matches.
    for (const [p, meta] of this.activeMetadata.entries()) {
      if (meta && this.isTunnelProcessAlive(meta)) {
        const uptime = Math.floor((Date.now() - meta.startedAt) / 1000);
        activeMap.set(meta.port, {
          port: meta.port,
          pid: meta.pid,
          publicUrl: meta.publicUrl,
          wssUrl: meta.wssUrl,
          localUrl: meta.localUrl,
          serviceKind: meta.serviceKind,
          workspace: meta.workspace,
          workspaces: meta.workspaces,
          startedAt: meta.startedAt,
          uptimeSeconds: Math.max(0, uptime),
        });
      } else if (meta && !this.isTunnelCommandOwned(meta)) {
        clearTunnelState(p);
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
                if (isProcessRunning(meta.pid) && isOwnQuickTunnelProcessSync(meta.pid, meta.localUrl || "")) {
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
                  const candidate: TunnelMetadata = { ...meta, port: effectivePort };
                  if (this.hasExpectedTargetPort(candidate)) {
                    const uptime = Math.floor((Date.now() - (meta.startedAt || Date.now())) / 1000);
                    if (!activeMap.has(effectivePort)) {
                      activeMap.set(effectivePort, {
                        port: effectivePort,
                        pid: meta.pid,
                        publicUrl: meta.publicUrl,
                        wssUrl: meta.wssUrl,
                        localUrl: meta.localUrl,
                        serviceKind: meta.serviceKind,
                        workspace: meta.workspace,
                        workspaces: meta.workspaces,
                        startedAt: meta.startedAt,
                        uptimeSeconds: Math.max(0, uptime),
                      });
                    }
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
    for (const t of active) {
      try {
        const stopped = await this.stopQuickTunnel(t.port);
        if (stopped) stoppedCount++;
      } catch {}
    }
    // Deliberately no broad process scan or global state purge: only tunnels
    // whose recorded process identity was verified above are stopped/cleared.
    // Unclassified or foreign-owner state remains available for diagnostics.
    return stoppedCount;
  }



  /**
   * Retrieves the current status of the quick tunnel.
   */
  public getStatus(port?: number): TunnelStatus {
    let meta =
      (port ? this.activeMetadata.get(port) : this.currentMetadata) ||
      readTunnelState(port);

    if ((!meta || !meta.pid || !isProcessRunning(meta.pid)) && port === undefined) {
      const active = this.listActive();
      if (active.length > 0) {
        const best = active[0];
        meta = {
          pid: best.pid,
          publicUrl: best.publicUrl,
          wssUrl: best.wssUrl,
          localUrl: best.localUrl,
          port: best.port,
          serviceKind: best.serviceKind,
          workspace: best.workspace,
          workspaces: best.workspaces,
          startedAt: best.startedAt,
        };
        this.currentMetadata = meta;
        saveTunnelState(meta, best.port);
      }
    }

    if (!meta || !meta.pid) {
      return { isRunning: false };
    }

    const alive = this.isTunnelProcessAlive(meta);
    if (!alive && this.isTunnelCommandOwned(meta) && !this.hasExpectedTargetPort(meta)) {
      return {
        isRunning: false,
        port: meta.port,
        error: `Tunnel state on port ${meta.port} points to local target ${meta.localUrl}; state is preserved for explicit reconciliation.`,
      };
    }
    if (!alive) {
      if (typeof meta.port === "number") {
        clearTunnelState(meta.port);
      } else if (typeof port === "number") {
        clearTunnelState(port);
      } else {
        clearTunnelState(undefined);
      }
      // Status/cleanup of generic tunnel state must not mutate remote-agent config.
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
      serviceKind: meta.serviceKind,
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

export async function stopQuickTunnel(port?: number | "all", expectedServiceKind?: TunnelServiceKind): Promise<boolean> {
  return expectedServiceKind === undefined
    ? cloudflareTunnel.stopQuickTunnel(port)
    : cloudflareTunnel.stopQuickTunnel(port, expectedServiceKind);
}

export function claimTunnelServiceKind(
  port: number,
  serviceKind: Exclude<TunnelServiceKind, "unknown">,
  customConfigPath?: string
): TunnelMetadata | null {
  return cloudflareTunnel.claimServiceKind(port, serviceKind, customConfigPath);
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
      `   - Service kind : ${t.serviceKind || "unknown (legacy state)"}`,
      `   - Public URL   : ${t.publicUrl}`,
      ...(t.wssUrl ? [`   - WSS Endpoint : ${t.wssUrl}`] : []),
      `   - Local Target : ${t.localUrl}`,
    );
    if (t.workspace) {
      lines.push(`   - Workspace    : ${t.workspace}`);
    }
  });

  lines.push("", "Commands:", "  Stop specific tunnel : /muse tunnel stop --port <port>", "  Stop all tunnels     : /muse tunnel stop all  (all running tunnels and watchers across all workspaces)");
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
  const lines: string[] = ["Connect to my local Superagent workstation via WebSocket:", `- Endpoint: ${opts.wssUrl}`];
  if (opts.token) lines.push(`- Bearer Token: ${opts.token}`);
  if (opts.cfClientId) lines.push(`- CF-Access-Client-Id: ${opts.cfClientId}`);
  if (opts.cfClientSecret) lines.push(`- CF-Access-Client-Secret: ${opts.cfClientSecret}`);
  if (opts.workspaces && opts.workspaces.length > 0) {
    lines.push(`- Watched Projects: ${opts.workspaces.map((w) => path.basename(w)).join(", ")}`);
  }
  lines.push("");
  if (opts.task && opts.task.trim()) {
    const cleanTask = scrubSecrets(opts.task.trim(), [opts.token, opts.cfClientSecret]);
    lines.push("Task:", cleanTask, "", "Please connect to the WebSocket endpoint, inspect the workspace, and execute the task above.");
  } else {
    lines.push("Please connect to the WebSocket endpoint and confirm when you are ready to receive tasks.");
  }
  lines.push("", "Notes:", "- Tunnel URL is ephemeral: it changes on every cloudflared restart. If the connection drops, run `/muse tunnel start` again and send the new URL + bearer token.", "- Bearer token is shown once: treat it like a password, never share it.", "- Stop the tunnel anytime: `/muse tunnel stop`.");
  return lines.join("\n");
}

export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (process.platform === "win32") {
      await execa("powershell", ["-NoProfile", "-Command", "Set-Clipboard", "-Value", "$input"], headlessOpts({
        input: text,
        timeout: 2000,
        reject: false,
      }, "cloudflareTunnel.copyTextToClipboard.win"));
      return true;
    } else if (process.platform === "darwin") {
      await execa("pbcopy", [], headlessOpts({ input: text, timeout: 2000, reject: false }, "cloudflareTunnel.copyTextToClipboard.mac"));
      return true;
    } else if (process.platform === "linux") {
      try {
        await execa("wl-copy", [], headlessOpts({ input: text, timeout: 1500, reject: false }, "cloudflareTunnel.copyTextToClipboard.wl"));
        return true;
      } catch {
        await execa("xclip", ["-selection", "clipboard"], headlessOpts({ input: text, timeout: 1500, reject: false }, "cloudflareTunnel.copyTextToClipboard.xclip"));
        return true;
      }
    }
  } catch {}
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
    lines.push(`- Bearer Token     : ${opts.token}`, "", "Test with curl:", `curl -H "Authorization: Bearer ${opts.token}" ${opts.publicUrl}/api/status`);
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
  if (isServerRunningOnPort(port)) return;
  try {
    const { runServer } = await import("../../server.js");
    await runServer(port, true, "tline");
  } catch (err: any) {
    logE2E("REMOTE-AGENT", `ensureSuperagentServer error: ${err?.message}`);
  }
}

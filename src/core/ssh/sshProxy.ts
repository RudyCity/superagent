import { Client } from "ssh2";
import SFTPClient from "ssh2-sftp-client";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { SshWorkspaceConfig, workspaceMode } from "./workspaceMode.js";
import { sshLogger } from "./sshLogger.js";
import { getActiveQuestionHandler } from "../tools/state.js";

export interface SshSystemMetrics {
  host: string;
  user: string;
  osName: string;
  uptime: string;
  ramUsage: string;
  diskUsage: string;
  pingMs: number;
}

export type SshCacheMode = "strict" | "fast";

export function escapeShellArg(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/** Path to known_hosts file for host key verification */
function getKnownHostsPath(): string {
  return path.join(os.homedir(), ".superagent-r", "known_hosts");
}

/** Load known host keys from the known_hosts file. Returns Map<host, fingerprint> */
function loadKnownHosts(): Map<string, string> {
  const hosts = new Map<string, string>();
  try {
    const content = fs.readFileSync(getKnownHostsPath(), "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const [host, fingerprint] = trimmed.split(/\s+/);
      if (host && fingerprint) {
        hosts.set(host, fingerprint);
      }
    }
  } catch {
    // File doesn't exist yet — that's OK, first connection
  }
  return hosts;
}

/** Save a host key fingerprint to the known_hosts file */
function saveKnownHost(host: string, fingerprint: string): void {
  try {
    const knownHostsPath = getKnownHostsPath();
    const dir = path.dirname(knownHostsPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const entry = `${host} ${fingerprint}\n`;
    fs.appendFileSync(knownHostsPath, entry, "utf-8");
  } catch (err) {
    sshLogger.warn("host_key", `Failed to save known host: ${(err as Error).message}`);
  }
}

export class SshProxyService {
  private sshClient: Client | null = null;
  private sftpClient: SFTPClient | null = null;
  private config: SshWorkspaceConfig | null = null;
  private isConnecting = false;
  private connectPromise: Promise<void> | null = null;
  private passwordHandler?: () => Promise<string>;

  // SFTP In-memory Smart Cache
  private fileCache = new Map<string, { content: string; timestamp: number; mtime?: number }>();
  private cacheTtlMs = 30000; // 30s TTL
  private cacheMode: SshCacheMode = "strict";

  // S4: Tracked background PIDs for kill validation
  private trackedPids = new Set<string>();

  // Q4: Connection health monitoring
  private lastActivityTime = 0;
  private readonly healthCheckIntervalMs = 60000; // Check if idle > 60s

  public setPasswordHandler(handler: () => Promise<string>) {
    this.passwordHandler = handler;
  }

  public clearPasswordHandler() {
    this.passwordHandler = undefined;
  }

  // Q3: Configurable cache mode — "strict" validates mtime, "fast" trusts TTL
  public setCacheMode(mode: SshCacheMode) {
    this.cacheMode = mode;
  }

  public getCacheMode(): SshCacheMode {
    return this.cacheMode;
  }

  // S4: Track a background PID
  public trackPid(pid: string): void {
    this.trackedPids.add(pid);
  }

  // S4: Untrack a background PID
  public untrackPid(pid: string): void {
    this.trackedPids.delete(pid);
  }

  // S4: Check if a PID was started by Superagent
  public isPidTracked(pid: string): boolean {
    return this.trackedPids.has(pid);
  }

  private async resolvePassword(): Promise<string> {
    if (this.passwordHandler) {
      return this.passwordHandler();
    }
    const handler = getActiveQuestionHandler();
    if (!handler) {
      throw new Error(
        "SSH password required but no question handler is registered. Use sshProxy.setPasswordHandler() first."
      );
    }
    const host = this.config?.host ?? "unknown host";
    const user = this.config?.username ?? "unknown user";
    const result = await handler(
      `🔐 SSH password required for ${user}@${host}:`,
      [],
      false,
      undefined,
      "password"
    );
    if (Array.isArray(result)) {
      if (result.length === 0) return "";
      return String(result[0] ?? "");
    }
    return String(result ?? "");
  }

  public clearCache() {
    this.fileCache.clear();
  }

  public async connect(config: SshWorkspaceConfig): Promise<void> {
    if (this.connectPromise) {
      return this.connectPromise;
    }
    this.connectPromise = this._doConnect(config).finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  private async _doConnect(config: SshWorkspaceConfig): Promise<void> {
    this.config = config;
    this.isConnecting = true;
    this.clearCache();
    this.trackedPids.clear();
    sshLogger.info("connect", `connecting to ${config.host}:${config.port}`, {
      host: config.host,
      user: config.username,
      remoteCwd: config.remoteCwd,
    });

    try {
      const privateKey = config.privateKeyPath
        ? fs.readFileSync(config.privateKeyPath)
        : this.findDefaultPrivateKey();

      const connectConfig: any = {
        host: config.host,
        port: config.port,
        username: config.username,
        keepaliveInterval: 10000,
        keepaliveCountMax: 3,
        readyTimeout: 15000,
      };

      // S1: Host key verification via known_hosts
      const knownHosts = loadKnownHosts();
      const knownFingerprint = knownHosts.get(config.host);
      if (knownFingerprint) {
        connectConfig.hostVerifier = (key: Buffer): boolean => {
          const fingerprint = crypto.createHash("sha256").update(key).digest("hex");
          if (fingerprint === knownFingerprint) {
            sshLogger.info("host_key", `host key verified for ${config.host}`);
            return true;
          }
          sshLogger.error("host_key", `HOST KEY MISMATCH for ${config.host} — possible MITM attack`);
          return false;
        };
      } else {
        // First connection — accept and save the key (TOFU)
        connectConfig.hostVerifier = (key: Buffer): boolean => {
          const fingerprint = crypto.createHash("sha256").update(key).digest("hex");
          saveKnownHost(config.host, fingerprint);
          sshLogger.info("host_key", `first connection — saved host key for ${config.host}`);
          return true;
        };
      }

      if (config.password) {
        connectConfig.password = config.password;
      } else if (privateKey) {
        connectConfig.privateKey = privateKey;
      }

      try {
        await new Promise<void>((resolve, reject) => {
          const client = new Client();
          client
            .on("ready", () => {
              this.sshClient = client;
              resolve();
            })
            .on("error", (err) => {
              reject(new Error(`SSH connection failed to ${config.host}:${config.port} — ${err.message}`));
            })
            .connect(connectConfig);
        });
        sshLogger.info("connect", "connected (host key verified)", {
          host: config.host,
          user: config.username,
        });
      } catch (err: any) {
        const canPrompt = !config.password && err.message.includes("authentication");
        if (canPrompt) {
          const promptPassword = await this.resolvePassword();
          if (promptPassword) {
            config.password = promptPassword;
            connectConfig.password = promptPassword;
            delete connectConfig.privateKey;

            await new Promise<void>((resolve, reject) => {
              const client = new Client();
              client
                .on("ready", () => {
                  this.sshClient = client;
                  resolve();
                })
                .on("error", (err) => {
                  reject(new Error(`SSH connection failed with provided password to ${config.host}:${config.port} — ${err.message}`));
                })
                .connect(connectConfig);
            });
            sshLogger.info("connect", "connected via password auth");
          } else {
            throw err;
          }
        } else {
          throw err;
        }
      }

      // S2: Clear password from config after successful authentication
      if (config.password) {
        delete config.password;
        sshLogger.info("connect", "password cleared from config after auth");
      }

      this.sftpClient = new SFTPClient();
      await this.sftpClient.connect(connectConfig);
      sshLogger.info("connect", "SFTP session established");

      this.lastActivityTime = Date.now();
      this.isConnecting = false;
    } catch (err) {
      this.isConnecting = false;
      sshLogger.error("connect", `connection failed: ${(err as Error).message}`);
      await this.disconnect();
      throw err;
    }
  }

  private async ensureConnected(): Promise<void> {
    const isSocketDestroyed = (this.sshClient as any)?._sock?.destroyed || (this.sshClient as any)?._sock?.closed;
    if (!this.sshClient || !this.sftpClient || isSocketDestroyed) {
      if (this.config) {
        await this.disconnect();
        await this.connect(this.config);
      } else {
        throw new Error("SSH Proxy is not connected");
      }
      return;
    }

    // Q4: Connection health monitoring — check if session is still alive after idle period
    const idleTime = Date.now() - this.lastActivityTime;
    if (idleTime > this.healthCheckIntervalMs) {
      try {
        await this.exec("true", ".", 5000);
        sshLogger.debug("health", "keepalive check passed");
      } catch (err) {
        sshLogger.warn("health", `keepalive check failed — reconnecting: ${(err as Error).message}`);
        if (this.config) {
          await this.disconnect();
          await this.connect(this.config);
        } else {
          throw new Error("SSH Proxy is not connected");
        }
      }
    }
    this.lastActivityTime = Date.now();
  }

  private findDefaultPrivateKey(): Buffer | undefined {
    const defaultKeys = ["id_ed25519", "id_rsa", "id_ecdsa"];
    const sshDir = path.join(os.homedir(), ".ssh");

    for (const key of defaultKeys) {
      const keyPath = path.join(sshDir, key);
      if (fs.existsSync(keyPath)) {
        try {
          return fs.readFileSync(keyPath);
        } catch {
          // ignore
        }
      }
    }
    return undefined;
  }

  public normalizePosixPath(targetPath: string): string {
    // Defensive: treat null/undefined/non-string as "."
    const raw = typeof targetPath === "string" && targetPath.length > 0 ? targetPath : ".";
    let clean = raw.replace(/\\/g, "/");
    const base = this.config?.remoteCwd || workspaceMode.getConfig()?.remoteCwd || "/";
    const posixBase = base.replace(/\\/g, "/").replace(/\/+$/, "") || "/";

    let resolved: string;
    if (clean.startsWith("/")) {
      resolved = clean;
    } else {
      resolved = posixBase === "/" ? `/${clean}` : `${posixBase}/${clean}`;
    }

    const parts = resolved.split("/").reduce<string[]>((acc, seg) => {
      if (seg === "..") {
        acc.pop();
      } else if (seg !== "" && seg !== ".") {
        acc.push(seg);
      }
      return acc;
    }, []);

    const normalized = "/" + parts.join("/");
    const baseParts = posixBase.split("/").filter((p) => p !== "" && p !== ".");
    const normalizedBase = "/" + baseParts.join("/");

    if (
      normalizedBase !== "/" &&
      normalized !== normalizedBase &&
      !normalized.startsWith(normalizedBase + "/")
    ) {
      throw new Error(`Access denied: Path "${targetPath}" escapes remote workspace boundary "${posixBase}"`);
    }

    return normalized;
  }

  public async exec(
    command: string,
    cwd?: string,
    timeoutMs: number = 600000,
    signal?: AbortSignal
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    await this.ensureConnected();
    const workingDir = this.normalizePosixPath(cwd || ".");
    const fullCommand = `cd ${this.escapeShellArg(workingDir)} && ${command}`;

    let sshStream: any = null;

    const execPromise = new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve, reject) => {
      this.sshClient!.exec(fullCommand, (err, stream) => {
        if (err) return reject(err);
        sshStream = stream;

        let stdout = "";
        let stderr = "";
        let settled = false;
        let streamError: Error | null = null;

        const settle = (result: { stdout: string; stderr: string; exitCode: number } | Error) => {
          if (settled) return;
          settled = true;
          cleanup();
          if (result instanceof Error) {
            reject(result);
          } else {
            resolve(result);
          }
        };

        // Wire up AbortSignal: closing the channel kills the remote process.
        let abortHandler: (() => void) | null = null;
        if (signal) {
          if (signal.aborted) {
            try { stream.close(); } catch {}
            return settle(new Error("SSH execution aborted before start"));
          }
          abortHandler = () => {
            try { stream.close(); } catch {}
            settle(new Error("SSH execution aborted by signal"));
          };
          signal.addEventListener("abort", abortHandler);
        }

        const cleanup = () => {
          if (signal && abortHandler) {
            signal.removeEventListener("abort", abortHandler);
            abortHandler = null;
          }
        };

        // CRITICAL: wire `error` BEFORE `close` so synchronous stream errors don't get swallowed.
        stream.on("error", (streamErr: Error) => {
          streamError = streamErr;
          if (!stderr.includes(streamErr.message)) {
            stderr += (stderr ? "\n" : "") + `[stream error] ${streamErr.message}`;
          }
        });

        stream.on("data", (data: Buffer) => {
          stdout += data.toString();
        });

        stream.on("close", (code: number | null) => {
          const finalExit = (code !== null && code !== undefined && !isNaN(Number(code)))
            ? Number(code)
            : (streamError ? -1 : 0);
          settle({ stdout, stderr, exitCode: finalExit });
        });

        stream.stderr.on("data", (data: Buffer) => {
          stderr += data.toString();
        });

        stream.stderr.on("error", (streamErr: Error) => {
          if (!stderr.includes(streamErr.message)) {
            stderr += (stderr ? "\n" : "") + `[stderr error] ${streamErr.message}`;
          }
        });
      });
    });

    if (timeoutMs <= 0) return execPromise;

    let timer: NodeJS.Timeout;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // S5: Close the SSH stream to kill the remote process on timeout
        if (sshStream) {
          try { sshStream.close(); } catch {}
        }
        reject(new Error(`SSH execution timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    return Promise.race([execPromise, timeoutPromise]).finally(() => {
      clearTimeout(timer);
    });
  }

  public async execBackground(command: string, logFile: string = ".superagent-bg.log", cwd?: string): Promise<string> {
    await this.ensureConnected();
    const workingDir = this.normalizePosixPath(cwd || ".");
    const normalizedLog = this.normalizePosixPath(logFile);
    const bgCommand = `nohup bash -c ${this.escapeShellArg(command)} > ${this.escapeShellArg(normalizedLog)} 2>&1 & echo $!`;
    const res = await this.exec(bgCommand, workingDir);
    const pid = res.stdout.trim();
    // S4: Track the PID for kill validation
    if (pid) {
      this.trackPid(pid);
    }
    return pid;
  }

  public async stat(remotePath: string): Promise<{ size: number; mtime: number; isFile: boolean; isDirectory: boolean }> {
    await this.ensureConnected();
    const target = this.normalizePosixPath(remotePath);
    const stat = await this.sftpClient!.stat(target);
    return {
      size: stat.size,
      mtime: stat.modifyTime,
      isFile: !!stat.isFile,
      isDirectory: !!stat.isDirectory,
    };
  }

  public async readFile(remotePath: string, options?: { skipCache?: boolean }): Promise<string> {
    await this.ensureConnected();
    const target = this.normalizePosixPath(remotePath);
    const now = Date.now();

    // Mtime-aware cache: validate file hasn't changed since cached.
    // Q3: In "fast" mode, skip the mtime stat check and trust the TTL.
    if (!options?.skipCache) {
      const cached = this.fileCache.get(target);
      if (cached && now - cached.timestamp < this.cacheTtlMs) {
        if (this.cacheMode === "fast") {
          // Fast mode: trust cache within TTL without mtime validation
          return cached.content;
        }
        // Strict mode: validate mtime
        try {
          const currentStat = await this.sftpClient!.stat(target);
          if (cached.mtime !== undefined && currentStat.modifyTime === cached.mtime) {
            return cached.content;
          }
          // File was modified externally — invalidate cache.
          this.fileCache.delete(target);
        } catch {
          // Stat failed (file deleted, perms changed) — invalidate.
          this.fileCache.delete(target);
        }
      }
    }

    const buffer = await this.sftpClient!.get(target);
    let content: string;
    if (Buffer.isBuffer(buffer) || Array.isArray(buffer)) {
      const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer as any);
      const checkLength = Math.min(buf.length, 8192);
      for (let i = 0; i < checkLength; i++) {
        if (buf[i] === 0) {
          throw new Error(`Cannot read binary file "${remotePath}" over SSH as text`);
        }
      }
      content = buf.toString("utf-8");
    } else {
      content = String(buffer);
    }
    let mtime: number | undefined;
    try {
      mtime = (await this.sftpClient!.stat(target)).modifyTime;
    } catch {}
    this.fileCache.set(target, { content, timestamp: now, mtime });
    return content;
  }

  public async writeFile(remotePath: string, content: string): Promise<void> {
    await this.ensureConnected();
    const target = this.normalizePosixPath(remotePath);
    const parentDir = path.posix.dirname(target);
    await this.sftpClient!.mkdir(parentDir, true);
    await this.sftpClient!.put(Buffer.from(content, "utf-8"), target);

    // Update smart cache
    this.fileCache.set(target, { content, timestamp: Date.now() });
  }

  public async listFiles(remoteDir?: string): Promise<Array<{ name: string; isDirectory: boolean; size: number }>> {
    await this.ensureConnected();
    const target = this.normalizePosixPath(remoteDir || ".");
    const list = await this.sftpClient!.list(target);
    return list.map((item) => ({
      name: item.name,
      isDirectory: item.type === "d",
      size: item.size,
    }));
  }

  public async getSystemMetrics(): Promise<SshSystemMetrics> {
    await this.ensureConnected();
    const start = Date.now();

    const script = `uname -sr; uptime -p 2>/dev/null || uptime; free -h 2>/dev/null | awk '/Mem:/ {print $3 "/" $2}'; df -h . | awk 'NR==2 {print $3 "/" $2 " (" $5 ")"}'`;
    const res = await this.exec(script);
    const pingMs = Date.now() - start;

    const lines = res.stdout.trim().split("\n");
    return {
      host: this.config?.host || "unknown",
      user: this.config?.username || "unknown",
      osName: lines[0] || "Linux/POSIX",
      uptime: lines[1] || "unknown",
      ramUsage: lines[2] || "N/A",
      diskUsage: lines[3] || "N/A",
      pingMs,
    };
  }

  public async disconnect(): Promise<void> {
    this.clearCache();
    this.trackedPids.clear();

    if (this.sftpClient) {
      try {
        await this.sftpClient.end();
      } catch {}
      this.sftpClient = null;
    }

    if (this.sshClient) {
      try {
        this.sshClient.removeAllListeners();
        this.sshClient.end();
      } catch {}
      this.sshClient = null;
    }
  }

  /**
   * Diagnose the SSH workspace connection: runs `pwd` and `whoami` to confirm
   * the remote shell is functional. Returns a diagnostic report on success
   * or a detailed error string on failure.
   */
  public async diagnose(): Promise<
    | { ok: true; pwd: string; user: string; remoteCwd: string; host: string }
    | { ok: false; error: string }
  > {
    try {
      await this.ensureConnected();
      const host = this.config?.host || "unknown";
      const remoteCwd = this.config?.remoteCwd || "/";
      const pwdRes = await this.exec("pwd", ".", 10000);
      const whoamiRes = await this.exec("whoami", ".", 10000);
      if (pwdRes.exitCode !== 0 || whoamiRes.exitCode !== 0) {
        return {
          ok: false,
          error: `pwd exit=${pwdRes.exitCode} stdout="${pwdRes.stdout.trim()}" stderr="${pwdRes.stderr.trim()}" | whoami exit=${whoamiRes.exitCode} stderr="${whoamiRes.stderr.trim()}"`,
        };
      }
      const pwd = pwdRes.stdout.trim();
      const user = whoamiRes.stdout.trim();
      return { ok: true, pwd, user, remoteCwd, host };
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) };
    }
  }

  public escapeShellArg(arg: string): string {
    return escapeShellArg(arg);
  }
}

export const sshProxy = new SshProxyService();
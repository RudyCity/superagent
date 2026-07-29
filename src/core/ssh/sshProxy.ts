import { Client } from "ssh2";
import SFTPClient from "ssh2-sftp-client";
import fs from "fs";
import os from "os";
import path from "path";
import { SshWorkspaceConfig, workspaceMode } from "./workspaceMode.js";
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

export function escapeShellArg(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
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

  public setPasswordHandler(handler: () => Promise<string>) {
    this.passwordHandler = handler;
  }

  public clearPasswordHandler() {
    this.passwordHandler = undefined;
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
          } else {
            throw err;
          }
        } else {
          throw err;
        }
      }

      this.sftpClient = new SFTPClient();
      await this.sftpClient.connect(connectConfig);

      this.isConnecting = false;
    } catch (err) {
      this.isConnecting = false;
      await this.disconnect();
      throw err;
    }
  }

  private async ensureConnected(): Promise<void> {
    if (!this.sshClient || !this.sftpClient) {
      if (this.config) {
        await this.connect(this.config);
      } else {
        throw new Error("SSH Proxy is not connected");
      }
    }
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

    const execPromise = new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve, reject) => {
      this.sshClient!.exec(fullCommand, (err, stream) => {
        if (err) return reject(err);

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
        // ssh2 emits close with code=null on stream errors; without an error listener the promise
        // would resolve with empty stdout and exitCode 0 — masking the real failure.
        stream.on("error", (streamErr: Error) => {
          streamError = streamErr;
          // Don't settle here — wait for close to fire so we can include any buffered output.
          if (!stderr.includes(streamErr.message)) {
            stderr += (stderr ? "\n" : "") + `[stream error] ${streamErr.message}`;
          }
        });

        stream.on("data", (data: Buffer) => {
          stdout += data.toString();
        });

        stream.on("close", (code: number | null) => {
          // Resolve with:
          //  - exit code if non-null
          //  - else -1 if stream errored (real failure, not silent success)
          //  - else 0 for normal completion
          const finalExit = code !== null && code !== undefined
            ? code
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
    return res.stdout.trim();
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
    if (!options?.skipCache) {
      const cached = this.fileCache.get(target);
      if (cached && now - cached.timestamp < this.cacheTtlMs) {
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
   *
   * Use this after `connect()` to surface real errors (auth, network, invalid cwd)
   * instead of silently returning empty stdout from later commands.
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

import { Client } from "ssh2";
import SFTPClient from "ssh2-sftp-client";
import fs from "fs";
import os from "os";
import path from "path";
import { SshWorkspaceConfig } from "./workspaceMode.js";

export interface SshSystemMetrics {
  host: string;
  user: string;
  osName: string;
  uptime: string;
  ramUsage: string;
  diskUsage: string;
  pingMs: number;
}

export class SshProxyService {
  private sshClient: Client | null = null;
  private sftpClient: SFTPClient | null = null;
  private config: SshWorkspaceConfig | null = null;
  private isConnecting = false;
  private passwordHandler?: () => Promise<string>;
  
  // SFTP In-memory Smart Cache
  private fileCache = new Map<string, { content: string; timestamp: number; mtime?: number }>();
  private cacheTtlMs = 30000; // 30s TTL

  public setPasswordHandler(handler: () => Promise<string>) {
    this.passwordHandler = handler;
  }

  public clearCache() {
    this.fileCache.clear();
  }

  public async connect(config: SshWorkspaceConfig): Promise<void> {
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
        if (!config.password && this.passwordHandler && err.message.includes("authentication")) {
          const promptPassword = await this.passwordHandler();
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
      if (this.config && !this.isConnecting) {
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
    let clean = targetPath.replace(/\\/g, "/");
    if (path.isAbsolute(targetPath) || clean.startsWith("/")) {
      return clean;
    }
    const base = this.config?.remoteCwd || "/";
    const posixBase = base.replace(/\\/g, "/");
    return posixBase.endsWith("/") ? `${posixBase}${clean}` : `${posixBase}/${clean}`;
  }

  public async exec(command: string, cwd?: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    await this.ensureConnected();
    const workingDir = this.normalizePosixPath(cwd || ".");
    const fullCommand = `cd ${this.escapeShellArg(workingDir)} && ${command}`;

    return new Promise((resolve, reject) => {
      this.sshClient!.exec(fullCommand, (err, stream) => {
        if (err) return reject(err);

        let stdout = "";
        let stderr = "";

        stream
          .on("close", (code: number) => {
            resolve({ stdout, stderr, exitCode: code || 0 });
          })
          .on("data", (data: Buffer) => {
            stdout += data.toString();
          })
          .stderr.on("data", (data: Buffer) => {
            stderr += data.toString();
          });
      });
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

  public async readFile(remotePath: string): Promise<string> {
    await this.ensureConnected();
    const target = this.normalizePosixPath(remotePath);
    const now = Date.now();

    const cached = this.fileCache.get(target);
    if (cached && now - cached.timestamp < this.cacheTtlMs) {
      return cached.content;
    }

    const buffer = await this.sftpClient!.get(target);
    const content = buffer.toString("utf-8");

    this.fileCache.set(target, { content, timestamp: now });
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
        this.sshClient.end();
      } catch {}
      this.sshClient = null;
    }
  }

  private escapeShellArg(arg: string): string {
    return `'${arg.replace(/'/g, "'\\''")}'`;
  }
}

export const sshProxy = new SshProxyService();

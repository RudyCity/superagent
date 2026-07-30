import fs from "fs";
import path from "path";
import os from "os";
import { workspaceMode } from "./workspaceMode.js";

const LOG_DIR = path.join(os.homedir(), ".superagent-r");
const LOG_FILE = path.join(LOG_DIR, "ssh-workspace.log");
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

export type SshLogLevel = "INFO" | "WARN" | "ERROR" | "DEBUG" | "BOUNDARY";

export interface SshLogEntry {
  ts: string;
  level: SshLogLevel;
  operation: string;
  host?: string;
  user?: string;
  remoteCwd?: string;
  msg: string;
  durationMs?: number;
  exitCode?: number;
  path?: string;
  fileSize?: number;
  cacheHit?: boolean;
  error?: string;
  stack?: string;
  /** Additional structured metadata */
  meta?: Record<string, unknown>;
}

class SshLogger {
  private logStream: fs.WriteStream | null = null;
  private byteCount = 0;
  private initAttempted = false;

  private ensureStream(): fs.WriteStream | null {
    if (this.logStream) return this.logStream;
    if (this.initAttempted) return null;
    this.initAttempted = true;

    try {
      if (!fs.existsSync(LOG_DIR)) {
        fs.mkdirSync(LOG_DIR, { recursive: true });
      }
      // Truncate if oversized
      try {
        const stat = fs.statSync(LOG_FILE);
        if (stat.size > MAX_BYTES) {
          fs.writeFileSync(LOG_FILE, ""); // clear
        }
        this.byteCount = stat.size;
      } catch {
        // file doesn't exist yet
        this.byteCount = 0;
      }

      this.logStream = fs.createWriteStream(LOG_FILE, { flags: "a" });
    } catch {
      // fail silently — logging must never crash app
      return null;
    }
    return this.logStream;
  }

  private write(level: SshLogLevel, operation: string, msg: string, extra?: Partial<SshLogEntry>): void {
    const stream = this.ensureStream();
    if (!stream) return;

    const config = workspaceMode.getConfig();
    const entry: SshLogEntry = {
      ts: new Date().toISOString(),
      level,
      operation,
      msg,
      host: config?.host,
      user: config?.username,
      remoteCwd: config?.remoteCwd,
      ...extra,
    };

    const line = JSON.stringify(entry) + "\n";
    const bytes = Buffer.byteLength(line);

    // Rotate if approaching limit
    if (this.byteCount + bytes > MAX_BYTES) {
      try {
        stream.end();
        fs.writeFileSync(LOG_FILE, line); // restart fresh
        this.logStream = fs.createWriteStream(LOG_FILE, { flags: "a" });
        this.byteCount = bytes;
      } catch {
        // ignore
      }
      return;
    }

    this.byteCount += bytes;
    stream.write(line);
  }

  // -- Public API --

  public info(operation: string, msg: string, extra?: Partial<SshLogEntry>): void {
    this.write("INFO", operation, msg, extra);
  }

  public warn(operation: string, msg: string, extra?: Partial<SshLogEntry>): void {
    this.write("WARN", operation, msg, extra);
  }

  public error(operation: string, msg: string, extra?: Partial<SshLogEntry>): void {
    this.write("ERROR", operation, msg, extra);
  }

  public debug(operation: string, msg: string, extra?: Partial<SshLogEntry>): void {
    this.write("DEBUG", operation, msg, extra);
  }

  /** Dedicated BOUNDARY level for workspace boundary violations */
  public boundary(operation: string, msg: string, extra?: Partial<SshLogEntry>): void {
    this.write("BOUNDARY", operation, msg, extra);
  }

  /** Close stream — call on process exit */
  public close(): void {
    if (this.logStream) {
      this.logStream.end();
      this.logStream = null;
    }
  }
}

export const sshLogger = new SshLogger();

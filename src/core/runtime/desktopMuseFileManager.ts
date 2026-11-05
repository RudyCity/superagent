import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getRootConfigDir } from "../config/paths.js";
import { loadRemoteAgentConfig } from "../remoteAgent/config.js";
import { FILE_TRANSFER_MAX_BYTES, resolveTransferSource } from "../remoteAgent/museFileTransfer.js";
import { getMuseWatcherStrict } from "../remoteAgent/museWatcherRegistry.js";
import { MuseClient } from "../remoteAgent/museClient.js";

export type DesktopTransferPhase = "queued" | "transferring" | "paused" | "completed" | "failed" | "cancelled";
export type DesktopTransferKind = "muse-websocket" | "telegram";
export interface DesktopTransferJob {
  id: string;
  name: string;
  filePath: string; // Internal native-only; never send to the WebView.
  size: number;
  kind: DesktopTransferKind;
  state: DesktopTransferPhase;
  bytes: number;
  percent: number;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  error?: string;
  sha256?: string;
  transferId?: string;
  resumed?: boolean;
  verification?: "sha256-acknowledged" | "telegram-accepted";
  port?: number;
}
export interface DesktopFileSettings {
  version: 1;
  maxFileMiB: number;
  historyDays: number;
  refreshSeconds: number;
  defaultTransport: DesktopTransferKind;
}
const DEFAULT_SETTINGS: DesktopFileSettings = {
  version: 1, maxFileMiB: 8, historyDays: 7,
  refreshSeconds: 2, defaultTransport: "muse-websocket",
};
const MAX_HISTORY = 80;

function validateSettings(candidate: unknown): DesktopFileSettings {
  const value = candidate as Partial<DesktopFileSettings> | null;
  if (!value || Array.isArray(value) || typeof value !== "object" ||
    Object.keys(value).sort().join(",") !==
      "defaultTransport,historyDays,maxFileMiB,refreshSeconds,version" ||
    value.version !== 1 ||
    ![1, 2, 4, 6, 8].includes(value.maxFileMiB as number) ||
    ![1, 7, 14, 30].includes(value.historyDays as number) ||
    ![1, 2, 5, 10].includes(value.refreshSeconds as number) ||
    !["muse-websocket", "telegram"].includes(String(value.defaultTransport))) {
    throw new Error("Invalid Muse File Transfer settings");
  }
  return value as DesktopFileSettings;
}

function atomicJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + "." + randomUUID() + ".tmp";
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { flag: "wx", mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* already renamed */ }
  }
}

function loadJson(file: string): unknown {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128_000)
      throw new Error("Invalid Muse transfer storage metadata");
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function publicJob(job: DesktopTransferJob) {
  const { filePath: _privateFilePath, ...publicFields } = job;
  return publicFields;
}

export class DesktopMuseFileManager {
  private readonly historyPath: string;
  private readonly preferencesPath: string;
  private settings: DesktopFileSettings;
  private jobs: DesktopTransferJob[];
  private active: Promise<void> | null = null;
  private activeJobId: string | null = null;
  private starting = false;
  private resuming = false;

  constructor(directory = getRootConfigDir()) {
    this.historyPath = path.join(directory, "muse-desktop-file-history.json");
    this.preferencesPath = path.join(directory, "muse-desktop-file-settings.json");
    const loadedSettings = loadJson(this.preferencesPath);
    this.settings = loadedSettings === null ? { ...DEFAULT_SETTINGS } : validateSettings(loadedSettings);
    const rawHistory = loadJson(this.historyPath);
    this.jobs = Array.isArray(rawHistory)
      ? rawHistory.filter((x: any) =>
          x && typeof x.id === "string" && typeof x.filePath === "string" &&
          typeof x.name === "string" && Number.isSafeInteger(x.size) &&
          ["queued", "transferring", "paused", "completed", "failed", "cancelled"].includes(x.state))
        .slice(0, MAX_HISTORY).map((x: DesktopTransferJob) =>
          x.state === "transferring" || x.state === "queued"
            ? { ...x, state: "paused" as const, error: "Process restarted; select Resume to continue." }
            : x)
      : [];
    this.prune();
  }

  private prune() {
    const cutoff = Date.now() - this.settings.historyDays * 86_400_000;
    this.jobs = this.jobs
      .filter(j => Math.max(j.startedAt, j.updatedAt) >= cutoff ||
        ["transferring", "paused", "queued"].includes(j.state))
      .slice(0, MAX_HISTORY);
  }
  private persist() {
    this.prune();
    atomicJson(this.historyPath, this.jobs);
  }
  private watcher(port: number) {
    const watcher = getMuseWatcherStrict(port);
    if (!watcher || !watcher.isActive() ||
      watcher.getTransport().type !== "websocket" ||
      !watcher.getTransport().isConnected()) {
      throw new Error("Muse watcher is not connected in this Core process. Connect the authenticated Muse WebSocket first.");
    }
    return watcher;
  }
  /** Used by graceful shutdown/tests so the final transfer ledger is flushed. */
  public async waitForIdle(): Promise<void> {
    if (this.active) await this.active;
  }

  public getSettings() { return { ...this.settings }; }
  public updateSettings(value: unknown) {
    const candidate = validateSettings(value);
    atomicJson(this.preferencesPath, candidate);
    this.settings = candidate;
    this.prune();
    this.persist();
    return this.getSettings();
  }

  public status() {
    const config = loadRemoteAgentConfig();
    const port = config.wsPort || 9225;
    const watcher = getMuseWatcherStrict(port);
    const connected = Boolean(watcher && watcher.isActive() &&
      watcher.getTransport().type === "websocket" && watcher.getTransport().isConnected());
    const telegramConfigured = Boolean(config.botToken && config.groupId);
    const activeJob = this.jobs.find(j => j.id === this.activeJobId);
    if (activeJob?.state === "transferring" && activeJob.kind === "muse-websocket" && watcher) {
      const status = watcher.getFileTransferStatus();
      if (status.state === "transferring" || status.state === "completed") {
        activeJob.bytes = status.bytes;
        activeJob.percent = status.percent;
        activeJob.resumed = status.resumed;
        activeJob.transferId = status.transferId ?? activeJob.transferId;
      }
    }
    return {
      success: true, port, watcherConnected: connected,
      watcherActive: Boolean(watcher?.isActive()), telegramConfigured,
      activeJobId: this.activeJobId,
      active: activeJob ? publicJob(activeJob) : null,
      history: this.jobs.map(publicJob),
      settings: this.getSettings(),
    };
  }

  public async start(filePath: string, kind: DesktopTransferKind, requestedPort?: number) {
    if (this.active || this.starting || this.resuming) {
      throw new Error("A transfer is running or starting. Finish it before starting another.");
    }
    this.starting = true;
    try {
    if (!["muse-websocket", "telegram"].includes(kind)) throw new Error("Unsupported transfer transport");
    if (typeof filePath !== "string" || !path.isAbsolute(filePath)) throw new Error("Choose a file with the native file picker");
    // The Rust IPC command never accepts caller-controlled paths: only its
    // one-shot dialog selection is forwarded to this authenticated loopback API.
    const resolved = await resolveTransferSource(filePath, path.dirname(filePath));
    const stat = fs.statSync(resolved);
    if (stat.size > this.settings.maxFileMiB * 1048576 ||
        stat.size > FILE_TRANSFER_MAX_BYTES) throw new Error("File exceeds configured transfer limit");
    const config = loadRemoteAgentConfig();
    const port = requestedPort ?? config.wsPort ?? 9225;
    if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid Muse port");
    if (kind === "muse-websocket") this.watcher(port);
    else if (!config.botToken || !config.groupId) throw new Error("Telegram bot/group is not configured");
    const now = Date.now();
    const job: DesktopTransferJob = {
      id: randomUUID(), filePath: resolved, name: path.basename(resolved), size: stat.size,
      kind, state: "queued", bytes: 0, percent: 0, startedAt: now,
      updatedAt: now, port,
    };
    this.jobs.unshift(job);
    this.persist();
    this.run(job);
    return { success: true, job: publicJob(job) };
    } finally {
      this.starting = false;
    }
  }

  private run(job: DesktopTransferJob) {
    this.activeJobId = job.id;
    job.state = "transferring";
    job.updatedAt = Date.now();
    this.persist();
    const work = (async () => {
      try {
        if (job.kind === "muse-websocket") {
          const receipt = await this.watcher(job.port || 9225)
            .sendFile(job.filePath, path.dirname(job.filePath));
          if (job.state !== "transferring") return;
          job.bytes = receipt.size;
          job.percent = 100;
          job.sha256 = receipt.sha256;
          job.transferId = receipt.transferId;
          job.verification = "sha256-acknowledged";
        } else {
          const config = loadRemoteAgentConfig();
          const receipt = await new MuseClient(config).sendDocument(
            String(config.groupId), job.filePath,
          );
          if (job.state !== "transferring") return;
          job.bytes = job.size;
          job.percent = 100;
          job.sha256 = receipt.sha256;
          job.verification = "telegram-accepted"; // NOT proof of Muse ingestion.
        }
        job.state = "completed";
        job.error = undefined;
      } catch (error: any) {
        if (job.state === "transferring") {
          job.state = "failed";
          job.error = String(error?.message || error).slice(0, 300);
        }
      } finally {
        job.finishedAt = Date.now();
        job.updatedAt = Date.now();
        this.persist();
      }
    })();
    this.active = work;
    const settle = () => {
      if (this.active === work) {
        this.active = null;
        this.activeJobId = null;
      }
    };
    // Promise.finally() creates a second rejected promise if final persistence
    // fails; always consume the rejection instead of leaking an unhandled one.
    void work.then(settle, (error) => {
      console.error("[MuseFileTransfer] Final transfer persistence failed:", error);
      settle();
    });
  }

  public pause(id: string) {
    const job = this.jobs.find(j => j.id === id);
    if (!job || this.activeJobId !== id || job.state !== "transferring" ||
        job.kind !== "muse-websocket") throw new Error("Only an active WebSocket transfer can be paused");
    // Even if the network disconnected, a registered watcher can still
    // abort its pending ACK wait. Do not require a *connected* socket for pause.
    const watcher = getMuseWatcherStrict(job.port || 9225);
    if (!watcher?.cancelFileTransfer()) {
      throw new Error("Muse file sender is no longer active; retry after it times out");
    }
    job.state = "paused";
    job.updatedAt = Date.now();
    this.persist();
    return { success: true, job: publicJob(job) };
  }

  public async resume(id: string) {
    if (this.resuming || this.starting) throw new Error("Another transfer is already starting");
    this.resuming = true;
    try {
    const job = this.jobs.find(j => j.id === id);
    if (!job || !["paused", "failed", "cancelled"].includes(job.state)) {
      throw new Error("Only paused, failed or cancelled uploads can be resumed");
    }
    if (job.kind === "telegram") throw new Error("Telegram sendDocument cannot safely resume after ambiguous failure");
    if (this.active) await this.active;
    if (this.active) throw new Error("Another transfer is active");
    await resolveTransferSource(job.filePath, path.dirname(job.filePath));
    this.watcher(job.port || 9225);
    job.error = undefined;
    job.finishedAt = undefined;
    this.jobs = [job, ...this.jobs.filter(entry => entry.id !== job.id)];
    this.run(job);
    return { success: true, job: publicJob(job) };
    } finally {
      this.resuming = false;
    }
  }

  public cancel(id: string) {
    const job = this.jobs.find(j => j.id === id);
    if (!job || job.state === "completed" ||
        !["paused", "failed", "cancelled", "transferring"].includes(job.state)) {
      throw new Error("Cannot cancel that transfer");
    }
    if (job.state === "transferring" && job.kind === "telegram")
      throw new Error("Telegram multipart send cannot safely be cancelled after submission");
    if (job.state === "transferring") {
      const watcher = getMuseWatcherStrict(job.port || 9225);
      if (!watcher?.cancelFileTransfer()) {
        throw new Error("Muse file sender is no longer active; retry after it times out");
      }
    }
    job.state = "cancelled";
    job.updatedAt = Date.now();
    this.persist();
    return { success: true, job: publicJob(job) };
  }
}

let singleton: DesktopMuseFileManager | null = null;
export function getDesktopMuseFileManager() {
  return singleton ?? (singleton = new DesktopMuseFileManager());
}

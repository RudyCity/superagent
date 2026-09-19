import fs from "fs";
import path from "path";
import os from "os";
import { DaemonJob, DaemonStatus, DaemonConfig } from "./daemonTypes.js";
import { matchesCron, getNextCronTime, isValidCron } from "./cronParser.js";

const DEFAULT_CONFIG: DaemonConfig = {
  tickIntervalMs: 30000,
  maxConcurrentJobs: 3
};

export class DaemonScheduler {
  private jobsPath: string;
  private logPath: string;
  private jobs: Map<string, DaemonJob> = new Map();
  private runningJobIds: Set<string> = new Set();
  private lastExecutedMinuteMap: Map<string, string> = new Map();
  private tickTimer: NodeJS.Timeout | null = null;
  private startedAt: number | null = null;
  private config: DaemonConfig;
  private agentRunner?: (prompt: string, workspace: string, mode: "single" | "multi") => Promise<string>;

  constructor(customConfigDir?: string, agentRunner?: (prompt: string, workspace: string, mode: "single" | "multi") => Promise<string>) {
    const baseDir = customConfigDir || path.join(os.homedir(), ".superagent-r");
    this.jobsPath = path.join(baseDir, "daemon-jobs.json");
    this.logPath = path.join(baseDir, "daemon.log");
    this.config = { ...DEFAULT_CONFIG };
    this.agentRunner = agentRunner;
    this.loadJobs();
  }

  public setAgentRunner(runner: (prompt: string, workspace: string, mode: "single" | "multi") => Promise<string>) {
    this.agentRunner = runner;
  }

  public log(message: string): void {
    const ts = new Date().toISOString();
    const line = `[${ts}] [DAEMON] ${message}\n`;
    try {
      const dir = path.dirname(this.logPath);
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(this.logPath, line, "utf-8");
    } catch {}
  }

  public listJobs(): DaemonJob[] {
    return Array.from(this.jobs.values());
  }

  public getJob(id: string): DaemonJob | null {
    return this.jobs.get(id) || null;
  }

  public isJobRunning(id: string): boolean {
    return this.runningJobIds.has(id);
  }

  public addJob(params: {
    name: string;
    cronExpression: string;
    prompt: string;
    workspace?: string;
    mode?: "single" | "multi";
    enabled?: boolean;
    notifyGateway?: boolean;
    maxRuns?: number;
    tags?: string[];
  }): DaemonJob {
    if (!isValidCron(params.cronExpression)) {
      throw new Error(`Invalid cron expression: "${params.cronExpression}"`);
    }

    const id = `job_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    let nextRun: number | undefined;
    try {
      nextRun = getNextCronTime(params.cronExpression).getTime();
    } catch {}

    const job: DaemonJob = {
      id,
      name: params.name,
      cronExpression: params.cronExpression,
      prompt: params.prompt,
      workspace: params.workspace || process.cwd(),
      mode: params.mode || "single",
      enabled: params.enabled !== undefined ? params.enabled : true,
      createdAt: Date.now(),
      nextRun,
      runCount: 0,
      maxRuns: params.maxRuns,
      notifyGateway: params.notifyGateway,
      tags: params.tags
    };

    this.jobs.set(id, job);
    this.saveJobs();
    this.log(`Job added: ${job.name} (${job.id}) [Cron: ${job.cronExpression}]`);
    return job;
  }

  public updateJob(id: string, updates: Partial<DaemonJob>): DaemonJob | null {
    const job = this.jobs.get(id);
    if (!job) return null;

    if (updates.cronExpression && updates.cronExpression !== job.cronExpression) {
      if (!isValidCron(updates.cronExpression)) {
        throw new Error(`Invalid cron expression: "${updates.cronExpression}"`);
      }
      try {
        job.nextRun = getNextCronTime(updates.cronExpression).getTime();
      } catch {}
    }

    const updated: DaemonJob = {
      ...job,
      ...updates,
      id: job.id, // Immutable
      createdAt: job.createdAt
    };

    this.jobs.set(id, updated);
    this.saveJobs();
    this.log(`Job updated: ${updated.name} (${updated.id})`);
    return updated;
  }

  public deleteJob(id: string): boolean {
    const existed = this.jobs.delete(id);
    if (existed) {
      this.saveJobs();
      this.log(`Job deleted: ${id}`);
    }
    return existed;
  }

  public startDaemon(tickIntervalMs?: number): void {
    if (this.tickTimer) return;
    this.startedAt = Date.now();
    const interval = tickIntervalMs || this.config.tickIntervalMs;
    this.log(`Daemon started. Ticking every ${interval}ms`);

    // Run initial tick immediately
    this.tick();
    this.tickTimer = setInterval(() => {
      this.tick();
    }, interval);
  }

  public stopDaemon(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
      this.log("Daemon stopped.");
    }
    this.startedAt = null;
  }

  public isRunning(): boolean {
    return this.tickTimer !== null;
  }

  public getStatus(): DaemonStatus {
    const now = Date.now();
    return {
      running: this.isRunning(),
      pid: process.pid,
      uptime: this.startedAt ? Math.floor((now - this.startedAt) / 1000) : 0,
      activeJobsCount: this.runningJobIds.size,
      totalJobsCount: this.jobs.size,
      lastTickAt: now
    };
  }

  public async triggerJobNow(id: string): Promise<{ success: boolean; output?: string; error?: string }> {
    const job = this.jobs.get(id);
    if (!job) {
      return { success: false, error: `Job not found: ${id}` };
    }
    if (this.runningJobIds.has(id)) {
      return { success: false, error: `Job ${id} is already running` };
    }

    return await this.executeJob(job);
  }

  private tick(): void {
    const now = new Date();
    const currentMinuteKey = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;

    for (const job of this.jobs.values()) {
      if (!job.enabled) continue;

      if (job.maxRuns && job.runCount >= job.maxRuns) {
        job.enabled = false;
        this.saveJobs();
        this.log(`Job ${job.name} (${job.id}) reached maxRuns (${job.maxRuns}). Disabling.`);
        continue;
      }

      // Check if job matches cron and has not run this minute
      const lastRunKey = this.lastExecutedMinuteMap.get(job.id);
      if (lastRunKey === currentMinuteKey) {
        continue;
      }

      if (matchesCron(job.cronExpression, now)) {
        if (this.runningJobIds.has(job.id)) {
          this.log(`Job ${job.name} (${job.id}) matched cron but is already running. Skipping overlapping execution.`);
          continue;
        }

        if (this.runningJobIds.size >= this.config.maxConcurrentJobs) {
          this.log(`Max concurrent jobs limit (${this.config.maxConcurrentJobs}) reached. Deferring ${job.name}.`);
          continue;
        }

        this.lastExecutedMinuteMap.set(job.id, currentMinuteKey);
        this.executeJob(job).catch(err => {
          this.log(`Job ${job.name} execution error: ${err.message || String(err)}`);
        });
      }
    }
  }

  private async executeJob(job: DaemonJob): Promise<{ success: boolean; output?: string; error?: string }> {
    const startTime = Date.now();
    this.runningJobIds.add(job.id);
    job.lastStatus = "running";
    job.lastRun = startTime;
    try {
      job.nextRun = getNextCronTime(job.cronExpression, new Date(startTime)).getTime();
    } catch {}
    this.saveJobs();
    this.log(`Executing job: ${job.name} (${job.id})`);

    let output = "";
    let error: string | undefined;

    try {
      if (this.agentRunner) {
        output = await this.agentRunner(job.prompt, job.workspace, job.mode);
      } else {
        // Built-in headless execution fallback
        output = await this.defaultHeadlessRunner(job);
      }

      job.lastStatus = "success";
      job.lastError = undefined;
      job.runCount++;
      job.lastRunDurationMs = Date.now() - startTime;
      this.log(`Job completed successfully: ${job.name} (${job.id}) in ${job.lastRunDurationMs}ms`);

      if (job.notifyGateway) {
        this.notifyGateway(job, output);
      }

      return { success: true, output };
    } catch (err: any) {
      error = err.message || String(err);
      job.lastStatus = "error";
      job.lastError = error;
      job.runCount++;
      job.lastRunDurationMs = Date.now() - startTime;
      this.log(`Job failed: ${job.name} (${job.id}) error: ${error}`);
      if (job.notifyGateway) {
        this.notifyGateway(job, `[FAILURE ALERT] Job execution failed with error:\n${error}`);
      }
      return { success: false, error };
    } finally {
      this.runningJobIds.delete(job.id);
      this.saveJobs();
    }
  }

  private async defaultHeadlessRunner(job: DaemonJob): Promise<string> {
    const { Agent } = await import("../agent.js");
    let accumulatedText = "";

    return new Promise((resolve, reject) => {
      const agent = new Agent(
        (event) => {
          if (event.type === "text" && event.content) {
            accumulatedText += event.content;
          }
        },
        async () => true, // Auto-approve permissions in headless daemon mode
        async () => "continue",
        undefined,
        undefined,
        job.workspace
      );

      agent.isMultiAgent = job.mode === "multi";
      agent.tier = job.mode === "multi" ? "master" : "single";

      agent.sendMessage(job.prompt)
        .then(() => resolve(accumulatedText || "[Headless execution completed with no textual output]"))
        .catch(reject);
    });
  }

  private async notifyGateway(job: DaemonJob, output: string): Promise<void> {
    try {
      const { gatewayManager } = await import("../gateway/gatewayManager.js");
      const summary = `[DAEMON SCHEDULE NOTIFICATION]\nJob: ${job.name} (${job.id})\nStatus: ${job.lastStatus}\n\nResult:\n${output.slice(0, 1000)}`;

      const config = gatewayManager.getConfig();

      // Notify Telegram
      if (config.channels.telegram.enabled && config.channels.telegram.botToken) {
        const adapter = gatewayManager.getAdapter("telegram");
        const user = config.channels.telegram.allowedUserIds?.[0];
        if (user) await adapter.sendReply(user, summary).catch(() => {});
      }

      // Notify Discord via webhook or first allowed user channel
      if (config.channels.discord.enabled) {
        const adapter = gatewayManager.getAdapter("discord");
        if (config.channels.discord.webhookUrl) {
          await adapter.sendReply("", summary).catch(() => {});
        } else if (config.channels.discord.botToken && config.channels.discord.allowedUserIds?.[0]) {
          await adapter.sendReply(config.channels.discord.allowedUserIds[0], summary).catch(() => {});
        }
      }

      // Notify Slack via first allowed channel
      if (config.channels.slack.enabled && config.channels.slack.botToken && config.channels.slack.allowedUserIds?.[0]) {
        const adapter = gatewayManager.getAdapter("slack");
        await adapter.sendReply(config.channels.slack.allowedUserIds[0], summary).catch(() => {});
      }
    } catch {
      // Ignore notification failures
    }
  }

  private loadJobs(): void {
    try {
      if (fs.existsSync(this.jobsPath)) {
        const raw = fs.readFileSync(this.jobsPath, "utf-8");
        const list: DaemonJob[] = JSON.parse(raw);
        if (Array.isArray(list)) {
          for (const item of list) {
            this.jobs.set(item.id, item);
          }
        }
      }
    } catch {}
  }

  private saveJobs(): void {
    try {
      const dir = path.dirname(this.jobsPath);
      fs.mkdirSync(dir, { recursive: true });
      const list = Array.from(this.jobs.values());
      fs.writeFileSync(this.jobsPath, JSON.stringify(list, null, 2), "utf-8");
    } catch {}
  }
}

export function formatCountdown(targetMs?: number): string {
  if (!targetMs) return "N/A";
  const diff = targetMs - Date.now();
  if (diff <= 0) return "due now";
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `in ${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `in ${min}m ${sec % 60}s`;
  const hrs = Math.floor(min / 60);
  const remMin = min % 60;
  if (hrs < 24) return `in ${hrs}h ${remMin}m`;
  const days = Math.floor(hrs / 24);
  return `in ${days}d ${hrs % 24}h`;
}

export function renderDaemonDashboard(
  status: DaemonStatus,
  jobs: DaemonJob[],
  isJobRunning?: (id: string) => boolean
): string {
  const lines: string[] = [
    "Superagent Autonomous Daemon - Live Top / Dashboard",
    "--------------------------------------------------------------------------------",
    `Daemon State : ${status.running ? "RUNNING" : "STOPPED"} | PID: ${status.pid} | Uptime: ${status.uptime}s`,
    `Active Exec  : ${status.activeJobsCount} executing | Total Scheduled: ${jobs.length} jobs`,
    "--------------------------------------------------------------------------------",
  ];

  if (jobs.length === 0) {
    lines.push("No scheduled jobs found. Use 'superagent daemon add' or '/daemon add' to schedule tasks.");
    return lines.join("\n");
  }

  lines.push(
    "ID".padEnd(16) +
    "NAME".padEnd(18) +
    "STATUS".padEnd(12) +
    "SCHEDULE".padEnd(16) +
    "RUNS".padEnd(8) +
    "NEXT RUN / COUNTDOWN"
  );
  lines.push("-".repeat(80));

  for (const job of jobs) {
    const isExecuting = isJobRunning ? isJobRunning(job.id) : false;
    const st = isExecuting ? "EXECUTING" : job.enabled ? "ACTIVE" : "PAUSED";
    const nextStr = !job.enabled ? "paused" : formatCountdown(job.nextRun);
    const runsStr = `${job.runCount}${job.maxRuns ? `/${job.maxRuns}` : ""}`;

    lines.push(
      job.id.slice(0, 15).padEnd(16) +
      job.name.slice(0, 16).padEnd(18) +
      st.padEnd(12) +
      job.cronExpression.slice(0, 14).padEnd(16) +
      runsStr.padEnd(8) +
      nextStr
    );
  }

  lines.push("--------------------------------------------------------------------------------");
  return lines.join("\n");
}

export const daemonScheduler = new DaemonScheduler();

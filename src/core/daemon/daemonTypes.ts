export interface DaemonJob {
  id: string;
  name: string;
  cronExpression: string;
  prompt: string;
  workspace: string;
  mode: "single" | "multi";
  enabled: boolean;
  createdAt: number;
  lastRun?: number;
  nextRun?: number;
  lastStatus?: "success" | "error" | "running";
  lastError?: string;
  lastRunDurationMs?: number;
  runCount: number;
  maxRuns?: number;
  notifyGateway?: boolean;
  tags?: string[];
}

export interface DaemonConfig {
  tickIntervalMs: number;
  maxConcurrentJobs: number;
  logPath?: string;
}

export interface DaemonStatus {
  running: boolean;
  pid: number;
  uptime: number;
  activeJobsCount: number;
  totalJobsCount: number;
  lastTickAt?: number;
}

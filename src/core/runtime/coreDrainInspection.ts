/**
 * Process-local conservative drain gate for opt-in supervised API workers.
 * No network listener is created here; the worker reports this only through
 * an authenticated loopback-only internal endpoint.
 */
export interface CoreDrainMetrics {
  sessions: number;
  sseClients: number;
  browserClients: number;
  pendingPrompts: number;
  backgroundTasks: number;
  agents: number;
  cliBridgeSessions: number;
  detachedCliBridgeSessions: number;
  scheduledJobs: number;
  remoteTasks: number;
  daemonRunning: number;
  museWatcher: number;
}
export interface CoreDrainReport {
  pid: number;
  workerGenerationId: string;
  transportIsolated: boolean;
  visionOwner: boolean;
  safe: boolean;
  blockers: string[];
  metrics: CoreDrainMetrics;
}
export function evaluateCoreDrain(
  pid: number,
  workerGenerationId: string,
  options: { transportIsolated: boolean; visionOwner: boolean; metrics: CoreDrainMetrics },
): CoreDrainReport {
  const blockers: string[] = [];
  if (!options.transportIsolated) blockers.push("transport isolation not verified");
  if (options.visionOwner) blockers.push("owns fixed-port vision helper");
  for (const [name, count] of Object.entries(options.metrics)) {
    if (!Number.isSafeInteger(count) || count < 0) blockers.push("invalid " + name + " count");
    else if (count > 0) blockers.push(name + ": " + count);
  }
  return {
    pid, workerGenerationId,
    transportIsolated: options.transportIsolated,
    visionOwner: options.visionOwner,
    safe: blockers.length === 0,
    blockers, metrics: options.metrics,
  };
}

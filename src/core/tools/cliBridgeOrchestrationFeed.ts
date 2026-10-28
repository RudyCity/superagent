import { sampleSystemResources, type SystemResourceSample } from "./cliBridgeResourceSampler.js";
import { calculateEffectiveSlots, DEFAULT_SCHEDULER_POLICY } from "./cliBridgeScheduler.js";
import { inspectCapacitySlot, capacityRoot } from "./cliBridgeCapacity.js";
import { listDelegateJobs, getQueuedJobCount, getSchedulerContext, type DelegateJob } from "./cliBridgeDelegateJobs.js";
import { saveDagGraph, loadDagGraph, listDags, type DagGraph } from "./cliBridgeDag.js";

export interface HostStripData {
  effectiveSlots: number;
  maxSlots: number;
  configuredSlots: number;
  pressure: "none" | "moderate" | "high" | "critical";
  cpuUsagePercent: number;
  freeMemPercent: number;
  totalMemBytes: number;
  activeJobCount: number;
  queuedJobCount: number;
}

export interface OrchestrationFeedResponse {
  timestamp: number;
  hostStrip: HostStripData;
  jobs: Array<{
    jobId: string;
    cliAlias: string;
    status: string;
    completionState?: string;
    pid: number | null;
    capacitySlot?: number;
    startedAt: number;
    updatedAt: number;
    elapsedMs: number;
    outputTail: string;
    expectedArtifacts?: string[];
  }>;
  slots: Array<{
    index: number;
    state: string;
    jobId?: string;
    ownerPid: number | null;
    childPid: number | null;
  }>;
  activeDags: DagGraph[];
}

const activeDagsStore = new Map<string, DagGraph>();

export function registerActiveDag(graph: DagGraph): void {
  activeDagsStore.set(graph.graphId, graph);
  void saveDagGraph(graph).catch(() => {});
}

export function getActiveDag(graphId: string): DagGraph | undefined {
  return activeDagsStore.get(graphId);
}

export function cancelActiveDag(graphId: string): void {
  const dag = activeDagsStore.get(graphId);
  if (dag) {
    dag.status = "cancelled";
    dag.completedAt = Date.now();
  }
}

export function listActiveDags(workspace?: string): DagGraph[] {
  const all = [...activeDagsStore.values()];
  if (!workspace) return all;
  const normWs = workspace.toLowerCase();
  return all.filter((d) => d.workspaceRoot && d.workspaceRoot.toLowerCase() === normWs);
}

/**
 * Produces a unified live orchestration status feed for T-Line.
 * Enforces workspace boundaries so foreign slot job IDs and PIDs never leak.
 */
export async function getOrchestrationLiveStatus(workspace?: string): Promise<OrchestrationFeedResponse> {
  const allJobs = await listDelegateJobs();
  const jobs = workspace
    ? allJobs.filter((j) => j.workspaceRoot && j.workspaceRoot.toLowerCase() === workspace.toLowerCase())
    : allJobs;
  const activeJobs = jobs.filter(
    (j) => j.status === "starting" || j.status === "running"
  );

  const sample = sampleSystemResources({
    light: 0,
    normal: activeJobs.length,
    heavy: 0,
    exclusive: 0,
  });

  const { effectiveSlots, pressure, policy } = getSchedulerContext();

  const now = Date.now();
  const slots: OrchestrationFeedResponse["slots"] = [];

  for (let i = 0; i < effectiveSlots; i++) {
    try {
      const diag = await inspectCapacitySlot(i);
      // Privacy & Security boundary: Only expose slot details if owned by caller workspace
      const slotJob = diag.jobId ? allJobs.find((j) => j.jobId === diag.jobId) : undefined;
      const isCallerWorkspace = !workspace || Boolean(slotJob?.workspaceRoot && slotJob.workspaceRoot.toLowerCase() === workspace.toLowerCase());

      slots.push({
        index: i,
        state: diag.state,
        jobId: isCallerWorkspace ? diag.jobId : undefined,
        ownerPid: isCallerWorkspace ? diag.ownerPid : null,
        childPid: isCallerWorkspace ? diag.childPid : null,
      });
    } catch {
      slots.push({
        index: i,
        state: "available",
        ownerPid: null,
        childPid: null,
      });
    }
  }

  const hostStrip: HostStripData = {
    effectiveSlots,
    maxSlots: policy.maxSlots,
    configuredSlots: policy.configuredSlots,
    pressure,
    cpuUsagePercent: sample.cpu.usagePercent,
    freeMemPercent: sample.memory.freePercent,
    totalMemBytes: sample.memory.totalBytes,
    activeJobCount: activeJobs.length,
    queuedJobCount: getQueuedJobCount(),
  };

  const formattedJobs = jobs.slice(0, 20).map((j) => ({
    jobId: j.jobId,
    cliAlias: j.cliAlias,
    status: j.status,
    completionState: j.completionState,
    pid: j.pid,
    capacitySlot: j.capacitySlot,
    startedAt: j.startedAt,
    updatedAt: j.updatedAt,
    elapsedMs: now - j.startedAt,
    outputTail: j.outputTail || "",
    expectedArtifacts: j.expectedArtifacts,
  }));

  return {
    timestamp: now,
    hostStrip,
    jobs: formattedJobs,
    slots,
    activeDags: listActiveDags(workspace),
  };
}

/**
 * Computes aggregate performance, throughput, and verification metrics.
 */
export async function getOrchestrationMetrics(workspace?: string): Promise<{
  totalJobs: number;
  successCount: number;
  verifiedCount: number;
  failedCount: number;
  verificationFailedCount: number;
  averageDurationMs: number;
  successRate: number;
  verifiedRate: number;
}> {
  const allJobs = await listDelegateJobs();
  const jobs = workspace
    ? allJobs.filter((j) => j.workspaceRoot && j.workspaceRoot.toLowerCase() === workspace.toLowerCase())
    : allJobs;
  const completed = jobs.filter(
    (j) => j.status !== "starting" && j.status !== "running"
  );

  const totalJobs = completed.length;
  if (totalJobs === 0) {
    return {
      totalJobs: 0,
      successCount: 0,
      verifiedCount: 0,
      failedCount: 0,
      verificationFailedCount: 0,
      averageDurationMs: 0,
      successRate: 0,
      verifiedRate: 0,
    };
  }

  let successCount = 0;
  let verifiedCount = 0;
  let failedCount = 0;
  let verificationFailedCount = 0;
  let totalDuration = 0;

  for (const j of completed) {
    const dur = Math.max(0, j.updatedAt - j.startedAt);
    totalDuration += dur;

    if (j.status === "succeeded") {
      successCount++;
      if (j.completionState === "artifacts_verified") {
        verifiedCount++;
      }
    } else if (j.status === "verification_failed") {
      verificationFailedCount++;
    } else if (j.status === "failed") {
      failedCount++;
    }
  }

  return {
    totalJobs,
    successCount,
    verifiedCount,
    failedCount,
    verificationFailedCount,
    averageDurationMs: Math.round(totalDuration / totalJobs),
    successRate: Math.round((successCount / totalJobs) * 100) / 100,
    verifiedRate: Math.round((verifiedCount / totalJobs) * 100) / 100,
  };
}

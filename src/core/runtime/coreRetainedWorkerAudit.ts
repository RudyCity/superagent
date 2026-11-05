/**
 * Read-only reconciliation of Core retained generations.
 * No PID operations, filesystem reads, network inspection or lifecycle mutation.
 * The supervisor remains the only authority allowed to perform a guarded drain.
 */
import { MAX_RETAINED_CORE_WORKERS } from "./coreGenerationPolicy.js";
import type { CoreRuntimeStatus } from "./coreSupervisor.js";
import type { CoreDrainReport } from "./coreDrainInspection.js";

export interface RetainedWorkerEvidence {
  pid: number;
  port: number;
  since: number;
  generationId?: string;
  drainEligible?: boolean;
  adopted?: boolean;
  supervisorChildVerified?: boolean;
  pinnedSessions?: number;
  inflightRequests?: number;
  /** From a trusted supervisor-collected, authenticated internal inspection. */
  drainReport?: CoreDrainReport;
  /** Second distinct inspection, never inferred by reusing the first response. */
  secondDrainReport?: CoreDrainReport;
}
export interface RetainedWorkerAuditInput {
  status: CoreRuntimeStatus;
  checkpoint?: {
    activePid: number;
    workers: Array<{ pid: number; port: number; since: number; generationId: string; drainEligible: boolean }>;
    sessions: Array<{ owner: { pid: number; port: number; since: number } }>;
  };
  evidence?: readonly RetainedWorkerEvidence[];
  ledger?: readonly { action: string; state: string; beforePid: number; afterPid?: number }[];
}
export interface RetainedWorkerFinding {
  pid: number;
  port: number;
  generationId?: string;
  classification: "blocked" | "inspection-required" | "candidate-for-supervisor-drain";
  blockers: string[];
}
export interface RetainedWorkerAuditResult {
  restartBlocked: boolean;
  retainedCount: number;
  limit: number;
  classification: "no-go" | "review-required";
  findings: RetainedWorkerFinding[];
  globalBlockers: string[];
  recommendations: string[];
  /** Never an authorization to signal, unlink or retire a worker. */
  mutationAuthorized: false;
}
const pidValid = (v: number) => Number.isSafeInteger(v) && v > 0;
const portValid = (v: number) => Number.isSafeInteger(v) && v > 0 && v <= 65535;
const timeValid = (v: number) => Number.isSafeInteger(v) && v > 0;
const fingerprint = (v: {pid:number;port:number;since:number}) => v.pid + ":" + v.port + ":" + v.since;
const countValid = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const reportValid = (report: CoreDrainReport | undefined, worker: RetainedWorkerEvidence): boolean => {
  if (!report || !pidValid(report.pid) || report.pid !== worker.pid ||
      !worker.generationId || report.workerGenerationId !== worker.generationId ||
      report.transportIsolated !== true || report.visionOwner !== false ||
      report.safe !== true || !Array.isArray(report.blockers) || report.blockers.length !== 0 ||
      !report.metrics || typeof report.metrics !== "object") return false;
  const keys = ["sessions","sseClients","browserClients","pendingPrompts","backgroundTasks","agents",
    "cliBridgeSessions","detachedCliBridgeSessions","scheduledJobs","remoteTasks","daemonRunning","museWatcher"] as const;
  return keys.every(key => countValid(report.metrics[key]) && report.metrics[key] === 0);
};
export function auditCoreRetainedWorkers(input: RetainedWorkerAuditInput): RetainedWorkerAuditResult {
  const { status, checkpoint, evidence = [], ledger = [] } = input;
  const globalBlockers: string[] = [];
  const active = status.active;
  const retained = Array.isArray(status.retained) ? status.retained : [];
  const limit = status.maxRetainedWorkers;
  if (limit !== MAX_RETAINED_CORE_WORKERS) globalBlockers.push("Supervisor retention limit does not match local policy");
  if (!pidValid(status.supervisorPid) || !portValid(status.publicPort) ||
      !pidValid(active?.pid) || !portValid(active?.port) || !timeValid(active?.since))
    globalBlockers.push("Invalid supervisor or active generation identity");
  if (retained.length > MAX_RETAINED_CORE_WORKERS) globalBlockers.push("Retention limit already exceeded");
  const identifiers = new Set<number>();
  const ports = new Set<number>();
  if (active) { identifiers.add(active.pid); ports.add(active.port); }
  for (const worker of retained) {
    if (!pidValid(worker.pid) || !portValid(worker.port) || !timeValid(worker.since))
      globalBlockers.push("Malformed retained generation identity");
    if (identifiers.has(worker.pid) || ports.has(worker.port))
      globalBlockers.push("Duplicate PID or port across generations");
    identifiers.add(worker.pid); ports.add(worker.port);
  }
  if (checkpoint) {
    if (checkpoint.activePid !== active?.pid) globalBlockers.push("Checkpoint active generation mismatch");
    if (!Array.isArray(checkpoint.workers) || checkpoint.workers.length !== retained.length + 1 ||
        !checkpoint.workers.some(w => fingerprint(w) === fingerprint(active))) {
      globalBlockers.push("Checkpoint worker inventory mismatch");
    }
    for (const worker of retained) {
      if (!checkpoint.workers?.some(w => fingerprint(w) === fingerprint(worker)))
        globalBlockers.push("Retained worker absent from checkpoint: " + worker.pid);
    }
    if (!Array.isArray(checkpoint.sessions)) globalBlockers.push("Checkpoint sessions unavailable");
  } else globalBlockers.push("Owner checkpoint not provided; status cannot attest worker generation identity");
  if (ledger.some(r => r.state === "pending" || !["completed","failed"].includes(r.state)))
    globalBlockers.push("Pending or invalid lifecycle ledger operation requires operator reconciliation");
  const evidencePids = new Set<number>();
  for (const item of evidence) {
    if (evidencePids.has(item.pid)) globalBlockers.push("Duplicate evidence for PID " + item.pid);
    evidencePids.add(item.pid);
    if (!retained.some(w => fingerprint(w) === fingerprint(item)))
      globalBlockers.push("Evidence references untracked or mismatched generation PID " + item.pid);
  }
  const findings = retained.map(worker => {
    const blockers: string[] = [];
    const ev = evidence.find(item => fingerprint(item) === fingerprint(worker));
    const cp = checkpoint?.workers?.find(item => fingerprint(item) === fingerprint(worker));
    if (!cp || !/^[a-f0-9]{32}$/.test(cp.generationId)) blockers.push("Generation nonce not checkpoint-verified");
    if (!ev) blockers.push("No supervisor-owned worker evidence");
    else {
      if (ev.generationId !== cp?.generationId) blockers.push("Generation nonce mismatch");
      if (cp?.drainEligible !== true || ev.drainEligible !== true)
        blockers.push("Helper owner or drain-ineligible generation");
      if (ev.adopted !== false || ev.supervisorChildVerified !== true)
        blockers.push("Adopted or unverified child ownership");
      if (!countValid(ev.pinnedSessions) || ev.pinnedSessions !== 0)
        blockers.push("Pinned session count not proven zero");
      if (!countValid(ev.inflightRequests) || ev.inflightRequests !== 0)
        blockers.push("In-flight request count not proven zero");
      if (!reportValid(ev.drainReport, ev) || !reportValid(ev.secondDrainReport, ev) ||
          ev.drainReport === ev.secondDrainReport)
        blockers.push("Two distinct authenticated safe drain reports missing");
    }
    if (checkpoint?.sessions?.some(session => fingerprint(session.owner) === fingerprint(worker)))
      blockers.push("Checkpoint still pins a session");
    return {
      pid: worker.pid, port: worker.port, ...(cp ? {generationId:cp.generationId} : {}),
      classification: blockers.length === 0 && globalBlockers.length === 0
        ? "candidate-for-supervisor-drain" as const
        : blockers.length ? "blocked" as const : "inspection-required" as const,
      blockers,
    };
  });
  // Overall go/no-go concerns safe observation, not permission to mutate processes.
  const restartBlocked = retained.length >= MAX_RETAINED_CORE_WORKERS || globalBlockers.length > 0;
  return {
    restartBlocked, retainedCount: retained.length, limit: MAX_RETAINED_CORE_WORKERS,
    classification: globalBlockers.length || findings.some(f => f.classification !== "candidate-for-supervisor-drain")
      ? "no-go" : "review-required",
    findings, globalBlockers,
    recommendations: [
      "Never taskkill/PID-signal from this audit; obtain supervisor-authenticated checkpoint, ownership and fresh internal drain observations.",
      "The supervisor must recheck pinned sessions, HTTP/SSE/WebSocket, helper/process ownership and two spaced drain observations before any guarded retirement.",
      "Recheck Core status and ledger after any operator-driven drain; only then consider a separate restart plan.",
    ],
    mutationAuthorized: false,
  };
}

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { getRootConfigDir } from "../config/paths.js";
import type { AcceptanceContract, JobVerificationState } from "./cliBridgeAcceptance.js";
import { normalizePublicAcceptanceContract } from "./cliBridgeAcceptanceContract.js";
import { getRoleProfile } from "./cliBridgeRoleProfiles.js";
import {
  startDelegateJob,
  getDelegateJob,
  cancelDelegateJob,
  type DelegateJob,
} from "./cliBridgeDelegateJobs.js";

export type DagNodeStatus =
  | "pending"
  | "ready"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped"
  | "cancelled";

export type ReviewerVerdict =
  | "approve"
  | "request_changes"
  | "reject"
  | "insufficient_evidence";

export interface DagNodeResult {
  outputTail?: string;
  verificationState?: JobVerificationState;
  verdict?: ReviewerVerdict;
  verdictReason?: string;
  error?: string;
  winner?: boolean;
}

export interface DagNode {
  id: string;
  roleId?: string;
  prompt: string;
  cliAlias?: string;
  dependencies: string[];
  acceptance?: AcceptanceContract;
  worktree?: boolean;
  status: DagNodeStatus;
  jobId?: string;
  result?: DagNodeResult;
  startedAt?: number;
  completedAt?: number;
}

export interface DagGraph {
  graphId: string;
  name: string;
  workspaceRoot: string;
  maxFanOut: number;
  failFast: boolean;
  status: "pending" | "running" | "succeeded" | "failed" | "cancelled";
  nodes: Record<string, DagNode>;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
}

export interface CreateDagOptions {
  name: string;
  workspaceRoot: string;
  nodes: Array<{
    id: string;
    roleId?: string;
    prompt: string;
    cliAlias?: string;
    dependencies?: string[];
    acceptance?: AcceptanceContract;
    worktree?: boolean;
  }>;
  maxFanOut?: number;
  failFast?: boolean;
}

/**
 * Creates and validates a new DAG workflow.
 * Checks for circular dependencies, unknown dependencies, and enforces bounded fan-out.
 */
export function createDagGraph(options: CreateDagOptions): DagGraph {
  const maxFanOut = Math.min(8, Math.max(1, options.maxFanOut || 4));
  const nodes: Record<string, DagNode> = {};

  for (const item of options.nodes) {
    if (!item.id || !/^[a-zA-Z0-9_-]+$/.test(item.id)) {
      throw new Error(`Invalid DAG node ID: '${item.id}'`);
    }
    if (nodes[item.id]) {
      throw new Error(`Duplicate DAG node ID: '${item.id}'`);
    }

    nodes[item.id] = {
      id: item.id,
      roleId: item.roleId,
      prompt: item.prompt,
      cliAlias: item.cliAlias || (item.roleId ? getRoleProfile(item.roleId)?.cliAlias : undefined),
      dependencies: (item.dependencies || []).slice(),
      acceptance: item.acceptance === undefined ? undefined : normalizePublicAcceptanceContract(item.acceptance),
      worktree: item.worktree ?? (item.roleId ? getRoleProfile(item.roleId)?.worktreePolicy === "isolated" : false),
      status: "pending",
    };
  }

  // Validate dependencies exist
  for (const node of Object.values(nodes)) {
    for (const depId of node.dependencies) {
      if (!nodes[depId]) {
        throw new Error(`DAG node '${node.id}' depends on non-existent node '${depId}'`);
      }
      if (depId === node.id) {
        throw new Error(`DAG node '${node.id}' cannot depend on itself`);
      }
    }
  }

  // Detect circular dependencies via depth-first search
  const visited = new Set<string>();
  const recStack = new Set<string>();

  function checkCycle(nodeId: string): void {
    visited.add(nodeId);
    recStack.add(nodeId);

    const node = nodes[nodeId];
    for (const dep of node.dependencies) {
      if (!visited.has(dep)) {
        checkCycle(dep);
      } else if (recStack.has(dep)) {
        throw new Error(`Circular dependency detected in DAG between '${nodeId}' and '${dep}'`);
      }
    }

    recStack.delete(nodeId);
  }

  for (const nodeId of Object.keys(nodes)) {
    if (!visited.has(nodeId)) {
      checkCycle(nodeId);
    }
  }

  const graphId = `dag_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;

  return {
    graphId,
    name: options.name,
    workspaceRoot: options.workspaceRoot,
    maxFanOut,
    failFast: options.failFast !== false,
    status: "pending",
    nodes,
    createdAt: Date.now(),
  };
}

/**
 * Returns all nodes that are eligible to run given current predecessor completion.
 * Enforces bounded fan-out across concurrently runnable nodes.
 */
export function getRunnableNodes(graph: DagGraph): DagNode[] {
  if (graph.status === "failed" || graph.status === "cancelled" || graph.status === "succeeded") {
    return [];
  }

  const currentlyRunning = Object.values(graph.nodes).filter((n) => n.status === "running").length;
  const availableSlots = Math.max(0, graph.maxFanOut - currentlyRunning);
  if (availableSlots === 0) return [];

  const runnable: DagNode[] = [];

  for (const node of Object.values(graph.nodes)) {
    if (node.status !== "pending") continue;

    // Check if all dependencies have succeeded
    const allDepsMet = node.dependencies.every(
      (depId) => graph.nodes[depId]?.status === "succeeded"
    );

    if (allDepsMet) {
      runnable.push(node);
      if (runnable.length >= availableSlots) {
        break; // enforce bounded fan-out
      }
    }
  }

  return runnable;
}

/**
 * Advances a node's state upon task completion and updates overall graph lifecycle.
 */
export function advanceDagNode(
  graph: DagGraph,
  nodeId: string,
  outcome: {
    status: "succeeded" | "failed";
    result?: DagNodeResult;
  }
): void {
  const node = graph.nodes[nodeId];
  if (!node) {
    throw new Error(`Node '${nodeId}' does not exist in DAG '${graph.graphId}'`);
  }

  node.status = outcome.status;
  node.result = outcome.result;
  node.completedAt = Date.now();

  if (graph.status === "pending") {
    graph.status = "running";
    graph.startedAt = graph.startedAt || Date.now();
  }

  // Failure propagation
  if (outcome.status === "failed" && graph.failFast) {
    graph.status = "failed";
    graph.completedAt = Date.now();

    // Cancel/skip all unstarted downstream nodes
    const toCancel = new Set<string>();
    function markDependents(id: string) {
      for (const other of Object.values(graph.nodes)) {
        if (other.dependencies.includes(id) && other.status === "pending") {
          toCancel.add(other.id);
          markDependents(other.id);
        }
      }
    }
    markDependents(nodeId);

    for (const cancelId of toCancel) {
      graph.nodes[cancelId].status = "cancelled";
    }
    return;
  }

  // Check if all nodes are terminal
  const allNodes = Object.values(graph.nodes);
  const allTerminal = allNodes.every(
    (n) => n.status === "succeeded" || n.status === "failed" || n.status === "cancelled" || n.status === "skipped"
  );

  if (allTerminal) {
    const hasFailed = allNodes.some((n) => n.status === "failed");
    graph.status = hasFailed ? "failed" : "succeeded";
    graph.completedAt = Date.now();
  }
}

/**
 * Evaluates speculative execution across multiple candidate implementations.
 * The first candidate with verified acceptance wins; losers are marked for teardown.
 */
export function evaluateSpeculativeCandidates(
  candidates: Array<{ candidateId: string; verificationState?: JobVerificationState }>
): { winnerId?: string; loserIds: string[] } {
  const verifiedWinner = candidates.find((c) => c.verificationState === "verified");
  if (!verifiedWinner) {
    return {
      winnerId: undefined,
      loserIds: candidates.map((c) => c.candidateId),
    };
  }

  const loserIds = candidates
    .filter((c) => c.candidateId !== verifiedWinner.candidateId)
    .map((c) => c.candidateId);

  return {
    winnerId: verifiedWinner.candidateId,
    loserIds,
  };
}

/**
 * Evaluates multi-agent consensus verdicts (e.g. from 3 independent reviewers).
 */
export function evaluateConsensusVerdicts(
  verdicts: Array<{ agentId: string; verdict: ReviewerVerdict }>
): { consensusVerdict: ReviewerVerdict; agreementRatio: number; votes: Record<string, number> } {
  if (verdicts.length === 0) {
    return {
      consensusVerdict: "insufficient_evidence",
      agreementRatio: 0,
      votes: {},
    };
  }

  const votes: Record<string, number> = {};
  for (const v of verdicts) {
    votes[v.verdict] = (votes[v.verdict] || 0) + 1;
  }

  let highestCount = 0;
  let consensusVerdict: ReviewerVerdict = "insufficient_evidence";

  for (const [v, count] of Object.entries(votes)) {
    if (count > highestCount) {
      highestCount = count;
      consensusVerdict = v as ReviewerVerdict;
    }
  }

  return {
    consensusVerdict,
    agreementRatio: Math.round((highestCount / verdicts.length) * 100) / 100,
    votes,
  };
}

function dagStorageDir(): string {
  return process.env.SUPERAGENT_CLI_BRIDGE_DAGS_DIR || path.join(getRootConfigDir(), "cli-bridge", "dags");
}

export async function saveDagGraph(dag: DagGraph): Promise<void> {
  const dir = dagStorageDir();
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, `${dag.graphId}.json`);
  const tmp = path.join(dir, `${dag.graphId}.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(dag, null, 2), "utf8");
  await fs.rename(tmp, target);
}

export async function loadDagGraph(graphId: string): Promise<DagGraph | null> {
  try {
    const raw = await fs.readFile(path.join(dagStorageDir(), `${graphId}.json`), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function listDags(workspaceRoot?: string): Promise<DagGraph[]> {
  try {
    const dir = dagStorageDir();
    await fs.mkdir(dir, { recursive: true });
    const files = await fs.readdir(dir);
    const dags: DagGraph[] = [];
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      try {
        const dag: DagGraph = JSON.parse(await fs.readFile(path.join(dir, f), "utf8"));
        if (!workspaceRoot || !dag.workspaceRoot || dag.workspaceRoot.toLowerCase() === workspaceRoot.toLowerCase()) {
          dags.push(dag);
        }
      } catch {}
    }
    return dags.sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}

/**
 * Startup recovery/resume loop for persisted running DAGs (M4.2 / S8).
 * Reconciles node statuses with underlying delegate job checkpoints and resumes execution.
 */
export async function reconcileRunningDagsOnStartup(): Promise<{ reconciledCount: number; resumedCount: number }> {
  const dags = await listDags();
  let reconciledCount = 0;
  let resumedCount = 0;

  for (const dag of dags) {
    if (dag.status !== "running") continue;

    reconciledCount++;
    for (const node of Object.values(dag.nodes)) {
      if (node.status === "running" && node.jobId) {
        const job = await getDelegateJob(node.jobId).catch(() => null);
        if (!job || (job.status !== "starting" && job.status !== "running" && job.status !== "cancelling")) {
          const isVerified = job?.completionState === "verified" || job?.completionState === "artifacts_verified";
          const succeeded = job?.status === "succeeded" && (!node.acceptance || isVerified);
          node.status = succeeded ? "succeeded" : "failed";
          node.result = {
            outputTail: job?.outputTail,
            verificationState: job?.verificationResult?.state ?? (isVerified ? "verified" : succeeded ? "succeeded_unverified" : "failed"),
            error: job?.error ?? "Job was interrupted by host restart",
          };
          node.completedAt = Date.now();
        }
      }
    }

    const allTerminal = Object.values(dag.nodes).every(
      (n) => n.status === "succeeded" || n.status === "failed" || n.status === "cancelled" || n.status === "skipped"
    );

    if (allTerminal) {
      const hasFailed = Object.values(dag.nodes).some((n) => n.status === "failed");
      dag.status = hasFailed ? "failed" : "succeeded";
      dag.completedAt = Date.now();
      await saveDagGraph(dag);
    } else {
      resumedCount++;
      void executeDagGraph(dag).catch(() => {});
    }
  }

  return { reconciledCount, resumedCount };
}

export async function executeDagGraph(
  graph: DagGraph,
  options?: {
    signal?: AbortSignal;
    pollIntervalMs?: number;
    onProgress?: (graph: DagGraph) => void;
  }
): Promise<DagGraph> {
  graph.status = "running";
  graph.startedAt ??= Date.now();
  await saveDagGraph(graph);

  const pollInterval = options?.pollIntervalMs ?? 100;

  while (graph.status === "running") {
    if (options?.signal?.aborted) {
      graph.status = "cancelled";
      graph.completedAt = Date.now();
      for (const node of Object.values(graph.nodes)) {
        if (node.status === "running" && node.jobId) {
          await cancelDelegateJob(node.jobId).catch(() => {});
          node.status = "cancelled";
        } else if (node.status === "pending") {
          node.status = "cancelled";
        }
      }
      await saveDagGraph(graph);
      break;
    }

    // 1. Find runnable nodes
    const runnable = getRunnableNodes(graph);
    for (const node of runnable) {
      node.status = "running";
      node.startedAt = Date.now();
      try {
        const job = await startDelegateJob({
          cliAlias: node.cliAlias || "agy",
          binary: "agy",
          prompt: node.prompt,
          cwd: graph.workspaceRoot,
          workspaceRoot: graph.workspaceRoot,
          roleProfile: node.roleId,
          worktree: node.worktree,
          acceptanceContract: node.acceptance === undefined ? undefined : normalizePublicAcceptanceContract(node.acceptance),
          timeoutMs: 180_000,
          args: ["--mode", node.roleId === "reviewer" || node.roleId === "architect" ? "plan" : "accept-edits", "-p", node.prompt],
        });
        node.jobId = job.jobId;
      } catch (err: any) {
        node.status = "failed";
        node.result = { error: err.message || String(err) };
        advanceDagNode(graph, node.id, {
          status: "failed",
          result: node.result,
        });
      }
      await saveDagGraph(graph);
      options?.onProgress?.(graph);
    }

    // 2. Poll running nodes
    const runningNodes = Object.values(graph.nodes).filter((n) => n.status === "running" && n.jobId);
    if (runningNodes.length > 0) {
      for (const node of runningNodes) {
        const job = await getDelegateJob(node.jobId!);
        if (!job) continue;
        if (job.status !== "starting" && job.status !== "running" && job.status !== "cancelling") {
          const isVerified = job.completionState === "verified" || job.completionState === "artifacts_verified";
          const succeeded = job.status === "succeeded" && (!node.acceptance || isVerified);
          const vState: JobVerificationState = job.verificationResult?.state ?? (
            isVerified ? "verified" : succeeded ? "succeeded_unverified" : "failed"
          );
          advanceDagNode(graph, node.id, {
            status: succeeded ? "succeeded" : "failed",
            result: {
              outputTail: job.outputTail,
              verificationState: vState,
              error: job.error,
            },
          });
          await saveDagGraph(graph);
          options?.onProgress?.(graph);

          if (!succeeded && graph.failFast) {
            for (const other of Object.values(graph.nodes)) {
              if (other.status === "running" && other.jobId && other.id !== node.id) {
                await cancelDelegateJob(other.jobId).catch(() => {});
                other.status = "cancelled";
              }
            }
            graph.status = "failed";
            graph.completedAt = Date.now();
            await saveDagGraph(graph);
            break;
          }
        }
      }
    }

    // 3. Check overall completion
    const allNodes = Object.values(graph.nodes);
    const allTerminal = allNodes.every(
      (n) => n.status === "succeeded" || n.status === "failed" || n.status === "cancelled" || n.status === "skipped"
    );
    if (allTerminal) {
      const hasFailed = allNodes.some((n) => n.status === "failed");
      graph.status = hasFailed ? "failed" : "succeeded";
      graph.completedAt = Date.now();
      await saveDagGraph(graph);
      break;
    }

    await new Promise((r) => setTimeout(r, pollInterval));
  }

  return graph;
}

export interface SpeculativeCandidateSpec {
  candidateId: string;
  prompt: string;
  cliAlias?: string;
  roleId?: string;
  worktree?: boolean;
  acceptance: AcceptanceContract;
}

export interface SpeculativeExecutionResult {
  winnerId?: string;
  loserIds: string[];
  winnerJob?: DelegateJob;
  candidateJobs: Record<string, DelegateJob>;
}

export async function runSpeculativeWorkflow(
  specs: SpeculativeCandidateSpec[],
  workspaceRoot: string,
  options?: { timeoutMs?: number; pollIntervalMs?: number }
): Promise<SpeculativeExecutionResult> {
  const candidateJobs: Record<string, DelegateJob> = {};
  const pollInterval = options?.pollIntervalMs ?? 100;
  const timeoutMs = options?.timeoutMs ?? 180_000;
  const deadline = Date.now() + timeoutMs;

  for (const spec of specs) {
    const acceptanceContract = normalizePublicAcceptanceContract(spec.acceptance);
    if (!acceptanceContract) {
      throw new Error("Speculative candidate '" + spec.candidateId + "' requires a non-empty acceptance contract.");
    }
    const job = await startDelegateJob({
      cliAlias: spec.cliAlias || "agy",
      binary: "agy",
      prompt: spec.prompt,
      cwd: workspaceRoot,
      workspaceRoot,
      roleProfile: spec.roleId,
      worktree: spec.worktree ?? true,
      acceptanceContract,
      timeoutMs,
      args: ["--mode", "accept-edits", "-p", spec.prompt],
    });
    candidateJobs[spec.candidateId] = job;
  }

  let winnerId: string | undefined;
  const loserIds: string[] = [];

  while (Date.now() < deadline) {
    for (const spec of specs) {
      const current = await getDelegateJob(candidateJobs[spec.candidateId].jobId);
      if (current) {
        candidateJobs[spec.candidateId] = current;
        if (current.status === "succeeded" && current.completionState === "verified") {
          winnerId = spec.candidateId;
          break;
        }
      }
    }

    if (winnerId) break;

    const allDone = specs.every((s) => {
      const j = candidateJobs[s.candidateId];
      return j.status !== "starting" && j.status !== "running" && j.status !== "cancelling";
    });
    if (allDone) break;

    await new Promise((r) => setTimeout(r, pollInterval));
  }

  for (const spec of specs) {
    if (spec.candidateId !== winnerId) {
      loserIds.push(spec.candidateId);
      const j = candidateJobs[spec.candidateId];
      if (j) {
        const cur = await getDelegateJob(j.jobId);
        if (cur && (cur.status === "starting" || cur.status === "running" || cur.status === "cancelling" || cur.status === "queued")) {
          await cancelDelegateJob(cur.jobId).catch(() => {});
        }
      }
    }
  }

  return {
    winnerId,
    loserIds,
    winnerJob: winnerId ? candidateJobs[winnerId] : undefined,
    candidateJobs,
  };
}

export interface ReviewerSpec {
  agentId: string;
  roleId?: string;
  cliAlias?: string;
  prompt?: string;
}

export interface ConsensusReviewResult {
  consensusVerdict: ReviewerVerdict;
  agreementRatio: number;
  votes: Record<string, number>;
  verdicts: Array<{ agentId: string; verdict: ReviewerVerdict; reason?: string }>;
}

export async function runConsensusWorkflow(
  diffOrSpec: string,
  reviewers: ReviewerSpec[],
  workspaceRoot: string,
  options?: { timeoutMs?: number; pollIntervalMs?: number }
): Promise<ConsensusReviewResult> {
  const timeoutMs = options?.timeoutMs ?? 120_000;
  const pollInterval = options?.pollIntervalMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  const reviewerJobs: Record<string, DelegateJob> = {};

  for (const r of reviewers) {
    const promptText = [
      "Review the following diff/specification and output a JSON object with: { \"verdict\": \"approve\" | \"request_changes\" | \"reject\", \"reason\": \"...\" }",
      "Do not use tools. Immediately output the JSON object.",
      r.prompt ? `Special Instructions: ${r.prompt}` : "",
      "--- DIFF / SPECIFICATION ---",
      diffOrSpec,
    ].filter(Boolean).join("\n\n");

    const job = await startDelegateJob({
      cliAlias: r.cliAlias || "agy",
      binary: "agy",
      prompt: promptText,
      cwd: workspaceRoot,
      workspaceRoot,
      roleProfile: r.roleId || "reviewer",
      worktree: false,
      timeoutMs: Math.max(1000, timeoutMs),
      args: ["--mode", "plan", "-p", promptText],
    });
    reviewerJobs[r.agentId] = job;
  }

  while (Date.now() < deadline) {
    let allFinished = true;
    for (const r of reviewers) {
      const current = await getDelegateJob(reviewerJobs[r.agentId].jobId);
      if (current) {
        reviewerJobs[r.agentId] = current;
        if (current.status === "starting" || current.status === "running" || current.status === "cancelling") {
          allFinished = false;
        }
      }
    }
    if (allFinished) break;
    await new Promise((r) => setTimeout(r, pollInterval));
  }

  // Cancel any lingering reviewer jobs on timeout
  for (const r of reviewers) {
    const j = reviewerJobs[r.agentId];
    if (j) {
      const cur = await getDelegateJob(j.jobId);
      if (cur && (cur.status === "starting" || cur.status === "running" || cur.status === "cancelling" || cur.status === "queued")) {
        await cancelDelegateJob(cur.jobId).catch(() => {});
      }
    }
  }

  const verdicts: Array<{ agentId: string; verdict: ReviewerVerdict; reason?: string }> = [];
  for (const r of reviewers) {
    const j = reviewerJobs[r.agentId];
    let verdict: ReviewerVerdict = "insufficient_evidence";
    let reason = j?.error || "No review returned";

    if (j && j.status === "succeeded") {
      try {
        const match = j.outputTail.match(/\{[\s\S]*?"verdict"[\s\S]*?\}/);
        if (match) {
          const parsed = JSON.parse(match[0]);
          if (["approve", "request_changes", "reject", "insufficient_evidence"].includes(parsed.verdict)) {
            verdict = parsed.verdict;
            reason = parsed.reason || "Structured verdict parsed";
          }
        } else if (j.outputTail.toLowerCase().includes("approve")) {
          verdict = "approve";
          reason = "Heuristic match: approve";
        } else if (j.outputTail.toLowerCase().includes("request_changes")) {
          verdict = "request_changes";
          reason = "Heuristic match: request_changes";
        } else if (j.outputTail.toLowerCase().includes("reject")) {
          verdict = "reject";
          reason = "Heuristic match: reject";
        }
      } catch {}
    }

    verdicts.push({ agentId: r.agentId, verdict, reason });
  }

  const consensus = evaluateConsensusVerdicts(verdicts);
  return {
    ...consensus,
    verdicts,
  };
}

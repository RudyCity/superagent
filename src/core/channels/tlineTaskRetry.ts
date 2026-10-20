/**
 * Explicit fresh-instruction retry for a failed creator-owned TLine CLI job.
 * A retry is NEVER an implicit replay of prompts/args. Durable one-shot
 * claim prevents accidental re-execution even across process crashes.
 */
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { getRootConfigDir } from "../config/paths.js";
import { snapshotExpectedArtifacts } from "../tools/cliBridgeArtifactEvidence.js";
import { getDelegateJob, type DelegateJob } from "../tools/cliBridgeDelegateJobs.js";
import { jobShardPath } from "../tools/cliBridgeJobStore.js";
import { delegateJobVisibleToWorkspace, resolveAuthorizedDelegateCwd } from "../tools/cliBridgeWorkspaceScope.js";
import { resolveExpectedArtifacts } from "../tools/cliBridgeArtifactEvidence.js";
import { runWithTrustedTlineCreator } from "./tlineJobCreator.js";

const JOB = /^clj_\d{8,17}_[a-f0-9]{8}$/;
const SESSION = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const EXPIRES = 45_000;
const PENDING_LIMIT = 32;
const RETRIABLE_STATUS = "verification_failed";
const CLI_ALLOW = new Set(["codex", "claude"]);
type Input = { workspace: string; sessionId: string; jobId: string };
type Pending = Input & { prompt: string; updatedAt: number; startedAt: number; expires: number };
type Result = { status: number; body: { success: boolean; error?: string; challenge?: string;
  sourceJobId?: string; newJobId?: string; requested?: boolean; note?: string } };
const pending = new Map<string, Pending>();
function fail(status: number, error: string): Result {
  return { status, body: { success: false, error } };
}
function freshPrompt(prompt: unknown): prompt is string {
  return typeof prompt === "string" && prompt.trim().length >= 20 &&
    prompt.length <= 4000 && !prompt.includes("\0");
}
function valid(input: Input): boolean {
  return typeof input.workspace === "string" && input.workspace.length > 0 &&
    SESSION.test(input.sessionId) && JOB.test(input.jobId);
}

export interface RetryDeps {
  enabled: () => boolean;
  getJob: (id: string) => Promise<DelegateJob | null>;
  launch: (job: DelegateJob, workspace: string, sessionId: string, prompt: string) => Promise<string>;
  claim: (job: DelegateJob, prompt: string) => Promise<boolean>;
  now: () => number;
}
export async function claimTlineRetryOnce(job: DelegateJob, prompt: string): Promise<boolean> {
  const base = path.join(getRootConfigDir(), "cli-bridge", "delegations");
  const dir = jobShardPath(base, job.jobId);
  try {
    const stat = await fs.lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    // Atomic exclusive creation. NEVER delete this lease on uncertainty or restart.
    const fd = await fs.open(path.join(dir, "tline-retry-once.claim"), "wx", 0o600);
    try {
      await fd.writeFile(JSON.stringify({
        version: 1, sourceJobId: job.jobId, sourceRevision: job.updatedAt,
        promptSha256: crypto.createHash("sha256").update(prompt).digest("hex"),
        claimedAt: Date.now(),
      }));
    } finally { await fd.close(); }
    return true;
  } catch { return false; }
}
async function defaultLaunch(job: DelegateJob, workspace: string, sessionId: string, prompt: string): Promise<string> {
  const { cliBridgeTool } = await import("../tools/cliBridgeTool.js");
  const result = await runWithTrustedTlineCreator({ clientMode: "tline", workspace, sessionId }, () =>
    cliBridgeTool.execute({
      action: "delegate.start", cli: job.cliAlias, cwd: job.cwd,
      prompt, timeoutMs: job.timeoutMs,
      // Existing validated output claims are re-acquired at the new job's start.
      expectedArtifacts: job.expectedArtifacts,
      injectArtifacts: false, skillAutoDetect: false,
    }, workspace));
  const match = /^Started background CLI delegation: (clj_\d{8,17}_[a-f0-9]{8})/m.exec(result);
  if (!match) throw new Error("New task start was not confirmed. Inspect CLI Bridge jobs before another attempt.");
  return match[1];
}
const defaults: RetryDeps = {
  enabled: () => process.env.SUPERAGENT_TLINE_TASK_RETRY === "1",
  getJob: getDelegateJob,
  launch: defaultLaunch,
  claim: claimTlineRetryOnce,
  now: Date.now,
};
async function eligible(input: Input, deps: RetryDeps): Promise<DelegateJob | null> {
  if (!valid(input)) return null;
  const job = await deps.getJob(input.jobId);
  if (!job || !delegateJobVisibleToWorkspace(job, input.workspace) ||
    job.creator?.clientMode !== "tline" || job.creator.sessionId !== input.sessionId ||
    !delegateJobVisibleToWorkspace({
      cwd: job.creator.workspace, workspaceRoot: job.creator.workspace,
    }, input.workspace) || job.status !== RETRIABLE_STATUS ||
    job.completionState !== "artifact_verification_failed" ||
    !CLI_ALLOW.has(job.cliAlias) ||
    !Array.isArray(job.expectedArtifacts) || job.expectedArtifacts.length < 1 ||
    !Array.isArray(job.artifactEvidence) ||
    job.artifactEvidence.length !== job.expectedArtifacts.length ||
    !Number.isFinite(job.updatedAt) || !Number.isFinite(job.startedAt)) return null;
  try {
    resolveAuthorizedDelegateCwd(input.workspace, job.cwd);
    const paths = resolveExpectedArtifacts(job.cwd, input.workspace, job.expectedArtifacts);
    const current = await snapshotExpectedArtifacts(paths, input.workspace);
    for (let i = 0; i < current.length; i++) {
      const prior = job.artifactEvidence[i];
      const oldPath = path.relative(job.cwd, paths[i]).replace(/\\/g, "/");
      if (prior.path !== oldPath ||
        (prior.state === "missing" ? current[i].sha256 !== null :
          prior.state === "unchanged"
            ? !prior.sha256 || current[i].sha256 !== prior.sha256
            : true)) return null;
    }
  } catch { return null; }
  return job;
}
export async function prepareTlineRetry(
  input: Input & { prompt: unknown }, deps: RetryDeps = defaults,
): Promise<Result> {
  if (!deps.enabled()) return fail(403, "TLine new-instruction retry is disabled by the operator.");
  if (!freshPrompt(input.prompt) || !valid(input)) return fail(400, "A new instruction (20-4000 chars) and exact task scope are required.");
  const job = await eligible(input, deps);
  if (!job) return fail(403, "Original task is not eligible for retry in this session.");
  const now = deps.now();
  for (const [id, p] of pending) if (p.expires <= now) pending.delete(id);
  if (pending.size >= PENDING_LIMIT) return fail(429, "Too many unconfirmed retry attempts.");
  const challenge = crypto.randomBytes(24).toString("hex");
  pending.set(challenge, {
    workspace: input.workspace, sessionId: input.sessionId, jobId: input.jobId,
    prompt: input.prompt, updatedAt: job.updatedAt, startedAt: job.startedAt, expires: now + EXPIRES,
  });
  return { status: 200, body: { success: true, sourceJobId: input.jobId, challenge,
    note: "Review the NEW instruction; confirming may execute it once and produce side effects." } };
}
export async function confirmTlineRetry(
  input: Input & { challenge: string }, deps: RetryDeps = defaults,
): Promise<Result> {
  if (!deps.enabled()) return fail(403, "TLine retry disabled by operator.");
  if (!valid(input) || !/^[a-f0-9]{48}$/.test(input.challenge)) return fail(400, "Invalid retry confirmation.");
  const p = pending.get(input.challenge);
  pending.delete(input.challenge); // single-use BEFORE any asynchronous work
  if (!p || p.expires <= deps.now() || p.workspace !== input.workspace ||
    p.sessionId !== input.sessionId || p.jobId !== input.jobId) {
    return fail(403, "Retry confirmation expired, reused, or belongs to another session.");
  }
  const job = await eligible(input, deps);
  if (!job || job.updatedAt !== p.updatedAt || job.startedAt !== p.startedAt) {
    return fail(409, "Source task changed; retry aborted.");
  }
  if (!await deps.claim(job, p.prompt)) return fail(409, "Retry already claimed or source metadata unavailable.");
  try {
    const newJobId = await deps.launch(job, input.workspace, input.sessionId, p.prompt);
    if (!JOB.test(newJobId)) throw new Error("Invalid new job identifier");
    return { status: 202, body: { success: true, requested: true,
      sourceJobId: job.jobId, newJobId,
      note: "New task requested; monitor its status independently." } };
  } catch {
    // Durable claim deliberately survives failure: ambiguous launch => no duplicate.
    return fail(409, "Retry outcome uncertain. Inspect task list before starting any other job.");
  }
}
export function __clearTlineRetryPendingForTests() { pending.clear(); }

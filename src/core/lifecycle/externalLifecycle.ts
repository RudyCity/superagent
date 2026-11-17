/**
 * ChatGPT-to-ChatGPT lifecycle: a durable, opt-in external worker queue.
 * This module never instantiates an internal Agent or calls an MCP client.
 * Workers explicitly poll/claim via their own authorised MCP session.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getRootConfigDir } from "../config/paths.js";
import { getNextCronTime, isValidCron, matchesCron } from "../daemon/cronParser.js";

type StageState = "waiting" | "queued" | "leased" | "completed" | "failed" | "review_required" | "cancelled";
type RunState = "queued" | "running" | "completed" | "failed" | "review_required" | "cancelled";
type Context = { workspace: string; actor: string; principal: string; admin?: boolean };
type Step = { id: string; prompt: string; dependsOn: string[]; targetWorkerId?: string };
type Workflow = {
  id: string; owner: string; workspace: string; name: string; cronExpression: string;
  steps: Step[]; enabled: boolean; createdAt: number; nextRun: number | null;
  maxRuns?: number; runCount: number; lastDueMinute?: string;
  createKey?: string; createFingerprint?: string;
};
type Stage = {
  id: string; state: StageState; attempts: number; workerId?: string;
  leaseDigest?: string; leaseUntil?: number; result?: string; error?: string;
  nudge?: { requestId: string; state: "dispatching" | "confirmed" | "uncertain"; at: number; reason?: string };
};
type Run = {
  id: string; workflowId: string; workspace: string; createdAt: number; updatedAt: number;
  state: RunState; stages: Stage[]; manualRequestKey?: string;
};
type Worker = {
  id: string; workspace: string; principal: string; actor: string; label: string;
  capabilities: string[]; resumeDigest: string; lastSeen: number; enabled: boolean;
  cdp?: { clientId: string; tabId: number; boundAt: number };
};
type Store = { version: 1; workflows: Workflow[]; runs: Run[]; workers: Worker[] };
const EMPTY = (): Store => ({ version: 1, workflows: [], runs: [], workers: [] });
const LEASE_MS = 5 * 60_000;
const ONLINE_MS = 90_000;
const LIMIT = { workflows: 500, runs: 3000, workers: 200 };
const tokenDigest = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
const id = (prefix: string) => prefix + "_" + crypto.randomUUID();
const text = (v: unknown, name: string, max: number) => {
  if (typeof v !== "string" || !v.trim() || v.length > max) throw new Error(name + " must be a nonempty string (max " + max + ").");
  return v.trim();
};
const identifier = (v: unknown, name: string) => {
  const s = text(v, name, 100);
  if (!/^[a-zA-Z0-9_-]+$/.test(s)) throw new Error(name + " must be an opaque identifier.");
  return s;
};
const bounded = (n: unknown, max: number, fallback: number) => {
  if (n === undefined) return fallback;
  if (!Number.isSafeInteger(n) || Number(n) < 1 || Number(n) > max) throw new Error("Invalid limit.");
  return Number(n);
};
const absoluteWorkspace = (v: string) => {
  if (!path.isAbsolute(v) || /^ssh:|^chain:/i.test(v)) throw new Error("Lifecycle requires an authorised local workspace.");
  return fs.realpathSync(v);
};
function root() {
  const dir = path.join(getRootConfigDir(), "external-lifecycle");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
function load(file: string): Store {
  if (!fs.existsSync(file)) return EMPTY();
  if (fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size > 8_000_000) throw new Error("Lifecycle store is invalid; fail closed.");
  const data: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!data || typeof data !== "object") throw new Error("Lifecycle store is corrupt.");
  const item = data as Partial<Store>;
  if (item.version !== 1 || !Array.isArray(item.workflows) || !Array.isArray(item.runs) || !Array.isArray(item.workers)) {
    throw new Error("Lifecycle store has an unsupported schema.");
  }
  if (item.workflows.length > LIMIT.workflows || item.runs.length > LIMIT.runs || item.workers.length > LIMIT.workers) {
    throw new Error("Lifecycle store exceeds bounds.");
  }
  return item as Store;
}
function withStore<T>(write: boolean, fn: (s: Store) => T): T {
  const dir = root();
  const lock = path.join(dir, "state.lock");
  const file = path.join(dir, "state.json");
  const waitArray = new Int32Array(new SharedArrayBuffer(4));
  let acquired = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { fs.mkdirSync(lock, { mode: 0o700 }); acquired = true; break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      Atomics.wait(waitArray, 0, 0, 10);
    }
  }
  if (!acquired) throw new Error("Lifecycle store is locked; manual owner verification required.");
  try {
    const state = load(file);
    const result = fn(state);
    if (write) {
      const tmp = path.join(dir, "state." + crypto.randomUUID() + ".tmp");
      try {
        fs.writeFileSync(tmp, JSON.stringify(state), { encoding: "utf8", mode: 0o600, flag: "wx" });
        fs.renameSync(tmp, file);
      } finally { try { fs.unlinkSync(tmp); } catch {} }
    }
    return result;
  } finally {
    // Only the process which successfully mkdir'ed this lock may remove it.
    fs.rmdirSync(lock);
  }
}
function asSteps(value: unknown, fallback: string): Step[] {
  if (value === undefined) return [{ id: "task", prompt: text(fallback, "prompt", 12_000), dependsOn: [] }];
  if (!Array.isArray(value) || !value.length || value.length > 12) throw new Error("steps must contain 1-12 tasks.");
  const steps: Step[] = value.map((v: unknown) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("Invalid workflow step.");
    const a = v as Record<string, unknown>;
    const stepId = identifier(a.id, "step id");
    if (!Array.isArray(a.dependsOn) && a.dependsOn !== undefined) throw new Error("dependsOn must be an array.");
    const deps = (a.dependsOn ?? []) as unknown[];
    if (deps.length > 12) throw new Error("Too many dependencies.");
    return {
      id: stepId, prompt: text(a.prompt, "step prompt", 12_000),
      dependsOn: deps.map(d => identifier(d, "dependency")),
      ...(a.targetWorkerId ? { targetWorkerId: identifier(a.targetWorkerId, "targetWorkerId") } : {}),
    };
  });
  const map = new Map(steps.map(s => [s.id, s]));
  if (map.size !== steps.length) throw new Error("Duplicate step ID.");
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (s: Step) => {
    if (visiting.has(s.id)) throw new Error("Workflow dependencies contain a cycle.");
    if (visited.has(s.id)) return;
    visiting.add(s.id);
    for (const dep of s.dependsOn) {
      if (!map.has(dep)) throw new Error("Unknown dependency: " + dep);
      visit(map.get(dep)!);
    }
    visiting.delete(s.id); visited.add(s.id);
  };
  steps.forEach(visit);
  return steps;
}
function makeRun(s: Store, workflow: Workflow, now: number): Run {
  if (s.runs.length >= LIMIT.runs) throw new Error("Lifecycle run ledger is full; archive before scheduling more jobs.");
  const run: Run = {
    id: id("life_run"), workflowId: workflow.id, workspace: workflow.workspace,
    createdAt: now, updatedAt: now, state: "queued",
    stages: workflow.steps.map(step => ({ id: step.id, state: step.dependsOn.length ? "waiting" : "queued", attempts: 0 })),
  };
  s.runs.push(run);
  workflow.runCount++;
  if (workflow.maxRuns && workflow.runCount >= workflow.maxRuns) workflow.enabled = false;
  return run;
}
function findWorkflow(s: Store, workflowId: unknown, ctx: Context): Workflow {
  const flow = s.workflows.find(w => w.id === workflowId && w.workspace === ctx.workspace);
  if (!flow) throw new Error("Workflow not found in authorised workspace.");
  if (!ctx.admin && flow.owner !== ctx.principal) throw new Error("Workflow belongs to a different MCP principal.");
  return flow;
}
function findWorker(s: Store, workerId: unknown, ctx: Context): Worker {
  const worker = s.workers.find(w => w.id === workerId && w.workspace === ctx.workspace);
  if (!worker || !worker.enabled || worker.actor !== ctx.actor || worker.principal !== ctx.principal) {
    throw new Error("Worker identity is not bound to this authenticated MCP session.");
  }
  return worker;
}
function refreshState(s: Store, now: number) {
  for (const run of s.runs) {
    if (run.state !== "running") continue;
    let uncertain = false;
    for (const stage of run.stages) {
      if (stage.state === "leased" && (stage.leaseUntil ?? 0) < now) {
        stage.state = "review_required";
        stage.leaseDigest = undefined;
        stage.leaseUntil = undefined;
        stage.error = "Worker lease expired; operator must reconcile before any retry.";
        uncertain = true;
      }
    }
    if (uncertain) { run.state = "review_required"; run.updatedAt = now; }
  }
}
function scheduleDue(s: Store, now: number) {
  const date = new Date(now);
  const minute = [date.getFullYear(),date.getMonth()+1,date.getDate(),date.getHours(),date.getMinutes()].join("-");
  for (const flow of s.workflows) {
    if (!flow.enabled || flow.lastDueMinute === minute || !matchesCron(flow.cronExpression, date)) continue;
    flow.lastDueMinute = minute;
    makeRun(s, flow, now);
    flow.nextRun = flow.enabled ? getNextCronTime(flow.cronExpression, new Date(now)).getTime() : null;
  }
}
function evolveRun(run: Run, flow: Workflow, now: number) {
  if (run.stages.some(stage => stage.state === "review_required")) run.state = "review_required";
  else if (run.stages.some(stage => stage.state === "failed")) run.state = "failed";
  else if (run.stages.every(stage => stage.state === "completed")) run.state = "completed";
  else {
    for (const stage of run.stages.filter(stage => stage.state === "waiting")) {
      const spec = flow.steps.find(step => step.id === stage.id)!;
      if (spec.dependsOn.every(dep => run.stages.find(x => x.id === dep)?.state === "completed")) stage.state = "queued";
    }
    run.state = run.stages.some(stage => stage.state === "leased") ? "running" : "queued";
  }
  run.updatedAt = now;
}
function scope(ctx: Context): Context {
  if (!ctx.admin && (!/^mcp:[0-9a-f]{64}$/.test(ctx.actor) || !/^principal:[0-9a-f]{64}$/.test(ctx.principal))) {
    throw new Error("Lifecycle requires a verified MCP principal and session.");
  }
  return { ...ctx, workspace: absoluteWorkspace(ctx.workspace) };
}
function workflowView(flow: Workflow, ctx: Context) {
  return { ...flow, ...(ctx.admin || flow.owner === ctx.principal ? {} : { steps: flow.steps.map(s => ({ id: s.id, dependsOn: s.dependsOn })) }) };
}
/** All mutations use an atomic, exclusive cross-process store transaction. */
export function lifecycleAction(action: string, args: Record<string, unknown>, context: Context): unknown {
  const ctx = scope(context);
  const now = Date.now();
  const isRead = ["list", "workers", "status"].includes(action);
  return withStore(!isRead, s => {
    if (!isRead) refreshState(s, now);
    switch (action) {
      case "create": {
        const cron = text(args.cronExpression, "cronExpression", 120);
        if (!isValidCron(cron)) throw new Error("Invalid 5-field cron expression.");
        const name = text(args.name, "name", 120);
        const prompt = typeof args.prompt === "string" ? args.prompt : "";
        const steps = asSteps(args.steps, prompt);
        const maxRuns = args.maxRuns === undefined ? undefined : bounded(args.maxRuns, 100000, 1);
        const enabled = args.enabled !== false;
        const createKey = args.idempotencyKey === undefined ? undefined : identifier(args.idempotencyKey, "idempotencyKey");
        const createFingerprint = tokenDigest(JSON.stringify({ name, cron, steps, maxRuns, enabled }));
        if (createKey) {
          const previous = s.workflows.find(w => w.workspace === ctx.workspace &&
            w.owner === ctx.principal && w.createKey === createKey);
          if (previous) {
            if (previous.createFingerprint !== createFingerprint) throw new Error("Idempotency key already used for a different workflow.");
            return { workflow: workflowView(previous, ctx), replayed: true };
          }
        }
        if (s.workflows.length >= LIMIT.workflows) throw new Error("Lifecycle workflow limit reached.");
        const flow: Workflow = {
          id: id("life_flow"), owner: ctx.principal, workspace: ctx.workspace, name,
          cronExpression: cron, steps, enabled, createdAt: now,
          nextRun: getNextCronTime(cron).getTime(), runCount: 0,
          ...(maxRuns ? { maxRuns } : {}),
          ...(createKey ? { createKey, createFingerprint } : {}),
        };
        s.workflows.push(flow);
        return { workflow: workflowView(flow, ctx) };
      }
      case "list": {
        const workflows = s.workflows.filter(w => w.workspace === ctx.workspace)
          .slice(-bounded(args.limit, 100, 50)).map(flow => workflowView(flow, ctx));
        const runIds = new Set(workflows.map(w => w.id));
        const runs = s.runs.filter(r => r.workspace === ctx.workspace && runIds.has(r.workflowId))
          .slice(-100).map(r => ({ ...r, stages: r.stages.map(stage => ({
            id: stage.id, state: stage.state, attempts: stage.attempts,
            workerId: stage.workerId, error: stage.error,
            ...(ctx.admin || s.workflows.find(w => w.id === r.workflowId)?.owner === ctx.principal ? { result: stage.result } : {}),
          })) }));
        return { workflows, runs };
      }
      case "status": {
        const workflows = s.workflows.filter(w => w.workspace === ctx.workspace);
        const runs = s.runs.filter(r => r.workspace === ctx.workspace);
        return { workflowCount: workflows.length, activeWorkers: s.workers.filter(w => w.workspace === ctx.workspace && w.enabled && now-w.lastSeen < ONLINE_MS).length,
          queued: runs.filter(r=>r.state === "queued").length, running: runs.filter(r=>r.state === "running").length,
          reviewRequired: runs.filter(r=>r.state === "review_required").length };
      }
      case "workers": {
        return { workers: s.workers.filter(w => w.workspace === ctx.workspace && w.enabled).map(w => ({
          id: w.id, label: w.label, capabilities: w.capabilities, status: now - w.lastSeen < ONLINE_MS ? "online" : "offline",
          ...(ctx.admin && w.cdp ? { cdp: { ...w.cdp } } : {}),
        })) };
      }
      case "worker.register": {
        if (ctx.admin) throw new Error("Workers must register through their own MCP session.");
        if (s.workers.length >= LIMIT.workers) throw new Error("Worker registry capacity reached.");
        const label = text(args.label, "label", 80);
        const capabilities = Array.isArray(args.capabilities) ? args.capabilities.map(v => text(v, "capability", 50)).slice(0,12) : [];
        const resumeToken = crypto.randomBytes(32).toString("hex");
        const w: Worker = { id: id("life_worker"), workspace: ctx.workspace,
          principal: ctx.principal, actor: ctx.actor, label, capabilities,
          resumeDigest: tokenDigest(resumeToken), lastSeen: now, enabled: true };
        s.workers.push(w);
        return { workerId: w.id, resumeToken, status: "online" };
      }
      case "worker.resume": {
        if (ctx.admin) throw new Error("Worker resume requires MCP session.");
        const w = s.workers.find(w => w.id === args.workerId && w.workspace === ctx.workspace
          && w.principal === ctx.principal && w.enabled);
        if (!w || typeof args.resumeToken !== "string" ||
            !/^[0-9a-f]{64}$/.test(args.resumeToken) ||
            !crypto.timingSafeEqual(Buffer.from(w.resumeDigest, "hex"), Buffer.from(tokenDigest(args.resumeToken), "hex"))) {
          throw new Error("Invalid worker resume proof.");
        }
        w.actor = ctx.actor; w.lastSeen = now;
        return { workerId: w.id, status: "online" };
      }
      case "worker.bind": {
        if (!ctx.admin) throw new Error("Only the native operator may approve a CDP notification target.");
        const workerId = identifier(args.workerId, "workerId");
        const target = s.workers.find(w => w.id === workerId && w.workspace === ctx.workspace && w.enabled);
        if (!target) throw new Error("Registered worker not found.");
        const clientId = identifier(args.clientId, "clientId");
        if (!Number.isSafeInteger(args.tabId) || Number(args.tabId) <= 0) throw new Error("Exact ChatGPT tabId is required.");
        target.cdp = { clientId, tabId: Number(args.tabId), boundAt: now };
        return { workerId: target.id, cdp: { ...target.cdp } };
      }
      case "worker.unbind":
      case "worker.revoke": {
        if (!ctx.admin) throw new Error("Only the native operator may revoke a CDP target or worker.");
        const target = s.workers.find(w => w.id === args.workerId && w.workspace === ctx.workspace);
        if (!target) throw new Error("Worker not found.");
        target.cdp = undefined;
        if (action === "worker.revoke") {
          target.enabled = false;
          for (const run of s.runs.filter(r => r.workspace === ctx.workspace)) {
            let uncertain = false;
            for (const stage of run.stages) {
              if (stage.workerId === target.id && stage.state === "leased") {
                stage.state = "review_required"; stage.leaseDigest = undefined; stage.leaseUntil = undefined;
                stage.error = "Worker revoked; operator reconciliation required.";
                uncertain = true;
              }
            }
            if (uncertain) { run.state = "review_required"; run.updatedAt = now; }
          }
        }
        return { workerId: target.id, enabled: target.enabled, bound: false };
      }
      case "worker.heartbeat": {
        const w = findWorker(s, args.workerId, ctx);
        w.lastSeen = now;
        const active = s.runs.filter(r=>r.workspace === ctx.workspace).flatMap(r=>r.stages)
          .filter(x=>x.workerId === w.id && x.state === "leased").length;
        return { workerId:w.id, active };
      }
      case "worker.claim": {
        const w = findWorker(s, args.workerId, ctx);
        w.lastSeen = now;
        // One lease per verified worker, so the same ChatGPT conversation cannot
        // accidentally accept two independent mutable tasks concurrently.
        if (s.runs.some(r => r.stages.some(st => st.state === "leased" && st.workerId === w.id))) {
          return { status: "busy" };
        }
        for (const run of s.runs) {
          if (run.workspace !== ctx.workspace || run.state !== "queued" && run.state !== "running") continue;
          const flow = s.workflows.find(f => f.id === run.workflowId)!;
          const stage = run.stages.find(st => st.state === "queued" &&
            (!flow.steps.find(sp=>sp.id===st.id)?.targetWorkerId ||
              flow.steps.find(sp=>sp.id===st.id)?.targetWorkerId === w.id));
          if (!stage) continue;
          const step = flow.steps.find(x => x.id === stage.id)!;
          const leaseToken = crypto.randomBytes(32).toString("hex");
          stage.state = "leased"; stage.workerId = w.id; stage.attempts++;
          stage.leaseDigest = tokenDigest(leaseToken); stage.leaseUntil = now + LEASE_MS;
          run.state = "running"; run.updatedAt = now;
          return { status:"claimed", workflowId: flow.id, runId: run.id,
            stepId: step.id, leaseToken, leaseExpiresAt: stage.leaseUntil,
            prompt: step.prompt, workspace: flow.workspace,
            prerequisites: step.dependsOn.map(dep => ({
              id: dep, result: run.stages.find(st => st.id === dep)?.result ?? "",
            })) };
        }
        return { status: "empty" };
      }
      case "worker.renew":
      case "worker.complete": {
        const w = findWorker(s, args.workerId, ctx);
        w.lastSeen = now;
        const run = s.runs.find(r => r.id === args.runId && r.workspace === ctx.workspace);
        const stage = run?.stages.find(st => st.id === args.stepId && st.workerId === w.id);
        if (!run || !stage || stage.state !== "leased" || !stage.leaseDigest ||
            typeof args.leaseToken !== "string" || !/^[0-9a-f]{64}$/.test(args.leaseToken) ||
            !crypto.timingSafeEqual(Buffer.from(stage.leaseDigest, "hex"), Buffer.from(tokenDigest(args.leaseToken), "hex")) ||
            (stage.leaseUntil ?? 0) < now) throw new Error("Lease is expired, invalid, or belongs to another worker.");
        if (action === "worker.renew") {
          stage.leaseUntil = now + LEASE_MS; return { leaseExpiresAt: stage.leaseUntil };
        }
        const result = text(args.result, "result", 20_000);
        if (args.outcome !== "completed" && args.outcome !== "failed") throw new Error("Invalid worker outcome.");
        stage.state = args.outcome as "completed" | "failed";
        stage.result = result; stage.error = args.outcome === "failed" ? result.slice(0, 400) : undefined;
        stage.leaseDigest = undefined; stage.leaseUntil = undefined;
        const flow = s.workflows.find(f => f.id === run.workflowId)!;
        evolveRun(run, flow, now);
        return { runId: run.id, status: run.state, stepId: stage.id };
      }
      case "run.now": {
        const flow = findWorkflow(s, args.workflowId, ctx);
        const clientKey = args.idempotencyKey === undefined ? undefined : identifier(args.idempotencyKey, "idempotencyKey");
        const key = clientKey ? tokenDigest(ctx.principal + ":" + flow.id + ":" + clientKey) : undefined;
        const duplicate = key ? s.runs.find(r => r.manualRequestKey === key && r.workflowId === flow.id) : undefined;
        if (duplicate) return { run: duplicate, replayed: true };
        const run = makeRun(s, flow, now);
        if (key) run.manualRequestKey = key;
        return { run };
      }
      case "pause":
      case "resume": {
        const flow = findWorkflow(s, args.workflowId, ctx);
        flow.enabled = action === "resume"; return { workflowId: flow.id, enabled: flow.enabled };
      }
      case "cancel": {
        const flow = findWorkflow(s, args.workflowId, ctx);
        flow.enabled = false;
        for (const run of s.runs.filter(r => r.workflowId === flow.id && ["queued", "running"].includes(r.state))) {
          // Cancelling a lease cannot stop an already dispatched external agent.
          // Keep an uncertain side effect in review_required, not falsely cancelled.
          const hasActiveLease = run.stages.some(stage => stage.state === "leased");
          run.state = hasActiveLease ? "review_required" : "cancelled";
          run.updatedAt = now;
          for (const stage of run.stages) {
            if (stage.state === "leased") {
              stage.state = "review_required";
              stage.error = "Cancelled while external worker may still be active; reconcile manually.";
              stage.leaseDigest = undefined; stage.leaseUntil = undefined;
            } else if (stage.state === "queued" || stage.state === "waiting") stage.state = "cancelled";
          }
        }
        return { workflowId: flow.id, status: "cancelled" };
      }
      case "review.retry": {
        if (!ctx.admin) throw new Error("Review and replay require explicit local operator action.");
        const run = s.runs.find(r => r.id === args.runId && r.workspace === ctx.workspace);
        if (!run || run.state !== "review_required") throw new Error("Run does not need reconciliation.");
        const stage = run.stages.find(st=>st.id === args.stepId && st.state==="review_required");
        if (!stage) throw new Error("Stage is not awaiting review.");
        stage.state = "queued"; stage.workerId = undefined; stage.error = undefined;
        run.state = "queued"; run.updatedAt = now;
        return { runId: run.id, stepId: stage.id, status: "queued" };
      }
      default: throw new Error("Unsupported lifecycle action.");
    }
  });
}
export function tickExternalLifecycle(now = Date.now()): void {
  withStore(true, state => {
    refreshState(state, now);
    scheduleDue(state, now);
  });
}


export type CdpWakeCandidate = {
  runId: string; stepId: string; workerId: string; workflowId: string;
  clientId: string; tabId: number; requestId?: string;
};
/** Read-only: validate the exact paired Chrome tab BEFORE reserving a wake-up. */
export function listCdpWakeCandidates(): CdpWakeCandidate[] {
  return withStore(false, state => {
    const result: CdpWakeCandidate[] = [];
    const suppressed = new Set<string>();
    // A worker with a leased stage or an already-sent, unclaimed wake-up
    // must not receive another asynchronous prompt in the same ChatGPT tab.
    for (const run of state.runs) {
      const flow = state.workflows.find(w => w.id === run.workflowId);
      for (const stage of run.stages) {
        if (stage.state === "leased" && stage.workerId) suppressed.add(stage.workerId);
        const selected = flow?.steps.find(step => step.id === stage.id)?.targetWorkerId;
        if (stage.state === "queued" && stage.nudge && selected) suppressed.add(selected);
      }
    }
    for (const run of state.runs) {
      if (run.state !== "queued" && run.state !== "running") continue;
      const workflow = state.workflows.find(w => w.id === run.workflowId);
      if (!workflow) continue;
      for (const stage of run.stages) {
        if (stage.state !== "queued" || stage.nudge) continue;
        const step = workflow.steps.find(t => t.id === stage.id);
        if (!step?.targetWorkerId) continue;
        const worker = state.workers.find(w => w.id === step.targetWorkerId && w.workspace === workflow.workspace
          && w.enabled && w.cdp);
        if (!worker?.cdp || suppressed.has(worker.id)) continue;
        suppressed.add(worker.id);
        result.push({ runId: run.id, stepId: stage.id, workerId: worker.id, workflowId: workflow.id,
          clientId: worker.cdp.clientId, tabId: worker.cdp.tabId });
        if (result.length >= 12) return result;
      }
    }
    return result;
  });
}
/** Single-use durable reservation. A crash or timeout is uncertain, never automatically replayed. */
export function reserveCdpWake(candidate: CdpWakeCandidate): (CdpWakeCandidate & { requestId: string }) | null {
  return withStore(true, s => {
    const run = s.runs.find(r => r.id === candidate.runId);
    const stage = run?.stages.find(st => st.id === candidate.stepId);
    const flow = s.workflows.find(w => w.id === run?.workflowId);
    const step = flow?.steps.find(t => t.id === stage?.id);
    const worker = s.workers.find(w => w.id === candidate.workerId);
    if (!run || !stage || !flow || !worker?.cdp || !worker.enabled ||
        stage.state !== "queued" || stage.nudge ||
        step?.targetWorkerId !== worker.id ||
        worker.cdp.clientId !== candidate.clientId || worker.cdp.tabId !== candidate.tabId) return null;
    const requestId = "life_" + crypto.randomUUID();
    stage.nudge = { requestId, state: "dispatching", at: Date.now() };
    return { ...candidate, requestId };
  });
}
export function settleCdpWake(candidate: CdpWakeCandidate, success: boolean, reason?: string): void {
  withStore(true, state => {
    const run = state.runs.find(r => r.id === candidate.runId);
    const stage = run?.stages.find(st => st.id === candidate.stepId);
    if (!stage?.nudge || stage.nudge.requestId !== candidate.requestId ||
        stage.nudge.state !== "dispatching") return;
    stage.nudge.state = success ? "confirmed" : "uncertain";
    stage.nudge.at = Date.now();
    if (!success) stage.nudge.reason = (reason || "Delivery uncertain; no automatic replay.").slice(0, 250);
    if (run) run.updatedAt = Date.now();
  });
}

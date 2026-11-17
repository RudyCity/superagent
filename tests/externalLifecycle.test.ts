import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  lifecycleAction, tickExternalLifecycle, listCdpWakeCandidates, reserveCdpWake, settleCdpWake,
} from "../src/core/lifecycle/externalLifecycle.js";
import { MCP_TOOL_CLASSIFICATION, DISABLED_MCP_TOOLS } from "../src/core/mcp/mcpToolPolicy.js";
import { getProjectCapabilityForTool } from "../src/core/project/projectAccessPolicy.js";

type Ctx = { workspace: string; actor: string; principal: string; admin?: boolean };
const owner = (workspace: string): Ctx => ({
  workspace, actor: "mcp:" + "a".repeat(64), principal: "principal:" + "1".repeat(64),
});
const worker = (workspace: string, index: number): Ctx => ({
  workspace, actor: "mcp:" + String(index).repeat(64),
  principal: "principal:" + String(index).repeat(64),
});
const operator = (workspace: string): Ctx => ({
  workspace, actor: "local-operator", principal: "local-operator", admin: true,
});
const timeCron = (when: Date) =>
  [when.getMinutes(), when.getHours(), when.getDate(), when.getMonth()+1, "*"].join(" ");
const call = (action: string, input: Record<string, unknown>, ctx: Ctx) =>
  lifecycleAction(action, input, ctx) as any;

describe("external ChatGPT lifecycle — persistent MCP pull worker contract", () => {
  let root = "", workspace = "", previousConfig: string | undefined;

  beforeEach(() => {
    previousConfig = process.env.SUPERAGENT_CONFIG_DIR;
    root = fs.mkdtempSync(path.join(os.tmpdir(), "superagent-life-"));
    workspace = path.join(root, "project");
    fs.mkdirSync(workspace);
    process.env.SUPERAGENT_CONFIG_DIR = path.join(root, "config");
  });
  afterEach(() => {
    if (previousConfig === undefined) delete process.env.SUPERAGENT_CONFIG_DIR;
    else process.env.SUPERAGENT_CONFIG_DIR = previousConfig;
    fs.rmSync(root, { recursive: true, force: true });
  });

  function scheduled(steps?: unknown[]) {
    const when = new Date(Date.now() + 180_000);
    when.setSeconds(0, 0);
    const flow = call("create", {
      name: "Review build", prompt: "Check test status",
      cronExpression: timeCron(when), steps, maxRuns: 1,
    }, owner(workspace)).workflow;
    tickExternalLifecycle(when.getTime());
    return flow;
  }

  it("registers two independent ChatGPT workers and runs parallel DAG roots then dependent review", () => {
    const b = worker(workspace, 2), c = worker(workspace, 3);
    const wb = call("worker.register", { label: "ChatGPT B" }, b);
    const wc = call("worker.register", { label: "ChatGPT C" }, c);
    const flow = scheduled([
      { id: "audit", prompt: "Audit GitHub", dependsOn: [], targetWorkerId: wb.workerId },
      { id: "checks", prompt: "Inspect workflows", dependsOn: [], targetWorkerId: wc.workerId },
      { id: "review", prompt: "Merge findings", dependsOn: ["audit", "checks"], targetWorkerId: wb.workerId },
    ]);
    const claimB = call("worker.claim", { workerId: wb.workerId }, b);
    const claimC = call("worker.claim", { workerId: wc.workerId }, c);
    expect(claimB.status).toBe("claimed");
    expect(claimB.stepId).toBe("audit");
    expect(claimC.stepId).toBe("checks");
    expect(claimB.runId).toBe(claimC.runId);
    expect(call("worker.claim", { workerId: wb.workerId }, b).status).toBe("busy");
    call("worker.complete", { workerId: wb.workerId, runId: claimB.runId,
      stepId: claimB.stepId, leaseToken: claimB.leaseToken,
      outcome: "completed", result: "Audit complete" }, b);
    expect(call("worker.claim", { workerId: wb.workerId }, b).status).toBe("empty");
    call("worker.complete", { workerId: wc.workerId, runId: claimC.runId,
      stepId: claimC.stepId, leaseToken: claimC.leaseToken,
      outcome: "completed", result: "Checks complete" }, c);
    const review = call("worker.claim", { workerId: wb.workerId }, b);
    expect(review.stepId).toBe("review");
    expect(review.prerequisites).toEqual([
      { id: "audit", result: "Audit complete" }, { id: "checks", result: "Checks complete" },
    ]);
    call("worker.complete", { workerId: wb.workerId, runId: review.runId,
      stepId: review.stepId, leaseToken: review.leaseToken,
      outcome: "completed", result: "Verified" }, b);
    const ledger = call("list", {}, owner(workspace));
    expect(ledger.runs.find((r: any) => r.workflowId === flow.id).state).toBe("completed");
    expect(ledger.workflows.find((w: any) => w.id === flow.id).enabled).toBe(false);
  });

  it("preserves queued jobs across reads and scheduler ticks without double-run", () => {
    const flow = scheduled();
    tickExternalLifecycle();
    tickExternalLifecycle();
    const inventory = call("list", {}, owner(workspace));
    expect(inventory.runs.filter((r: any) => r.workflowId === flow.id)).toHaveLength(1);
    expect(inventory.workflows[0].runCount).toBe(1);
    expect(fs.existsSync(path.join(root, "config", "external-lifecycle", "state.json"))).toBe(true);
  });

  it("denies spoofed sessions, foreign leases, duplicate completions and cross-project access", () => {
    const b = worker(workspace, 2), c = worker(workspace, 3);
    const wb = call("worker.register", { label: "B" }, b);
    scheduled();
    expect(() => call("worker.claim", { workerId: wb.workerId }, c)).toThrow(/identity/);
    const claim = call("worker.claim", { workerId: wb.workerId }, b);
    expect(() => call("worker.complete", {
      workerId: wb.workerId, runId: claim.runId, stepId: claim.stepId,
      leaseToken: "0".repeat(64), outcome: "completed", result: "spoof",
    }, b)).toThrow(/Lease/);
    expect(() => call("worker.complete", {
      workerId: wb.workerId, runId: claim.runId, stepId: claim.stepId,
      leaseToken: claim.leaseToken, outcome: "completed", result: "foreign",
    }, c)).toThrow(/identity/);
    call("worker.complete", { workerId: wb.workerId, runId: claim.runId,
      stepId: claim.stepId, leaseToken: claim.leaseToken,
      outcome: "completed", result: "ok" }, b);
    expect(() => call("worker.complete", { workerId: wb.workerId, runId: claim.runId,
      stepId: claim.stepId, leaseToken: claim.leaseToken, outcome: "completed", result: "duplicate",
    }, b)).toThrow(/Lease/);
    const other = path.join(root,"other"); fs.mkdirSync(other);
    expect(call("list", {}, owner(other)).runs).toHaveLength(0);
    expect(() => call("worker.claim", { workerId: wb.workerId }, worker(other, 2))).toThrow(/identity/);
  });

  it("moves expired leases into manual-review-only state without automatic replay", () => {
    const b = worker(workspace, 2);
    const reg = call("worker.register", { label:"B" }, b);
    scheduled();
    const claim = call("worker.claim", { workerId:reg.workerId }, b);
    tickExternalLifecycle(Date.now() + 7*60_000);
    const review = call("list", {}, owner(workspace)).runs[0];
    expect(review.state).toBe("review_required");
    expect(call("worker.claim", {workerId:reg.workerId},b).status).toBe("empty");
    expect(() => call("review.retry", {runId:claim.runId,stepId:claim.stepId},owner(workspace))).toThrow(/operator/);
    call("review.retry", {runId:claim.runId,stepId:claim.stepId},operator(workspace));
    expect(call("worker.claim", {workerId:reg.workerId},b).status).toBe("claimed");
  });

  it("permits authenticated reconnect only with the original principal and secret proof", () => {
    const b = worker(workspace, 2);
    const w = call("worker.register", { label: "B" }, b);
    const successor = { ...b, actor: "mcp:" + "f".repeat(64) };
    expect(() => call("worker.heartbeat",{workerId:w.workerId},successor)).toThrow();
    expect(() => call("worker.resume",{workerId:w.workerId,resumeToken:"0".repeat(64)},successor)).toThrow();
    expect(() => call("worker.resume",{workerId:w.workerId,resumeToken:w.resumeToken},worker(workspace,3))).toThrow();
    expect(call("worker.resume",{workerId:w.workerId,resumeToken:w.resumeToken},successor).status).toBe("online");
    expect(call("worker.heartbeat",{workerId:w.workerId},successor).active).toBe(0);
  });

  it("deduplicates retried schedule creation and manual runs using stable caller keys", () => {
    const input = {
      name: "Daily audit", cronExpression: "0 8 * * *", prompt: "Read CI results",
      idempotencyKey: "request_abcdef012345",
    };
    const first = call("create", input, owner(workspace));
    const second = call("create", input, owner(workspace));
    expect(second.workflow.id).toBe(first.workflow.id);
    expect(second.replayed).toBe(true);
    expect(() => call("create", { ...input, prompt: "different intent" }, owner(workspace)))
      .toThrow(/different workflow/);
    const manual1 = call("run.now", {workflowId:first.workflow.id, idempotencyKey:"manual_001"}, owner(workspace));
    const manual2 = call("run.now", {workflowId:first.workflow.id, idempotencyKey:"manual_001"}, owner(workspace));
    expect(manual2.run.id).toBe(manual1.run.id);
    expect(manual2.replayed).toBe(true);
    expect(call("list",{},owner(workspace)).runs).toHaveLength(1);
  });

  it("rejects invalid workflow graphs, unsafe identities and corrupt persisted state", () => {
    expect(() => call("create", {name:"bad", cronExpression:"* * * * *", steps:[
      {id:"a", prompt:"one", dependsOn:["b"]},
      {id:"b", prompt:"two", dependsOn:["a"]},
    ]}, owner(workspace))).toThrow(/cycle/);
    expect(() => call("create", {name:"bad",cronExpression:"* * * * *",prompt:"hi"},
      {...owner(workspace), actor:"client-supplied-id"})).toThrow(/verified/);
    const file = path.join(root,"config","external-lifecycle","state.json");
    fs.mkdirSync(path.dirname(file), {recursive:true});
    fs.writeFileSync(file,'{"version":999}',"utf8");
    expect(() => call("status",{},owner(workspace))).toThrow(/schema/);
  });

  it("reserves at most one CDP notification per worker and never replays ambiguous delivery", () => {
    const b = worker(workspace, 2);
    const reg = call("worker.register", { label:"ChatGPT B" }, b);
    expect(() => call("worker.bind", {
      workerId: reg.workerId, clientId:"profile1234", tabId:15,
    }, owner(workspace))).toThrow(/native operator/);
    call("worker.bind", { workerId:reg.workerId, clientId:"profile1234", tabId:15 }, operator(workspace));
    const flow = scheduled([
      { id:"a", prompt:"Task A", dependsOn:[], targetWorkerId:reg.workerId },
      { id:"b", prompt:"Task B", dependsOn:[], targetWorkerId:reg.workerId },
    ]);
    const selected = listCdpWakeCandidates();
    expect(selected).toHaveLength(1);
    expect(selected[0].workflowId).toBe(flow.id);
    const notice = reserveCdpWake(selected[0]);
    expect(notice?.requestId).toMatch(/^life_/);
    expect(reserveCdpWake(selected[0])).toBeNull();
    settleCdpWake(notice!, false, "timeout; uncertain remote delivery");
    expect(listCdpWakeCandidates()).toHaveLength(0);
    expect(call("worker.claim", {workerId:reg.workerId}, b).status).toBe("claimed");
    expect(call("workers", {}, b).workers[0].cdp).toBeUndefined();
    expect(call("workers", {}, operator(workspace)).workers[0].cdp.tabId).toBe(15);
  });

  it("marks cancellation of leased external action uncertain, and revokes without replay", () => {
    const b = worker(workspace, 2);
    const reg = call("worker.register", {label:"B"},b);
    const flow = scheduled();
    const claim = call("worker.claim", {workerId:reg.workerId},b);
    call("cancel", {workflowId:flow.id}, owner(workspace));
    expect(call("list",{},owner(workspace)).runs[0].state).toBe("review_required");
    expect(() => call("worker.complete", {workerId:reg.workerId,
      runId:claim.runId,stepId:claim.stepId,leaseToken:claim.leaseToken,
      outcome:"completed",result:"late"},b)).toThrow(/Lease/);
    call("worker.revoke", {workerId:reg.workerId},operator(workspace));
    expect(call("workers",{},operator(workspace)).workers).toHaveLength(0);
  });

  it("does not expose internal agent controls over MCP", () => {
    expect(DISABLED_MCP_TOOLS.has("superagent_run_task")).toBe(true);
    expect(DISABLED_MCP_TOOLS.has("superagent_send_message")).toBe(true);
    expect(MCP_TOOL_CLASSIFICATION.superagent_lifecycle).toBe("dangerous");
    expect(MCP_TOOL_CLASSIFICATION.superagent_lifecycle_status).toBe("safe");
    expect(getProjectCapabilityForTool("superagent_lifecycle")).toBe("execute");
    expect(getProjectCapabilityForTool("superagent_lifecycle_status")).toBe("read");
  });
});

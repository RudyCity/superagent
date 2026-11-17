import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const mock = vi.hoisted(() => ({
  listConnections: vi.fn(),
  request: vi.fn(),
  executeOnce: vi.fn(),
  withSemanticDelegateTarget: vi.fn(),
}));
vi.mock("../src/core/delegate/bridge.js", () => ({
  delegateBridge: {
    listConnections: mock.listConnections,
    request: mock.request,
    executeOnce: mock.executeOnce,
  },
}));
vi.mock("../src/core/tools/delegateTools.js", () => ({
  withSemanticDelegateTarget: mock.withSemanticDelegateTarget,
}));
import { lifecycleAction, listCdpWakeCandidates } from "../src/core/lifecycle/externalLifecycle.js";
import {
  listApprovedCdpTargets, verifyApprovedCdpTarget, dispatchCdpWakeNotifications,
} from "../src/core/lifecycle/cdpWakeAdapter.js";

const principal = (workspace: string) => ({
  workspace, actor: "mcp:" + "a".repeat(64), principal: "principal:" + "b".repeat(64),
});
const admin = (workspace: string) => ({
  workspace, actor: "local-operator", principal: "local-operator", admin: true,
});
describe("external lifecycle exact-tab CDP wake adapter", () => {
  let root: string, workspace: string;
  let priorDir: string | undefined;
  const action = (kind: string, args: Record<string, unknown>, ctx: any) =>
    lifecycleAction(kind, args, ctx) as any;

  beforeEach(() => {
    priorDir = process.env.SUPERAGENT_CONFIG_DIR;
    root = fs.mkdtempSync(path.join(os.tmpdir(), "life-cdp-"));
    workspace = path.join(root, "project");
    fs.mkdirSync(workspace);
    process.env.SUPERAGENT_CONFIG_DIR = path.join(root, "profile");
    mock.listConnections.mockReset().mockReturnValue([
      { clientId:"profile1234", label:"ChatGPT B", capabilities:["delegate"] },
    ]);
    mock.request.mockReset().mockImplementation(async (method: string) => {
      if (method === "delegate.list_tabs") return JSON.stringify({
        tabs: [
          { tabId:42, title:"Worker B", url:"https://chatgpt.com/c/example", status:"idle", ready:true },
          { tabId:43, title:"Unready", url:"https://chatgpt.com/c/other", status:"generating", ready:true },
          { tabId:44, title:"Wrong origin", url:"https://example.net", status:"idle", ready:true },
        ], total:3,
      });
      if (method === "delegate.send_message") return JSON.stringify({ sent:true });
      throw new Error("Unexpected bridge method: " + method);
    });
    mock.executeOnce.mockReset().mockImplementation(async (
      _requestId: string, _method: string, _clientId: string,
      _params: Record<string, unknown>, execute: () => Promise<unknown>,
    ) => execute());
    mock.withSemanticDelegateTarget.mockReset().mockImplementation(async (
      _method: string, clientId: string, _tabId: number, _newTab: boolean,
      execute: (clientId: string) => Promise<unknown>,
    ) => execute(clientId));
  });
  afterEach(() => {
    if (priorDir === undefined) delete process.env.SUPERAGENT_CONFIG_DIR;
    else process.env.SUPERAGENT_CONFIG_DIR = priorDir;
    fs.rmSync(root, { recursive:true, force:true });
  });
  function pending() {
    const actor = principal(workspace);
    const w = action("worker.register", {label:"ChatGPT B"}, actor);
    action("worker.bind", {workerId:w.workerId, clientId:"profile1234", tabId:42}, admin(workspace));
    const flow = action("create", {
      name:"One-shot external task", cronExpression:"0 8 * * *",
      steps:[{id:"audit",prompt:"Inspect CI", dependsOn:[], targetWorkerId:w.workerId}],
    }, actor).workflow;
    const run = action("run.now", {workflowId:flow.id}, actor).run;
    return { actor, workerId:w.workerId, run };
  }
  it("exposes only idle, ready ChatGPT.com targets from explicit paired profile", async () => {
    const targets = await listApprovedCdpTargets();
    expect(targets).toHaveLength(1);
    expect(targets[0].tabs.map(tab => tab.tabId)).toEqual([42]);
    await expect(verifyApprovedCdpTarget("profile1234", 43)).rejects.toThrow(/not verified/);
    await expect(verifyApprovedCdpTarget("profile1234", 44)).rejects.toThrow(/not verified/);
    await expect(verifyApprovedCdpTarget("unknown111", 42)).rejects.toThrow(/offline/);
  });
  it("only notifies bound exact tab once; worker still claims through its own MCP session", async () => {
    const {actor,workerId,run} = pending();
    expect(listCdpWakeCandidates()).toHaveLength(1);
    await dispatchCdpWakeNotifications();
    const send = mock.request.mock.calls.filter(call => call[0] === "delegate.send_message");
    expect(send).toHaveLength(1);
    expect(send[0][2]).toBeUndefined(); // No out-of-band signal bypasses the paired bridge.
    const params = send[0][1];
    expect(params.tabId).toBe(42);
    expect(params.message).toContain("worker.claim");
    expect(params.message).not.toContain("Inspect CI");
    expect(listCdpWakeCandidates()).toHaveLength(0);
    await dispatchCdpWakeNotifications();
    expect(mock.request.mock.calls.filter(call=>call[0] === "delegate.send_message")).toHaveLength(1);
    const claim = action("worker.claim",{workerId},actor);
    expect(claim.status).toBe("claimed");
    expect(claim.runId).toBe(run.id);
    expect(claim.prompt).toBe("Inspect CI");
  });
  it("does not send when the bound tab stops being idle or profile disconnects", async () => {
    pending();
    mock.request.mockImplementationOnce(async () => JSON.stringify({
      tabs:[{tabId:42,url:"https://chatgpt.com/c/example",ready:true,status:"generating"}], total:1,
    }));
    await dispatchCdpWakeNotifications();
    expect(mock.request.mock.calls.some(call => call[0] === "delegate.send_message")).toBe(false);
    expect(listCdpWakeCandidates()).toHaveLength(1);
    mock.listConnections.mockReturnValue([]);
    await dispatchCdpWakeNotifications();
    expect(mock.request.mock.calls.some(call => call[0] === "delegate.send_message")).toBe(false);
  });
});

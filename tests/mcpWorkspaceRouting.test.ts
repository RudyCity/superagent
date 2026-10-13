/**
 * mcpWorkspaceRouting.test.ts - MCP tools must route to the requested workspace.
 *
 * Covers T1/T2 from docs/plans/2026-10-13-mcp-multi-project-fix-plan.md:
 * run_task / invoke / interrupt send x-workspace-path, and an explicit server
 * rejection never falls back to local (guard-bypassing) execution.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import http from "http";
import path from "path";
import { EventEmitter } from "events";
import { callServerApi } from "../src/core/mcp/tools/processTools.js";
import { resolveMcpWorkspace } from "../src/core/mcp/tools/workspaceContext.js";
import { handleRunTask, handleInvoke } from "../src/core/mcp/tools/executionTools.js";
import { handleInterrupt } from "../src/core/mcp/tools/processTools.js";

interface Captured {
  options: any;
  body: string;
}

function mockHttp(status: number, payload: unknown, captured: Captured[]) {
  return vi.spyOn(http, "request").mockImplementation(((options: any, cb: any) => {
    const entry: Captured = { options, body: "" };
    captured.push(entry);
    const req: any = new EventEmitter();
    req.write = (chunk: string) => {
      entry.body += chunk;
    };
    req.destroy = () => {};
    req.end = () => {
      const res: any = new EventEmitter();
      res.statusCode = status;
      res.setEncoding = () => {};
      cb(res);
      res.emit("data", JSON.stringify(payload));
      res.emit("end");
    };
    return req;
  }) as any);
}

const textOf = (r: { content: { text: string }[] }) => r.content.map((c) => c.text).join("\n");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("callServerApi workspace routing", () => {
  it("sends x-workspace-path only when a workspace is given", async () => {
    const calls: Captured[] = [];
    mockHttp(200, { ok: true }, calls);

    await callServerApi("/api/chat", "POST", { message: "hi" }, 1000, { workspace: "D:\\proj\\b" });
    await callServerApi("/api/chat", "POST", { message: "hi" }, 1000);

    expect(calls[0].options.headers["x-workspace-path"]).toBe("D:\\proj\\b");
    expect(calls[1].options.headers["x-workspace-path"]).toBeUndefined();
  });

  it("moves non-ASCII workspace paths to the query string", async () => {
    const calls: Captured[] = [];
    mockHttp(200, {}, calls);

    await callServerApi("/api/chat", "POST", {}, 1000, { workspace: "D:\\proyek\\café" });

    expect(calls[0].options.headers["x-workspace-path"]).toBeUndefined();
    expect(calls[0].options.path).toContain("workspace=" + encodeURIComponent("D:\\proyek\\café"));
  });
});

describe("resolveMcpWorkspace", () => {
  it("normalizes explicit local paths and keeps ssh targets verbatim", () => {
    expect(resolveMcpWorkspace("some/rel")).toEqual({ path: path.resolve("some/rel"), explicit: true });
    expect(resolveMcpWorkspace("ssh://host/repo")).toEqual({ path: "ssh://host/repo", explicit: true });
  });

  it("reports explicit:false when no workspace is given", () => {
    expect(resolveMcpWorkspace(undefined).explicit).toBe(false);
    expect(resolveMcpWorkspace("   ").explicit).toBe(false);
  });
});

describe("handleRunTask", () => {
  it("routes two workspaces to two different headers (T1/T2)", async () => {
    const calls: Captured[] = [];
    mockHttp(200, { success: true }, calls);

    await handleRunTask({ task: "do a", workspace: "D:\\proj\\a" });
    await handleRunTask({ task: "do b", workspace: "D:\\proj\\b" });

    expect(calls[0].options.headers["x-workspace-path"]).toBe(path.resolve("D:\\proj\\a"));
    expect(calls[1].options.headers["x-workspace-path"]).toBe(path.resolve("D:\\proj\\b"));
  });

  it("sends no header and says so when workspace is omitted", async () => {
    const calls: Captured[] = [];
    mockHttp(200, { success: true }, calls);

    const res = await handleRunTask({ task: "do it" });

    expect(calls[0].options.headers["x-workspace-path"]).toBeUndefined();
    expect(textOf(res as any)).toContain("no 'workspace' given");
  });

  it("returns an error instead of running headless when the server rejects an explicit workspace", async () => {
    const calls: Captured[] = [];
    mockHttp(400, { error: "Session not initialized" }, calls);

    const res: any = await handleRunTask({ task: "do b", workspace: "D:\\proj\\b" });

    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("No session is available");
    expect(calls).toHaveLength(1);
  });
});

describe("handleInvoke", () => {
  it("sends the workspace header and surfaces a plan-gate refusal as an error", async () => {
    const calls: Captured[] = [];
    mockHttp(200, { success: true, result: "Error: Spawning or merging Superagents is blocked." }, calls);

    const res: any = await handleInvoke({ role: "coder", task: "t", branch: "b", workspace: "D:\\proj\\b" });

    expect(calls[0].options.headers["x-workspace-path"]).toBe(path.resolve("D:\\proj\\b"));
    expect(res.isError).toBe(true);
  });

  it("does not fall back to local invoke on a 403 workspace rejection", async () => {
    const calls: Captured[] = [];
    mockHttp(403, { error: "Workspace is outside the registered roots." }, calls);

    const res: any = await handleInvoke({ role: "coder", task: "t", branch: "b", workspace: "D:\\elsewhere" });

    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("outside the registered roots");
    expect(calls).toHaveLength(1);
  });
});

describe("handleInterrupt", () => {
  it("scopes the server abort to the given workspace", async () => {
    const calls: Captured[] = [];
    mockHttp(200, { success: true }, calls);

    await handleInterrupt({ target: "master", workspace: "D:\\proj\\a" });

    expect(calls[0].options.headers["x-workspace-path"]).toBe(path.resolve("D:\\proj\\a"));
    expect(JSON.parse(calls[0].body).all).toBeUndefined();
  });

  it("only requests a global abort with an explicit all:true", async () => {
    const calls: Captured[] = [];
    mockHttp(200, { success: true }, calls);

    await handleInterrupt({ target: "master", all: true, workspace: "D:\\proj\\a" });

    expect(calls[0].options.headers["x-workspace-path"]).toBeUndefined();
    expect(JSON.parse(calls[0].body).all).toBe(true);
  });
});

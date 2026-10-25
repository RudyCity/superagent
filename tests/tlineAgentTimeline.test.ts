import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import type http from "node:http";
import { recordAgentTimeline, readAgentTimeline, projectAgentTimelineEnvelope,
  setAgentTimelineRootForTests, AGENT_TIMELINE_MAX, bindTlineRootAgent,
  inheritTlineChildScope, recordTlineChildToolEvent } from "../src/core/channels/tlineAgentTimeline.js";
import { handleTlineAgentTimelineRoute } from "../src/core/channels/tlineAgentTimelineHttp.js";

let root = "";
const scope = { workspace: "D:/Example/private/project", sessionId: "session_001" };
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "tline-agent-events-"));
  setAgentTimelineRootForTests(root);
});
afterEach(() => {
  setAgentTimelineRootForTests();
  rmSync(root, { recursive: true, force: true });
});

describe("durable T-Line execution journal", () => {
  it("projects tool actions, approval lifecycle and subagent states without retaining secrets", () => {
    const inputs = [
      { type: "agent_event", event: {
        type: "tool_start", description: "My secret password is PASS!",
        toolCall: { id: "capability_secret", name: "read_files", args: {
          filePath: "D:/Secrets/.env", token: "MY_ULTRA_PRIVATE_TOKEN", content: "password=secret" },
        },
      }},
      { type: "agent_event", event: { type: "tool_end",
        toolResult: { name: "read_files", isError: false, result: "secret password" },
      }},
      { type: "permission_required", permissionId: "sensitive_permission_id",
        description: "Delete file: D:/Secrets", toolCall: { name: "write_file", args: { password: "secret" } } },
      { type: "subagents_update", subagents: [{
        id: "sensitive_session_subagent", role: "Coder", status: "running",
        prompt: "secret instructions", logs: ["TOP_SECRET"], result: "PRIVATE",
      }] },
    ];
    for (const event of inputs) {
      for (const projected of projectAgentTimelineEnvelope(event)) {
        expect(recordAgentTimeline(scope, projected)).toBe(true);
      }
    }
    expect(recordAgentTimeline(scope, { kind: "permission_decided", actor: "main", status: "approved" })).toBe(true);
    const replay = readAgentTimeline(scope, 0);
    expect(replay.events.map(e => e.kind)).toEqual([
      "tool_start", "tool_end", "permission_requested", "subagent_status", "permission_decided",
    ]);
    expect(replay.events.map(e => e.seq)).toEqual([1,2,3,4,5]);
    const disk = readFileSync(path.join(root, readdirSync(root).find(x => x.endsWith(".json"))!), "utf8");
    for (const secret of ["password", "MY_ULTRA_PRIVATE_TOKEN", "D:/Secrets",
      "secret instructions", "sensitive_permission_id", "sensitive_session_subagent", scope.workspace,
      scope.sessionId, "TOP_SECRET", "PRIVATE", "capability_secret"]) {
      expect(disk).not.toContain(secret);
    }
    expect(disk).toContain("read_files");
  });

  it("records child tool events ONLY after trusted parent/session inheritance", () => {
    const rootAgent = {}; const child = {}; const nested = {}; const foreign = {};
    const started = { type: "tool_start", toolCall: {
      name: "read_files", args: { secretToken: "DONT_LOG_MY_SECRET" },
    } };
    expect(recordTlineChildToolEvent(child, "subagentA", started)).toBe(false);
    expect(inheritTlineChildScope(rootAgent, child)).toBe(false);
    bindTlineRootAgent(rootAgent, scope);
    expect(inheritTlineChildScope(rootAgent, child)).toBe(true);
    expect(inheritTlineChildScope(child, nested)).toBe(true);
    expect(recordTlineChildToolEvent(child, "subagentA", started)).toBe(true);
    expect(recordTlineChildToolEvent(nested, "subagentB", {
      type: "tool_end", toolResult: { name: "write_file", isError: true,
        result: "DONT_LOG_MY_SECRET" } as any,
    })).toBe(true);
    expect(recordTlineChildToolEvent(foreign, "subagentA", started)).toBe(false);
    const records = readAgentTimeline(scope, 0).events;
    expect(records.map(e => e.kind)).toEqual(["tool_start", "tool_end"]);
    expect(records[0].actor).toMatch(/^sub:[a-f0-9]{20}$/);
    expect(records[1].actor).not.toBe(records[0].actor);
    expect(records[1].status).toBe("failed");
    expect(JSON.stringify(records)).not.toContain("DONT_LOG_MY_SECRET");
    expect(JSON.stringify(records)).not.toContain("subagentA");
  });

  it("survives a recreated reader and provides monotonic cursor pages", () => {
    expect(recordAgentTimeline(scope, { kind: "tool_start", actor: "main", tool: "search" })).toBe(true);
    expect(recordAgentTimeline(scope, { kind: "tool_end", actor: "main", tool: "search", status: "completed" })).toBe(true);
    const first = readAgentTimeline(scope, 0, 1);
    expect(first.events.map(e => e.kind)).toEqual(["tool_start"]);
    const second = readAgentTimeline(scope, first.nextCursor, 1);
    expect(second.events.map(e => e.kind)).toEqual(["tool_end"]);
    expect(second.nextCursor).toBe(2);
    expect(readAgentTimeline(scope, 2).events).toHaveLength(0);
  });

  it("does not dedupe status transitions that actually changed", () => {
    const change = (status: string) => recordAgentTimeline(scope,
      { kind: "subagent_status", actor: "agent-1", status });
    expect(change("running")).toBe(true);
    expect(change("running")).toBe(true);
    expect(change("completed")).toBe(true);
    expect(change("running")).toBe(true);
    expect(readAgentTimeline(scope, 0).events.map(e => e.status)).toEqual([
      "running", "completed", "running",
    ]);
  });

  it("keeps two sessions in one workspace and two workspaces of one session disjoint", () => {
    const other = { ...scope, sessionId: "session_002" };
    const otherWorkspace = { ...scope, workspace: "D:/Example/private/other" };
    recordAgentTimeline(scope, { kind: "tool_start", actor: "main", tool: "first" });
    recordAgentTimeline(other, { kind: "tool_start", actor: "main", tool: "second" });
    recordAgentTimeline(otherWorkspace, { kind: "tool_start", actor: "main", tool: "third" });
    expect(readAgentTimeline(scope, 0).events[0].tool).toBe("first");
    expect(readAgentTimeline(other, 0).events[0].tool).toBe("second");
    expect(readAgentTimeline(otherWorkspace, 0).events[0].tool).toBe("third");
  });

  it("retains bounded snapshots and detects a replay gap without inventing missing events", () => {
    for (let i=0;i<AGENT_TIMELINE_MAX+3;i++) {
      expect(recordAgentTimeline(scope, { kind: "tool_start", actor: "main", tool: "search" })).toBe(true);
    }
    const replay = readAgentTimeline(scope, 1);
    expect(replay.gap).toBe(true);
    expect(replay.events[0].seq).toBe(4);
    expect(readAgentTimeline(scope, AGENT_TIMELINE_MAX+3).events).toHaveLength(0);
  });

  it("fails closed for corrupt journal files, symlinks and a competing lock", () => {
    const info = recordAgentTimeline(scope, { kind: "tool_start", actor: "main", tool: "ok" });
    expect(info).toBe(true);
    const file = path.join(root, readdirSync(root).find(x => x.endsWith(".json"))!);
    writeFileSync(file, "truncated");
    expect(() => readAgentTimeline(scope, 0)).toThrow();
    expect(recordAgentTimeline(scope, { kind: "tool_start", actor: "main" })).toBe(false);
    mkdirSync(root + "-unused");
    rmSync(root + "-unused", { recursive: true });
    writeFileSync(file + ".lock", "busy");
    expect(recordAgentTimeline(scope, { kind: "tool_start", actor: "main" })).toBe(false);
  });
});
type Result = { status: number; body: any };
async function call({ method = "GET", ws = scope.workspace, session = scope.sessionId,
  authenticated = true, mode = "tline", cursor = "0" }: {
  method?: string; ws?: string; session?: string; authenticated?: boolean;
  mode?: string; cursor?: string;
} = {}): Promise<Result> {
  const url = new URL("http://localhost/api/tline/agent-timeline?workspace=" +
    encodeURIComponent(ws) + "&sessionId=" + encodeURIComponent(session) + "&cursor=" + cursor);
  const req = { method, headers: { "x-client-mode": mode, "x-workspace-path": ws } } as unknown as http.IncomingMessage;
  const result = { status: 0, body: null } as Result;
  const res = { setHeader: () => {} } as unknown as http.ServerResponse;
  await handleTlineAgentTimelineRoute(req, res, url.pathname, url, {
    resolveSession: (_req, id, workspace) => authenticated && id === scope.sessionId &&
      workspace?.toLowerCase() === scope.workspace.toLowerCase()
      ? { clientMode: "tline", sessionId: scope.sessionId, workspace: scope.workspace } : null,
    sendJSON: (_res, status, body) => { result.status = status; result.body = body; },
  });
  return result;
}
describe("session-bound Core HTTP event journal", () => {
  it("serves metadata read-only to an active authorized T-Line session", async () => {
    recordAgentTimeline(scope, { kind: "tool_start", actor: "main", tool: "read_files" });
    const response = await call();
    expect(response.status).toBe(200);
    expect(response.body.sessionId).toBe(scope.sessionId);
    expect(response.body.events[0].tool).toBe("read_files");
  });
  it("refuses other session, workspace, mode, invalid cursor and non-GET", async () => {
    expect((await call({ session: "session_002" })).status).toBe(403);
    expect((await call({ ws: "D:/Other" })).status).toBe(403);
    expect((await call({ authenticated: false })).status).toBe(403);
    expect((await call({ mode: "chrome-extension" })).status).toBe(400);
    expect((await call({ cursor: "oops" })).status).toBe(400);
    expect((await call({ method: "POST" })).status).toBe(405);
  });
});

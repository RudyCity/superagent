import { afterEach, describe, expect, it, vi } from "vitest";
import http from "http";
import { URL } from "url";
import { superagentInstances, subagentInstances } from "../src/core/tools/state.js";
import { handleServerRoute } from "../src/serverRoutes.js";

function makeResponse() {
  return { status: 0, data: undefined as any };
}

function makeContext(overrides: Record<string, any> = {}) {
  const response = makeResponse();
  const events: any[] = [];
  const sessionAgent = { abort: vi.fn(), workingDirectory: "D:\\project-a" };
  const otherAgent = { abort: vi.fn(), workingDirectory: "D:\\project-b" };
  const session = { sessionId: "session-a", workspace: "D:\\project-a", agent: sessionAgent };
  const activeSessions = new Map([["session-a", session], ["session-b", {
    sessionId: "session-b", workspace: "D:\\project-b", agent: otherAgent
  }]]);
  superagentInstances.clear();
  subagentInstances.clear();
  superagentInstances.set("sa-a", { status: "running", agent: sessionAgent });
  superagentInstances.set("sa-b", { status: "running", agent: otherAgent });
  const superagents = superagentInstances;
  const subagents = subagentInstances;
  const pendingPermissions = new Map([["permission-b", vi.fn()]]);
  const pendingQuestions = new Map([["question-b", vi.fn()]]);
  const ctx: any = {
    activeSessions,
    lastActiveWorkspace: "D:\\project-a",
    setLastActiveWorkspace: vi.fn(),
    isBrowseDialogOpen: false,
    setIsBrowseDialogOpen: vi.fn(),
    serverDefaultClientMode: "test",
    sseClients: new Set(),
    browserInstances: new Map(),
    pendingPermissions,
    pendingQuestions,
    pendingBrowserControls: new Map(),
    resolveSession: vi.fn((req: any) => req.headers?.["x-workspace-path"] === "D:\\project-a" ? session : null),
    resolveWorkspacePath: vi.fn(() => "D:\\project-a"),
    resolveClientMode: vi.fn(),
    createAgentForMode: vi.fn(),
    broadcastEvent: (event: any) => events.push(event),
    sendJSON: (_res: any, status: number, data: any) => {
      response.status = status;
      response.data = data;
    },
    readBody: vi.fn(async () => ""),
    executeBrowserControlOnClient: vi.fn(),
    killVisionServerProcess: vi.fn(),
    ...overrides
  };
  return { ctx, response, events, sessionAgent, otherAgent, superagents, subagents, pendingPermissions, pendingQuestions, session };
}

function makeReq(workspace?: string) {
  return { method: "POST", headers: workspace ? { "x-workspace-path": workspace } : {}, url: "/api/abort" } as unknown as http.IncomingMessage;
}

describe("POST /api/abort session isolation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    superagentInstances.clear();
    subagentInstances.clear();
  });

  it("rejects an abort without a matching session unless all=true is explicit", async () => {
    const { ctx, response } = makeContext();
    await handleServerRoute(makeReq(), {} as any, "/api/abort", new URL("http://localhost/api/abort"), ctx);
    expect(response.status).toBe(400);
    expect(ctx.activeSessions.get("session-a").agent.abort).not.toHaveBeenCalled();
    expect(ctx.activeSessions.get("session-b").agent.abort).not.toHaveBeenCalled();
  });

  it("aborts only the matching session and preserves other sessions' pending prompts", async () => {
    const { ctx, response, sessionAgent, otherAgent, superagents, pendingPermissions, pendingQuestions } = makeContext();
    ctx.resolveSession = vi.fn(() => ctx.activeSessions.get("session-a"));
    await handleServerRoute(makeReq("D:\\project-a"), {} as any, "/api/abort", new URL("http://localhost/api/abort"), ctx);

    expect(response.status).toBe(200);
    expect(sessionAgent.abort).toHaveBeenCalledOnce();
    expect(otherAgent.abort).not.toHaveBeenCalled();
    expect(superagents.get("sa-a").status).toBe("terminated");
    expect(superagents.get("sa-b").status).toBe("running");
    expect(pendingPermissions.has("permission-b")).toBe(true);
    expect(pendingQuestions.has("question-b")).toBe(true);
    expect(response.data.scope).toBe("session");
  });
});

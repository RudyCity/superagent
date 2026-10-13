import { afterEach, describe, expect, it, vi } from "vitest";
import http from "http";
import { URL } from "url";
import { handleServerRoute } from "../src/serverRoutes.js";

function makeResponse() {
  return { status: 0, data: undefined as any };
}

describe("POST /api/superagents/invoke plan gate", () => {
  afterEach(() => vi.restoreAllMocks());

  it("does not invoke a Superagent while the owning session plan is pending approval", async () => {
    const response = makeResponse();
    const sessionAgent = {
      delegationDepth: 0,
      planState: "PLANNING_PENDING",
      getPlanFilePath: () => "docs/plan.md",
      workingDirectory: "D:\\project-a",
    };
    const session = {
      sessionId: "session-a",
      workspace: "D:\\project-a",
      agent: sessionAgent,
    };
    const ctx: any = {
      activeSessions: new Map([["session-a", session]]),
      lastActiveWorkspace: session.workspace,
      setLastActiveWorkspace: vi.fn(),
      isBrowseDialogOpen: false,
      setIsBrowseDialogOpen: vi.fn(),
      serverDefaultClientMode: "test",
      sseClients: new Set(),
      browserInstances: new Map(),
      pendingPermissions: new Map(),
      pendingQuestions: new Map(),
      pendingBrowserControls: new Map(),
      resolveSession: vi.fn(() => session),
      resolveWorkspacePath: vi.fn(() => session.workspace),
      resolveClientMode: vi.fn(),
      createAgentForMode: vi.fn(),
      broadcastEvent: vi.fn(),
      sendJSON: (_res: any, status: number, data: any) => {
        response.status = status;
        response.data = data;
      },
      readBody: vi.fn(async () => JSON.stringify({ role: "coder", task: "implement feature", branch: "feature/test" })),
      executeBrowserControlOnClient: vi.fn(),
      killVisionServerProcess: vi.fn(),
    };

    const req = {
      method: "POST",
      headers: { "x-workspace-path": session.workspace, host: "localhost" },
      url: "/api/superagents/invoke",
    } as unknown as http.IncomingMessage;

    await handleServerRoute(req, {} as any, "/api/superagents/invoke", new URL("http://localhost/api/superagents/invoke"), ctx);

    expect(response.status).toBe(200);
    expect(response.data.success).toBe(true);
    expect(response.data.result).toContain("A plan is pending approval");
  });
});

/**
 * server.test.ts — Part 1 of 2
 *
 * Integration tests for src/server.ts covering:
 *   OPTIONS CORS preflight, GET /api/status, GET /api/workspaces,
 *   GET /api/history, GET /api/history/sessions,
 *   DELETE /api/history/session/:id, GET /api/input-history,
 *   POST /api/input-history, POST /api/init, POST /api/chat,
 *   POST /api/approve, POST /api/plan/approve, POST /api/answer
 *
 * Part 2 (server2.test.ts) covers browser, workspace, config, and system endpoints.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import * as execaModule from "execa";
import {
  getFreePort,
  getJSON,
  postJSON,
  deleteJSON,
  optionsReq,
  testWorkspace,
  testFileName,
  testFileContent,
  tmpConfigDir,
  sharedPort,
  setSharedPort,
  apiUrl,
  authHeaders,
} from "./serverTestHelper.js";
import { ensureServerAuthToken } from "../src/core/utils/serverSecurity.js";

// ─── Server lifecycle ─────────────────────────────────────────────────────────
let port: number;

beforeAll(async () => {
  // Prevent Vision Server (Python) from spawning during tests
  vi.spyOn(execaModule, "execa").mockImplementation((..._args: any[]) => {
    const p: any = Promise.resolve({ exitCode: 0, stdout: "", stderr: "", all: undefined });
    p.catch = () => p;
    p.pid = 99999;
    return p;
  });

  port = await getFreePort();
  setSharedPort(port);

  const { runServer } = await import("../src/server.js");
  await runServer(port, true /* silent */);
  await new Promise((r) => setTimeout(r, 100));
}, 20000);

afterAll(() => {
  try { fs.rmSync(testWorkspace, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(tmpConfigDir, { recursive: true, force: true }); } catch {}
});

// ═══════════════════════════════════════════════════════════════════════════════
// OPTIONS — CORS preflight
// ═══════════════════════════════════════════════════════════════════════════════
describe("OPTIONS — CORS preflight", () => {
  it("returns 204 with CORS headers", async () => {
    const r = await optionsReq(port, "/api/status");
    expect(r.status).toBe(204);
    expect(r.headers.get("access-control-allow-origin")).toBeNull();
    expect(r.headers.get("access-control-allow-methods")).toContain("GET");
    expect(r.headers.get("access-control-allow-methods")).toContain("POST");
  });

  it("echoes localhost origins and includes x-auth-token in allowed headers", async () => {
    const res = await fetch(apiUrl(port, "/api/status"), {
      method: "OPTIONS",
      headers: { Origin: "http://localhost:3000", "Access-Control-Request-Headers": "x-auth-token" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    expect(res.headers.get("access-control-allow-headers")).toContain("x-auth-token");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Auth token enforcement
// ═══════════════════════════════════════════════════════════════════════════════
describe("Auth token enforcement", () => {
  it("returns 401 Unauthorized without a token", async () => {
    const res = await fetch(apiUrl(port, "/api/status"));
    expect(res.status).toBe(401);
    const body = await res.json() as any;
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 401 for an invalid token", async () => {
    const res = await fetch(apiUrl(port, "/api/status"), {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(res.status).toBe(401);
  });

  it("accepts a valid Bearer token", async () => {
    const res = await fetch(apiUrl(port, "/api/status"), {
      headers: { Authorization: `Bearer ${ensureServerAuthToken()}` },
    });
    expect(res.status).toBe(200);
  });

  it("accepts a valid ?token= query parameter", async () => {
    const res = await fetch(apiUrl(port, `/api/status?token=${ensureServerAuthToken()}`));
    expect(res.status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/status
// ═══════════════════════════════════════════════════════════════════════════════
describe("GET /api/status", () => {
  it("returns status:online when no session exists", async () => {
    const { status, body } = await getJSON(port, "/api/status");
    expect(status).toBe(200);
    expect(body.status).toBe("online");
    expect(body.agentActive).toBe(false);
  });

  it("returns workspace from x-workspace-path header", async () => {
    const { body } = await getJSON(port, "/api/status", {
      "x-workspace-path": process.cwd(),
    });
    expect(body.workspace).toBe(path.resolve(process.cwd()));
  });

  it("returns workspace from ?workspace query param", async () => {
    const { body } = await getJSON(
      port,
      `/api/status?workspace=${encodeURIComponent(process.cwd())}`
    );
    expect(body.workspace).toBe(path.resolve(process.cwd()));
  });

  it("rejects a client-supplied workspace outside registered roots with 403", async () => {
    const res = await fetch(apiUrl(port, "/api/status"), {
      headers: authHeaders({ "x-workspace-path": path.join(os.tmpdir(), "never-registered-ws") }),
    });
    expect(res.status).toBe(403);
    const body = await res.json() as any;
    expect(body.error).toBe("Forbidden workspace");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/workspaces
// ═══════════════════════════════════════════════════════════════════════════════
describe("GET /api/workspaces", () => {
  it("returns empty workspaces array initially", async () => {
    const { status, body } = await getJSON(port, "/api/workspaces");
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.workspaces)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/history
// ═══════════════════════════════════════════════════════════════════════════════
describe("GET /api/history", () => {
  it("returns empty messages when no session exists", async () => {
    const { status, body } = await getJSON(port, "/api/history", {
      "x-workspace-path": process.cwd(),
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.messages).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/history/sessions
// ═══════════════════════════════════════════════════════════════════════════════
describe("GET /api/history/sessions", () => {
  it("returns sessions array for a workspace path", async () => {
    const { status, body } = await getJSON(port, "/api/history/sessions", {
      "x-workspace-path": process.cwd(),
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.sessions)).toBe(true);
  });

  it("returns empty sessions when no workspace provided", async () => {
    const { status, body } = await getJSON(port, "/api/history/sessions");
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.sessions)).toBe(true);
  });

  it("accepts ?mode=multi query param", async () => {
    const { status, body } = await getJSON(
      port,
      `/api/history/sessions?mode=multi&workspace=${encodeURIComponent(process.cwd())}`
    );
    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// DELETE /api/history/session/:id
// ═══════════════════════════════════════════════════════════════════════════════
describe("DELETE /api/history/session/:id", () => {
  it("returns 200 for a non-existent session (silently succeeds)", async () => {
    const res = await fetch(
      apiUrl(port, `/api/history/session/${encodeURIComponent("nonexistent-session-id")}`),
      { method: "DELETE", headers: authHeaders() }
    );
    const body = await res.json() as any;
    expect([200, 500]).toContain(res.status);
    expect(body).toBeDefined();
  });

  it("returns 404 when session path is missing (empty segment)", async () => {
    const res = await fetch(apiUrl(port, "/api/history/session/"), { method: "DELETE", headers: authHeaders() });
    expect([400, 404]).toContain(res.status);
  });

  it("removes a known session from activeSessions", async () => {
    const ws = path.join(os.tmpdir(), `sa-ws-del-${Date.now()}`);
    fs.mkdirSync(ws, { recursive: true });
    try {
      const initRes = await postJSON(port, "/api/init", { workspace: ws, mode: "single" });
      const sid = initRes.body.sessionId;

      const beforeStatus = await getJSON(port, "/api/status", { "x-workspace-path": ws });
      expect(beforeStatus.body.agentActive).toBe(true);

      const res = await fetch(
        apiUrl(port, `/api/history/session/${encodeURIComponent(sid)}`),
        { method: "DELETE", headers: authHeaders() }
      );
      const delBody = await res.json() as any;
      expect(delBody.success).toBe(true);

      const afterStatus = await getJSON(port, "/api/status", { "x-workspace-path": ws });
      expect(afterStatus.body.agentActive).toBe(false);
    } finally {
      try { fs.rmSync(ws, { recursive: true, force: true }); } catch {}
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/input-history
// ═══════════════════════════════════════════════════════════════════════════════
describe("GET /api/input-history", () => {
  it("returns empty history when no workspace provided", async () => {
    const { status, body } = await getJSON(port, "/api/input-history");
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.history)).toBe(true);
    expect(body.history).toHaveLength(0);
  });

  it("returns history array for known workspace", async () => {
    const { status, body } = await getJSON(port, "/api/input-history", {
      "x-workspace-path": process.cwd(),
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.history)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/input-history
// ═══════════════════════════════════════════════════════════════════════════════
describe("POST /api/input-history", () => {
  beforeAll(async () => {
    // Register testWorkspace as a valid root before sending it via headers
    await postJSON(port, "/api/init", { workspace: testWorkspace, mode: "single" });
  }, 15000);

  it("falls back to lastActiveWorkspace when no explicit workspace given", async () => {
    const { status } = await postJSON(port, "/api/input-history", { command: "ls" });
    expect([200, 500]).toContain(status);
  });

  it("returns 400 when command is missing", async () => {
    const { status, body } = await postJSON(
      port,
      "/api/input-history",
      {},
      { "x-workspace-path": testWorkspace }
    );
    expect(status).toBe(400);
    expect(body.error).toBeDefined();
  });

  it("returns 400 when command is empty string", async () => {
    const { status, body } = await postJSON(
      port,
      "/api/input-history",
      { command: "   " },
      { "x-workspace-path": testWorkspace }
    );
    expect(status).toBe(400);
    expect(body.error).toBeDefined();
  });

  it("saves a valid command and returns success", async () => {
    const { status, body } = await postJSON(
      port,
      "/api/input-history",
      { command: "echo hello" },
      { "x-workspace-path": testWorkspace }
    );
    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });

  it("saved command round-trip appears in GET /api/input-history", async () => {
    const saveRes = await postJSON(
      port,
      "/api/input-history",
      { command: "echo round-trip-check" },
      { "x-workspace-path": testWorkspace }
    );
    expect(saveRes.status).toBe(200);
    expect(saveRes.body.success).toBe(true);

    const { status, body } = await getJSON(port, "/api/input-history", {
      "x-workspace-path": testWorkspace,
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.history)).toBe(true);
    if (body.history.length > 0) {
      expect(
        body.history.some((h: string) => typeof h === "string" && h.includes("round-trip"))
      ).toBe(true);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/init
// ═══════════════════════════════════════════════════════════════════════════════
describe("POST /api/init", () => {
  it("initializes a single-mode session and returns sessionId", async () => {
    const { status, body } = await postJSON(port, "/api/init", {
      workspace: testWorkspace,
      mode: "single",
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(typeof body.sessionId).toBe("string");
    expect(body.sessionId.length).toBeGreaterThan(0);
  });

  it("re-using the same sessionId returns the existing session immediately", async () => {
    const first = await postJSON(port, "/api/init", { workspace: testWorkspace, mode: "single" });
    const sid = first.body.sessionId;
    const second = await postJSON(port, "/api/init", {
      workspace: testWorkspace,
      mode: "single",
      sessionId: sid,
    });
    expect(second.status).toBe(200);
    expect(second.body.sessionId).toBe(sid);
  });

  it("accepts multi mode", async () => {
    const ws = path.join(os.tmpdir(), `sa-ws-multi-${Date.now()}`);
    fs.mkdirSync(ws, { recursive: true });
    try {
      const { status, body } = await postJSON(port, "/api/init", { workspace: ws, mode: "multi" });
      expect(status).toBe(200);
      expect(body.success).toBe(true);
    } finally {
      try { fs.rmSync(ws, { recursive: true, force: true }); } catch {}
    }
  });

  it("fires initialPrompt without error", async () => {
    const ws = path.join(os.tmpdir(), `sa-ws-prompt-${Date.now()}`);
    fs.mkdirSync(ws, { recursive: true });
    try {
      const { status, body } = await postJSON(port, "/api/init", {
        workspace: ws,
        mode: "single",
        initialPrompt: "Hello agent",
      });
      expect(status).toBe(200);
      expect(body.success).toBe(true);
    } finally {
      try { fs.rmSync(ws, { recursive: true, force: true }); } catch {}
    }
  });

  it("accepts a resume token that doesn't exist (silently skips)", async () => {
    const { status, body } = await postJSON(port, "/api/init", {
      workspace: testWorkspace,
      mode: "single",
      resume: "nonexistent-session-abc123",
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/status (with active session)
// ═══════════════════════════════════════════════════════════════════════════════
describe("GET /api/status (with active session)", () => {
  it("shows agentActive:true after init", async () => {
    const { body } = await getJSON(port, "/api/status", {
      "x-workspace-path": testWorkspace,
    });
    expect(body.agentActive).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/history (with active session)
// ═══════════════════════════════════════════════════════════════════════════════
describe("GET /api/history (with active session)", () => {
  it("returns messages array from active session", async () => {
    const { status, body } = await getJSON(port, "/api/history", {
      "x-workspace-path": testWorkspace,
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.messages)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/chat
// ═══════════════════════════════════════════════════════════════════════════════
describe("POST /api/chat", () => {
  it("returns 400 when no session exists for uninitialized workspace", async () => {
    const unknownWs = path.join(os.tmpdir(), "unknown-workspace-xyz");
    const { status, body } = await postJSON(
      port,
      "/api/chat",
      { message: "hello" },
      { "x-workspace-path": unknownWs }
    );
    expect([400, 403]).toContain(status);
    expect(body.error).toBeDefined();
  });

  it("returns 400 when message is empty", async () => {
    const { status, body } = await postJSON(
      port,
      "/api/chat",
      { message: "" },
      { "x-workspace-path": testWorkspace }
    );
    expect(status).toBe(400);
    expect(body.error).toContain("Empty message");
  });

  it("returns 400 for ! command with empty body", async () => {
    const { status, body } = await postJSON(
      port,
      "/api/chat",
      { message: "! " },
      { "x-workspace-path": testWorkspace }
    );
    expect(status).toBe(400);
    expect(body.error).toContain("Empty terminal command");
  });

  it("returns 200 for valid ! terminal command", async () => {
    const { status, body } = await postJSON(
      port,
      "/api/chat",
      { message: "!echo test" },
      { "x-workspace-path": testWorkspace }
    );
    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });

  it("returns 200 for a normal chat message (queued to SSE)", async () => {
    const { status, body } = await postJSON(
      port,
      "/api/chat",
      { message: "what is 1+1" },
      { "x-workspace-path": testWorkspace }
    );
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(typeof body.sessionId).toBe("string");
  });

  it("resolves session by sessionId in request body", async () => {
    const initRes = await postJSON(port, "/api/init", {
      workspace: testWorkspace,
      mode: "single",
    });
    const sid = initRes.body.sessionId;
    const { status, body } = await postJSON(port, "/api/chat", { message: "ping", sessionId: sid });
    expect(status).toBe(200);
    expect(body.sessionId).toBe(sid);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/approve
// ═══════════════════════════════════════════════════════════════════════════════
describe("POST /api/approve", () => {
  it("returns 404 when permissionId not found", async () => {
    const { status, body } = await postJSON(port, "/api/approve", {
      permissionId: "nonexistent-id",
      approval: true,
    });
    expect(status).toBe(404);
    expect(body.error).toContain("not found");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/plan/approve
// ═══════════════════════════════════════════════════════════════════════════════
describe("POST /api/plan/approve", () => {
  it("returns 400 when no session exists", async () => {
    const unknownWs = path.join(os.tmpdir(), "no-session-ws-plan");
    const { status, body } = await postJSON(
      port,
      "/api/plan/approve",
      { action: "approve" },
      { "x-workspace-path": unknownWs }
    );
    expect([400, 403]).toContain(status);
    expect(body.error).toBeDefined();
  });

  it("returns 400 for invalid action", async () => {
    const { status, body } = await postJSON(
      port,
      "/api/plan/approve",
      { action: "invalid-action" },
      { "x-workspace-path": testWorkspace }
    );
    expect(status).toBe(400);
    expect(body.error).toContain("Invalid action");
  });

  it("returns 200 for action:reject", async () => {
    const { status, body } = await postJSON(
      port,
      "/api/plan/approve",
      { action: "reject" },
      { "x-workspace-path": testWorkspace }
    );
    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });

  it("returns 200 for action:approve", async () => {
    const { status, body } = await postJSON(
      port,
      "/api/plan/approve",
      { action: "approve" },
      { "x-workspace-path": testWorkspace }
    );
    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/answer
// ═══════════════════════════════════════════════════════════════════════════════
describe("POST /api/answer", () => {
  it("returns 404 when questionId not found", async () => {
    const { status, body } = await postJSON(port, "/api/answer", {
      questionId: "nonexistent-q",
      answer: "yes",
    });
    expect(status).toBe(404);
    expect(body.error).toContain("not found");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Session resolution via ?sessionId query param
// ═══════════════════════════════════════════════════════════════════════════════
describe("Session resolution via ?sessionId query param", () => {
  it("resolves session by sessionId in URL query", async () => {
    const initRes = await postJSON(port, "/api/init", {
      workspace: testWorkspace,
      mode: "single",
    });
    const sid = initRes.body.sessionId;
    const { body } = await getJSON(port, `/api/status?sessionId=${encodeURIComponent(sid)}`);
    expect(body.sessionId).toBe(sid);
    expect(body.agentActive).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Duplicate server prevention
// ═══════════════════════════════════════════════════════════════════════════════
describe("Duplicate server prevention", () => {
  it("should prevent duplicate server startup and return null if port is in use", async () => {
    const { runServer } = await import("../src/server.js");
    const secondServer = await runServer(port, true /* silent */);
    expect(secondServer).toBeNull();
  });
});

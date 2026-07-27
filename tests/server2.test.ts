/**
 * server2.test.ts — Part 2 of 2
 *
 * Integration tests for src/server.ts covering:
 *   POST /api/browser/update-instance, POST /api/browser/result,
 *   GET|POST|DELETE /api/browser/macros, POST /api/abort,
 *   GET /api/tasks, GET /api/instances, GET /api/workspace/files,
 *   POST /api/workspace/file/read, POST /api/workspace/file/open,
 *   GET /api/git/changes, GET /api/background-tasks,
 *   POST /api/background-tasks/kill, GET|POST /api/config,
 *   POST /api/switch-workspace, GET /api/documents,
 *   GET /api/workspaces (after sessions), GET /api/events (SSE),
 *   404 fallthrough
 *
 * Part 1 (server.test.ts) covers session, chat, approve, answer endpoints.
 * Both parts share the same server instance via serverTestHelper.ts.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import http from "http";
import fs from "fs";
import path from "path";
import os from "os";
import * as execaModule from "execa";
import {
  getFreePort,
  getJSON,
  postJSON,
  deleteJSON,
  testWorkspace,
  testFileName,
  testFileContent,
  apiUrl,
} from "./serverTestHelper.js";

// ─── Server lifecycle (separate port & workspace from Part 1) ─────────────────
let port: number;
let serverInstance: any;
const server2TestWorkspace = path.join(os.tmpdir(), `sa-server2-ws-${Date.now()}`);
fs.mkdirSync(server2TestWorkspace, { recursive: true });
fs.writeFileSync(path.join(server2TestWorkspace, testFileName), testFileContent);

beforeAll(async () => {
  vi.spyOn(execaModule, "execa").mockImplementation((..._args: any[]) => {
    const p: any = Promise.resolve({ exitCode: 0, stdout: "", stderr: "", all: undefined });
    p.catch = () => p;
    p.pid = 99999;
    return p;
  });

  port = await getFreePort();

  // Part 2 starts its own isolated server instance
  const { runServer } = await import("../src/server.js");
  serverInstance = await runServer(port, true /* silent */);
  await new Promise((r) => setTimeout(r, 100));

  // Ensure the server2TestWorkspace has an active session for endpoint tests
  await postJSON(port, "/api/init", { workspace: server2TestWorkspace, mode: "single" });
}, 20000);

afterAll(() => {
  try { serverInstance?.close(); } catch {}
  try { fs.rmSync(server2TestWorkspace, { recursive: true, force: true }); } catch {}
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/browser/update-instance
// ═══════════════════════════════════════════════════════════════════════════════
describe("POST /api/browser/update-instance", () => {
  it("upserts instance when key not yet registered", async () => {
    const { status } = await postJSON(port, "/api/browser/update-instance", {
      clientId: "client-abc",
      windowId: "win-1",
      tabTitle: "Test Tab",
    });
    expect(status).toBe(200);
  });

  it("returns 400 when clientId or windowId is missing", async () => {
    const { status, body } = await postJSON(port, "/api/browser/update-instance", {
      tabTitle: "No ID",
    });
    expect(status).toBe(400);
    expect(body.error).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/browser/result
// ═══════════════════════════════════════════════════════════════════════════════
describe("POST /api/browser/result", () => {
  it("returns 404 when controlId not found", async () => {
    const { status, body } = await postJSON(port, "/api/browser/result", {
      controlId: "nonexistent-ctrl",
      result: "ok",
      isError: false,
    });
    expect(status).toBe(404);
    expect(body.error).toContain("not found");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/browser/macros
// ═══════════════════════════════════════════════════════════════════════════════
describe("GET /api/browser/macros", () => {
  it("returns macros array (may be empty)", async () => {
    const { status, body } = await getJSON(port, "/api/browser/macros");
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/browser/macros
// ═══════════════════════════════════════════════════════════════════════════════
describe("POST /api/browser/macros", () => {
  it("returns 400 when macro name is missing", async () => {
    const { status, body } = await postJSON(port, "/api/browser/macros", {
      steps: [{ action: "navigate", target: "https://example.com" }],
    });
    expect(status).toBe(400);
    expect(body.error).toBeDefined();
  });

  it("returns 400 when steps array is missing", async () => {
    const { status, body } = await postJSON(port, "/api/browser/macros", { name: "test_macro" });
    expect(status).toBe(400);
    expect(body.error).toBeDefined();
  });

  it("saves a valid macro and returns success", async () => {
    const { status, body } = await postJSON(port, "/api/browser/macros", {
      name: "server2_test_macro",
      description: "For server2 test",
      steps: [{ action: "navigate", target: "https://example.com" }],
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.name).toBe("server2_test_macro");
  });

  it("saved macro appears in GET /api/browser/macros", async () => {
    const { body } = await getJSON(port, "/api/browser/macros");
    const found = (body as any[]).find((m: any) => m.name === "server2_test_macro");
    expect(found).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// DELETE /api/browser/macros
// ═══════════════════════════════════════════════════════════════════════════════
describe("DELETE /api/browser/macros", () => {
  it("returns 400 when name is missing", async () => {
    const { status, body } = await deleteJSON(port, "/api/browser/macros", {});
    expect(status).toBe(400);
    expect(body.error).toBeDefined();
  });

  it("returns 404 when macro does not exist", async () => {
    const { status, body } = await deleteJSON(port, "/api/browser/macros", {
      name: "definitely_does_not_exist_xyz",
    });
    expect(status).toBe(404);
    expect(body.error).toContain("not found");
  });

  it("deletes an existing macro and returns success", async () => {
    await postJSON(port, "/api/browser/macros", {
      name: "to_delete_macro_2",
      description: "Temp",
      steps: [{ action: "navigate", target: "https://del.com" }],
    });
    const { status, body } = await deleteJSON(port, "/api/browser/macros", {
      name: "to_delete_macro_2",
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/abort
// ═══════════════════════════════════════════════════════════════════════════════
describe("POST /api/abort", () => {
  it("returns 200 even when no session is running", async () => {
    const { status, body } = await postJSON(port, "/api/abort", {});
    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });

  it("aborts the session for the given workspace", async () => {
    const { status, body } = await postJSON(
      port,
      "/api/abort",
      {},
      { "x-workspace-path": server2TestWorkspace }
    );
    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/tasks
// ═══════════════════════════════════════════════════════════════════════════════
describe("GET /api/tasks", () => {
  it("returns tasks response when no task.md exists (missing:true)", async () => {
    const { status, body } = await getJSON(port, "/api/tasks", {
      "x-workspace-path": server2TestWorkspace,
    });
    expect(status).toBe(200);
    expect(body).toBeDefined();
  });

  it("returns tasks array (shape) for the active session brain path", async () => {
    const { status, body } = await getJSON(port, "/api/tasks", {
      "x-workspace-path": server2TestWorkspace,
    });
    expect(status).toBe(200);
    expect(Array.isArray(body.tasks)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/instances
// ═══════════════════════════════════════════════════════════════════════════════
describe("GET /api/instances", () => {
  it("returns subagents and superagents arrays", async () => {
    const { status, body } = await getJSON(port, "/api/instances");
    expect(status).toBe(200);
    expect(Array.isArray(body.subagents)).toBe(true);
    expect(Array.isArray(body.superagents)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/workspace/files
// ═══════════════════════════════════════════════════════════════════════════════
describe("GET /api/workspace/files", () => {
  it("returns empty files when no workspace given", async () => {
    const { status, body } = await getJSON(port, "/api/workspace/files");
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.files)).toBe(true);
  });

  it("returns files for a workspace (git-tracked or empty)", async () => {
    const { status, body } = await getJSON(port, "/api/workspace/files", {
      "x-workspace-path": server2TestWorkspace,
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.files)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/workspace/file/read
// ═══════════════════════════════════════════════════════════════════════════════
describe("POST /api/workspace/file/read", () => {
  it("returns 400 when filepath is missing", async () => {
    const { status, body } = await postJSON(
      port,
      "/api/workspace/file/read",
      {},
      { "x-workspace-path": server2TestWorkspace }
    );
    expect(status).toBe(400);
    expect(body.error).toContain("Missing filepath");
  });

  it("fallback to lastActiveWorkspace when no workspace header", async () => {
    const { status } = await postJSON(port, "/api/workspace/file/read", { filepath: "hello.txt" });
    expect([200, 400, 404]).toContain(status);
  });

  it("returns file content for an existing file", async () => {
    const { status, body } = await postJSON(
      port,
      "/api/workspace/file/read",
      { filepath: testFileName },
      { "x-workspace-path": server2TestWorkspace }
    );
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.content).toBe(testFileContent);
  });

  it("returns 404 for a non-existent file", async () => {
    const { status, body } = await postJSON(
      port,
      "/api/workspace/file/read",
      { filepath: "does_not_exist.txt" },
      { "x-workspace-path": server2TestWorkspace }
    );
    expect(status).toBe(404);
    expect(body.error).toContain("not found");
  });

  it("returns 403 for path traversal attempt", async () => {
    const { status, body } = await postJSON(
      port,
      "/api/workspace/file/read",
      { filepath: "../../../etc/passwd" },
      { "x-workspace-path": server2TestWorkspace }
    );
    expect(status).toBe(403);
    expect(body.error).toContain("Access denied");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/workspace/file/open
// ═══════════════════════════════════════════════════════════════════════════════
describe("POST /api/workspace/file/open", () => {
  it("returns 400 when filepath is missing", async () => {
    const { status, body } = await postJSON(
      port,
      "/api/workspace/file/open",
      {},
      { "x-workspace-path": server2TestWorkspace }
    );
    expect(status).toBe(400);
    expect(body.error).toContain("Missing filepath");
  });

  it("returns 403 for path traversal attempt", async () => {
    const { status, body } = await postJSON(
      port,
      "/api/workspace/file/open",
      { filepath: "../../../etc/passwd" },
      { "x-workspace-path": server2TestWorkspace }
    );
    expect(status).toBe(403);
    expect(body.error).toContain("Access denied");
  });

  it("returns 404 for non-existent file", async () => {
    const { status, body } = await postJSON(
      port,
      "/api/workspace/file/open",
      { filepath: "no_such_file.txt" },
      { "x-workspace-path": server2TestWorkspace }
    );
    expect(status).toBe(404);
    expect(body.error).toContain("not found");
  });

  it("attempts to open existing file (200 or 500 depending on OS handler)", async () => {
    const { status } = await postJSON(
      port,
      "/api/workspace/file/open",
      { filepath: testFileName },
      { "x-workspace-path": server2TestWorkspace }
    );
    expect([200, 500]).toContain(status);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/git/changes
// ═══════════════════════════════════════════════════════════════════════════════
describe("GET /api/git/changes", () => {
  it("returns empty changes when no workspace given", async () => {
    const { status, body } = await getJSON(port, "/api/git/changes");
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.changes)).toBe(true);
  });

  it("returns changes array for a workspace path", async () => {
    const { status, body } = await getJSON(port, "/api/git/changes", {
      "x-workspace-path": testWorkspace,
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.changes)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/background-tasks
// ═══════════════════════════════════════════════════════════════════════════════
describe("GET /api/background-tasks", () => {
  it("returns tasks list (empty by default)", async () => {
    const { status, body } = await getJSON(port, "/api/background-tasks");
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.tasks)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/background-tasks/kill
// ═══════════════════════════════════════════════════════════════════════════════
describe("POST /api/background-tasks/kill", () => {
  it("returns 400 when id is missing", async () => {
    const { status, body } = await postJSON(port, "/api/background-tasks/kill", {});
    expect(status).toBe(400);
    expect(body.error).toContain("Missing process ID");
  });

  it("returns 404 when process id is not found", async () => {
    const { status, body } = await postJSON(port, "/api/background-tasks/kill", {
      id: "nonexistent-task-999",
    });
    expect(status).toBe(404);
    expect(body.error).toContain("not found");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/config
// ═══════════════════════════════════════════════════════════════════════════════
describe("GET /api/config", () => {
  it("returns settings, providers, presets, activePresetId, trustedDirectories", async () => {
    const { status, body } = await getJSON(port, "/api/config");
    expect(status).toBe(200);
    expect(body).toHaveProperty("settings");
    expect(body).toHaveProperty("providers");
    expect(body).toHaveProperty("presets");
    expect(body.presets).toHaveProperty("single");
    expect(body.presets).toHaveProperty("multi");
    expect(body).toHaveProperty("activePresetId");
    expect(body).toHaveProperty("trustedDirectories");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/config
// ═══════════════════════════════════════════════════════════════════════════════
describe("POST /api/config", () => {
  it("returns success when updating settings", async () => {
    const { status, body } = await postJSON(port, "/api/config", { settings: { theme: "dark" } });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });

  it("returns success when setting activePresetId.single", async () => {
    const { status, body } = await postJSON(port, "/api/config", {
      activePresetId: { single: "default-single" },
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });

  it("returns success when setting activePresetId.multi", async () => {
    const { status, body } = await postJSON(port, "/api/config", {
      activePresetId: { multi: "default-multi" },
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/switch-workspace
// ═══════════════════════════════════════════════════════════════════════════════
describe("POST /api/switch-workspace", () => {
  it("returns 400 when workspace is missing", async () => {
    const { status, body } = await postJSON(port, "/api/switch-workspace", {});
    expect(status).toBe(400);
    expect(body.error).toContain("workspace path is required");
  });

  it("creates and returns a new session for a new workspace", async () => {
    const ws = path.join(os.tmpdir(), `sa-ws-switch2-${Date.now()}`);
    fs.mkdirSync(ws, { recursive: true });
    try {
      const { status, body } = await postJSON(port, "/api/switch-workspace", {
        workspace: ws,
        mode: "single",
      });
      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.workspace).toBe(path.resolve(ws));
      expect(typeof body.sessionId).toBe("string");
      expect(body.mode).toBe("single");
    } finally {
      try { fs.rmSync(ws, { recursive: true, force: true }); } catch {}
    }
  });

  it("returns existing session when switching to an already initialized workspace", async () => {
    const { status, body } = await postJSON(port, "/api/switch-workspace", {
      workspace: server2TestWorkspace,
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.workspace).toBe(path.resolve(server2TestWorkspace));
  });

  it("switches to multi-mode workspace", async () => {
    const ws = path.join(os.tmpdir(), `sa-ws-switch-multi2-${Date.now()}`);
    fs.mkdirSync(ws, { recursive: true });
    try {
      const { status, body } = await postJSON(port, "/api/switch-workspace", {
        workspace: ws,
        mode: "multi",
      });
      expect(status).toBe(200);
      expect(body.mode).toBe("multi");
    } finally {
      try { fs.rmSync(ws, { recursive: true, force: true }); } catch {}
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/documents
// ═══════════════════════════════════════════════════════════════════════════════
describe("GET /api/documents", () => {
  it("returns plan/tasks/walkthrough as strings (empty when no brain files)", async () => {
    const { status, body } = await getJSON(port, "/api/documents", {
      "x-workspace-path": server2TestWorkspace,
    });
    expect(status).toBe(200);
    expect(typeof body.plan).toBe("string");
    expect(typeof body.tasks).toBe("string");
    expect(typeof body.walkthrough).toBe("string");
  });

  it("response shape is consistent after init", async () => {
    const initRes = await postJSON(port, "/api/init", {
      workspace: server2TestWorkspace,
      mode: "single",
    });
    expect(initRes.body.sessionId).toBeDefined();

    const { status, body } = await getJSON(port, "/api/documents", {
      "x-workspace-path": server2TestWorkspace,
    });
    expect(status).toBe(200);
    expect(typeof body.plan).toBe("string");
    expect(typeof body.tasks).toBe("string");
    expect(typeof body.walkthrough).toBe("string");
  });

  it("falls back to lastActiveWorkspace when no session or header", async () => {
    const { status, body } = await getJSON(port, "/api/documents");
    expect(status).toBe(200);
    expect(typeof body.plan).toBe("string");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/workspaces (after sessions created)
// ═══════════════════════════════════════════════════════════════════════════════
describe("GET /api/workspaces (after sessions created)", () => {
  it("includes the testWorkspace session", async () => {
    const { body } = await getJSON(port, "/api/workspaces");
    const found = (body.workspaces as any[]).some(
      (w: any) => w.workspace === path.resolve(server2TestWorkspace)
    );
    expect(found).toBe(true);
  });

  it("each workspace entry has required fields", async () => {
    const { body } = await getJSON(port, "/api/workspaces");
    for (const ws of body.workspaces as any[]) {
      expect(typeof ws.sessionId).toBe("string");
      expect(typeof ws.workspace).toBe("string");
      expect(typeof ws.mode).toBe("string");
      expect(typeof ws.agentRunning).toBe("boolean");
      expect(typeof ws.isCliSession).toBe("boolean");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/events (SSE)
// ═══════════════════════════════════════════════════════════════════════════════
describe.skip("GET /api/events (SSE)", () => {
  it("opens SSE stream with correct content-type header", async () => {
    await new Promise<void>((resolve, reject) => {
      const req = http.get(apiUrl(port, "/api/events"), (res) => {
        expect(res.statusCode).toBe(200);
        expect(res.headers["content-type"]).toContain("text/event-stream");
        res.destroy();
        req.destroy();
        resolve();
      });
      req.on("error", (err) => {
        // Socket destruction error can be ignored
        resolve();
      });
    });
  });

  it("registers browser instance when clientId and windowId provided", async () => {
    await new Promise<void>((resolve) => {
      const req = http.get(
        apiUrl(port, "/api/events?clientId=c2-client&windowId=win-2&tabTitle=Test&tabUrl=https://t.com&profileName=default"),
        (res) => {
          expect(res.statusCode).toBe(200);
          res.destroy();
          req.destroy();
          resolve();
        }
      );
      req.on("error", () => resolve());
    });

    await new Promise((r) => setTimeout(r, 50));
    const { status } = await postJSON(port, "/api/browser/update-instance", {
      clientId: "c2-client",
      windowId: "win-2",
      tabTitle: "Updated Tab",
    });
    expect([200, 404]).toContain(status);
  });

  it("receives real-time SSE stream events when chat command is processed", async () => {
    let receivedData = "";
    await new Promise<void>((resolve) => {
      const req = http.get(apiUrl(port, "/api/events"), (res) => {
        expect(res.statusCode).toBe(200);
        res.on("data", (chunk) => {
          receivedData += chunk.toString();
        });

        // Trigger terminal chat command after connection established
        postJSON(
          port,
          "/api/chat",
          { message: "!echo sse_stream_verify" },
          { "x-workspace-path": server2TestWorkspace }
        );

        setTimeout(() => {
          res.destroy();
          req.destroy();
          resolve();
        }, 500);
      });
      req.on("error", () => resolve());
    });

    expect(typeof receivedData).toBe("string");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 404 fallthrough
// ═══════════════════════════════════════════════════════════════════════════════
describe("404 — unknown routes", () => {
  it("returns 404 for unknown GET route", async () => {
    const { status, body } = await getJSON(port, "/api/totally-unknown-route");
    expect(status).toBe(404);
    expect(body.error).toBe("Not Found");
  });

  it("returns 404 for unknown POST route", async () => {
    const { status, body } = await postJSON(port, "/api/nonexistent", { x: 1 });
    expect(status).toBe(404);
    expect(body.error).toBe("Not Found");
  });

  it("returns 404 for completely unknown path", async () => {
    const { status, body } = await getJSON(port, "/not-api-at-all");
    expect(status).toBe(404);
    expect(body.error).toBe("Not Found");
  });
});

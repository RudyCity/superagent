import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MCP_TOOL_CLASSIFICATION,
  getDefaultSafeTools,
  generateMcpBearerToken,
  createMcpAuditLogger,
  startMcpHttpServer,
  MCP_HTTP_PATH,
  type McpHttpServerHandle,
} from "../src/core/mcp/mcpHttpTransport.js";

import { registerProject, removeProject } from "../src/core/project/projectRegistry.js";

describe("mcpHttpTransport", () => {
  it("generates 64-char hex bearer tokens", () => {
    const a = generateMcpBearerToken();
    const b = generateMcpBearerToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });

  it("classifies exec_command as dangerous and read_file as safe", () => {
    expect(MCP_TOOL_CLASSIFICATION["superagent_exec_command"]).toBe("dangerous");
    expect(MCP_TOOL_CLASSIFICATION["superagent_write_file"]).toBe("dangerous");
    expect(MCP_TOOL_CLASSIFICATION["superagent_read_file"]).toBe("safe");
    expect(MCP_TOOL_CLASSIFICATION["superagent_list_active"]).toBe("safe");
  });

  it("default safe tools contain batch reads and exclude disabled single-file endpoints and dangerous tools", () => {
    const safe = getDefaultSafeTools();
    expect(safe).toContain("superagent_read_files");
    expect(safe).not.toContain("superagent_read_file");
    expect(safe).not.toContain("superagent_exec_command");
    expect(safe).not.toContain("superagent_write_file");
    expect(safe).not.toContain("superagent_write_files");
    expect(safe).toContain("superagent_list_projects");
    expect(safe).toContain("superagent_get_project");
    expect(safe).toContain("superagent_list_workspace_chains");
    expect(safe).not.toContain("superagent_register_project");
    expect(safe).not.toContain("superagent_manage_workspace_chain");
    expect(safe).not.toContain("superagent_cross_workspace_exec");
    expect(safe.length).toBeGreaterThan(10);
  });

  it("audit logger appends JSONL entries and never throws", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-audit-"));
    const logPath = path.join(dir, "audit.log");
    const log = createMcpAuditLogger(logPath);
    expect(() => log({ tool: "t", args: { a: 1 }, ok: true })).not.toThrow();
    const lines = fs.readFileSync(logPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]);
    expect(entry.tool).toBe("t");
    expect(entry.ok).toBe(true);
    expect(entry.ts).toBeDefined();
  });

  describe("HTTP auth + allowlist (integration)", () => {
    let handle: McpHttpServerHandle;
    let token: string;
    let auditPath: string;

    beforeAll(async () => {
      token = generateMcpBearerToken();
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-http-"));
      auditPath = path.join(dir, "audit.log");
      handle = await startMcpHttpServer({ port: 0, bearerToken: token, allowDangerous: false, auditLogPath: auditPath });
    }, 30000);

    afterAll(async () => {
      await handle.close();
    });

    let sessionId: string | undefined;
    // MCP servers may answer with SSE (text/event-stream) or plain JSON.
    const parseMcpBody = async (res: Response): Promise<any> => {
      const text = await res.text();
      const ctype = res.headers.get("content-type") || "";
      if (ctype.includes("application/json")) return JSON.parse(text);
      for (const line of text.split("\n")) {
        const t = line.trim();
        if (t.startsWith("data:")) return JSON.parse(t.slice(5).trim());
      }
      throw new Error("no JSON payload in MCP response: " + text.slice(0, 200));
    };
    const post = async (body: unknown, auth?: string) => {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      };
      if (auth) headers["Authorization"] = `Bearer ${auth}`;
      if (sessionId) headers["mcp-session-id"] = sessionId;
      const res = await fetch(`http://127.0.0.1:${handle.port}${MCP_HTTP_PATH}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      const sid = res.headers.get("mcp-session-id");
      if (sid) sessionId = sid;
      return res;
    };
    const rpc = (id: number, method: string, params: unknown = {}) => ({ jsonrpc: "2.0", id, method, params });
    const initParams = {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0" },
    };

    it("rejects requests without a bearer token (401)", async () => {
      const res = await post(rpc(1, "initialize", initParams));
      expect(res.status).toBe(401);
    });

    it("answers an unauthenticated HEAD probe with a bearer challenge and no body", async () => {
      const res = await fetch(`http://127.0.0.1:${handle.port}${MCP_HTTP_PATH}`, {
        method: "HEAD",
      });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain("Bearer");
      expect(await res.text()).toBe("");
      expect(res.headers.get("mcp-session-id")).toBeNull();
    });

    it("answers an authenticated HEAD probe without creating an MCP session", async () => {
      const res = await fetch(`http://127.0.0.1:${handle.port}${MCP_HTTP_PATH}`, {
        method: "HEAD",
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(204);
      expect(await res.text()).toBe("");
      expect(res.headers.get("mcp-session-id")).toBeNull();
    });

    it("rejects requests with a wrong bearer token (401)", async () => {
      const res = await post(rpc(1, "ping", {}), "wrong-token");
      expect(res.status).toBe(401);
    });

    it("lists only safe tools after MCP initialize", async () => {
      const init = await post(rpc(1, "initialize", initParams), token);
      expect(init.status).toBe(200);
      const initJson: any = await parseMcpBody(init);
      expect(initJson.result?.serverInfo?.name).toBe("superagent-mcp-server");
      await post({ jsonrpc: "2.0", method: "notifications/initialized" }, token);
      const list = await post(rpc(2, "tools/list"), token);
      expect(list.status).toBe(200);
      const listJson: any = await parseMcpBody(list);
      const names: string[] = (listJson.result?.tools || []).map((t: any) => t.name);
      expect(names).toContain("superagent_read_files");
      expect(names).not.toContain("superagent_read_file");
      expect(names).not.toContain("superagent_exec_command");
      expect(names).not.toContain("superagent_write_file");
      expect(names).not.toContain("superagent_write_files");
    });

    it("blocks dangerous tool calls via allowlist", async () => {
      const call = await post(rpc(3, "tools/call", {
        name: "superagent_exec_command",
        arguments: { command: "echo hacked" },
      }), token);
      expect(call.status).toBe(200);
      const body: any = await parseMcpBody(call);
      expect(body.error).toBeDefined();
    });

    it("writes audit log entries", async () => {
      const content = fs.readFileSync(auditPath, "utf8").trim();
      expect(content.length).toBeGreaterThan(0);
      const lines = content.split("\n").map((l) => JSON.parse(l));
      const blocked = lines.find((e) => e.tool === "superagent_exec_command");
      expect(blocked).toBeDefined();
      expect(blocked.ok).toBe(false);
    });
  });

  describe("dangerous mode lists all tools", () => {
    let handle: McpHttpServerHandle;
    let token: string;

    beforeAll(async () => {
      token = generateMcpBearerToken();
      handle = await startMcpHttpServer({ port: 0, bearerToken: token, allowDangerous: true });
    }, 30000);

    afterAll(async () => {
      await handle.close();
    });

    it("includes exec_command when opted in", async () => {
      const baseHeaders: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token}`,
      };
      const url = `http://127.0.0.1:${handle.port}${MCP_HTTP_PATH}`;
      const initRes = await fetch(url, { method: "POST", headers: baseHeaders,
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
          params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } } }) });
      const sid = initRes.headers.get("mcp-session-id");
      const headers = sid ? { ...baseHeaders, "mcp-session-id": sid } : baseHeaders;
      const list = await fetch(url, {
        method: "POST", headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
      });
      const text = await list.text();
      let body: any;
      const ctype = list.headers.get("content-type") || "";
      if (ctype.includes("application/json")) body = JSON.parse(text);
      else {
        for (const line of text.split("\n")) {
          const t = line.trim();
          if (t.startsWith("data:")) { body = JSON.parse(t.slice(5).trim()); break; }
        }
      }
      const names: string[] = (body?.result?.tools || []).map((t: any) => t.name);
      expect(names).toContain("superagent_exec_command");
      expect(names).toContain("superagent_read_files");
      expect(names).toContain("superagent_write_files");
      expect(names).not.toContain("superagent_read_file");
      expect(names).not.toContain("superagent_write_file");
    });
  });
});

describe("per-session transport isolation", () => {
  let handle: McpHttpServerHandle;
  let token: string;
  const url = () => `http://127.0.0.1:${handle.port}${MCP_HTTP_PATH}`;
  const parseSessionResponse = async (res: Response): Promise<any> => {
    const body = await res.text();
    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("application/json")) return JSON.parse(body);
    for (const line of body.split(String.fromCharCode(10))) {
      const trimmed = line.trim();
      if (trimmed.startsWith("data:")) return JSON.parse(trimmed.slice(5).trim());
    }
    throw new Error("no JSON payload in MCP response: " + body.slice(0, 200));
  };

  const baseHeaders = (auth: string): Record<string, string> => ({
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${auth}`,
  });

  const initialize = async (auth: string): Promise<{ status: number; sessionId: string | null }> => {
    const res = await fetch(url(), {
      method: "POST",
      headers: baseHeaders(auth),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } },
      }),
    });
    await res.text().catch(() => {});
    return { status: res.status, sessionId: res.headers.get("mcp-session-id") };
  };

  beforeAll(async () => {
    token = generateMcpBearerToken();
    handle = await startMcpHttpServer({ port: 0, bearerToken: token, allowDangerous: false });
  }, 30000);

  afterAll(async () => {
    await handle.close();
  });

  it("creates two simultaneous sessions with distinct IDs", async () => {
    const a = await initialize(token);
    const b = await initialize(token);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.sessionId).toBeTruthy();
    expect(b.sessionId).toBeTruthy();
    expect(a.sessionId).not.toBe(b.sessionId);
  });

  it("rejects requests with an unknown session ID", async () => {
    const res = await fetch(url(), {
      method: "POST",
      headers: { ...baseHeaders(token), "mcp-session-id": "does-not-exist" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    expect(res.status).toBe(404);
    await res.text();
  });

  it("rejects non-initialize requests without a session ID", async () => {
    const res = await fetch(url(), { method: "GET", headers: baseHeaders(token) });
    expect(res.status).toBe(400);
    await res.text();
  });

  it("persists workspace switches for one initialized session without changing another session", async () => {
    const testHandle = await startMcpHttpServer({ port: 0, bearerToken: token, allowDangerous: true });
    const testUrl = `http://127.0.0.1:${testHandle.port}${MCP_HTTP_PATH}`;
    const root = fs.mkdtempSync(path.join(process.cwd(), ".tmp-mcp-session-workspaces-"));
    const projectA = path.join(root, "project-a");
    const projectB = path.join(root, "project-b");
    const projectIdA = `session-a-${process.pid}-${Date.now()}`;
    const projectIdB = `session-b-${process.pid}-${Date.now()}`;
    fs.mkdirSync(projectA, { recursive: true });
    fs.mkdirSync(projectB, { recursive: true });
    registerProject({ id: projectIdA, name: "Session Workspace A", type: "local", root: projectA });
    registerProject({ id: projectIdB, name: "Session Workspace B", type: "local", root: projectB });

    const initSession = async (): Promise<string> => {
      const res = await fetch(testUrl, {
        method: "POST",
        headers: baseHeaders(token),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "workspace-test", version: "1" } },
        }),
      });
      await res.text();
      expect(res.status).toBe(200);
      const sessionId = res.headers.get("mcp-session-id");
      expect(sessionId).toBeTruthy();
      return sessionId!;
    };

    const call = async (sessionId: string, id: number, name: string, args: Record<string, unknown> = {}) => {
      const res = await fetch(testUrl, {
        method: "POST",
        headers: { ...baseHeaders(token), "mcp-session-id": sessionId },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      });
      expect(res.status).toBe(200);
      return parseSessionResponse(res);
    };

    const readWorkspace = async (sessionId: string, id: number): Promise<string> => {
      const result: any = await call(sessionId, id, "superagent_get_workspace");
      return result.result.content[0].text;
    };

    try {
      const sessionA = await initSession();
      const sessionB = await initSession();
      const switched: any = await call(sessionA, 2, "superagent_switch_workspace", { workspacePath: projectA });
      expect(switched.result?.content?.[0]?.text).toContain(projectA);
      expect(await readWorkspace(sessionA, 3)).toContain(projectA);
      expect(await readWorkspace(sessionB, 4)).toContain(process.cwd());

      const explicitOnly: any = await call(sessionA, 5, "superagent_get_workspace", { workspace: projectB });
      expect(explicitOnly.result?.content?.[0]?.text).toContain(projectB);
      expect(await readWorkspace(sessionA, 6)).toContain(projectA);
    } finally {
      removeProject(projectIdA);
      removeProject(projectIdB);
      fs.rmSync(root, { recursive: true, force: true });
      await testHandle.close();
    }
  });

  it("supports reconnect with the same session ID and DELETE cleanup", async () => {
    const init = await initialize(token);
    expect(init.sessionId).toBeTruthy();
    const headers = { ...baseHeaders(token), "mcp-session-id": init.sessionId as string };
    const list = await fetch(url(), {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    expect(list.status).toBe(200);
    await list.text();
    const del = await fetch(url(), { method: "DELETE", headers });
    expect(del.status).toBe(200);
    await del.text();
    const gone = await fetch(url(), {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }),
    });
    expect(gone.status).toBe(404);
    await gone.text();
  });
});

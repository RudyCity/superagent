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

  it("default safe tools exclude dangerous ones", () => {
    const safe = getDefaultSafeTools();
    expect(safe).toContain("superagent_read_file");
    expect(safe).not.toContain("superagent_exec_command");
    expect(safe).not.toContain("superagent_write_file");
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
      expect(names).toContain("superagent_read_file");
      expect(names).not.toContain("superagent_exec_command");
      expect(names).not.toContain("superagent_write_file");
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
    });
  });
});

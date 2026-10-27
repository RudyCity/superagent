import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  startMcpHttpServer, type McpHttpServerHandle,
} from "../src/core/mcp/mcpHttpTransport.js";
import { generateBootstrapCode } from "../src/core/mcp/mcpOAuthRoutes.js";
import { randomToken } from "../src/core/mcp/mcpOAuthStore.js";
import { setFullYoloMode, setYoloMode } from "../src/core/permissions.js";

const BASE = "http://127.0.0.1";
const CALLBACK = "http://127.0.0.1/oauth-test-callback";
const initParams = {
  protocolVersion: "2024-11-05", capabilities: {},
  clientInfo: { name: "hermes-oauth-http-test", version: "1" },
};
describe("Hermes Phase 5 OAuth over loopback HTTP/MCP", () => {
  let handle: McpHttpServerHandle;
  let root: string;
  let bootstrap: string;
  const endpoint = () => "http://127.0.0.1:" + handle.port;
  const rpc = (id: number, method: string, params: object = {}) =>
    ({ jsonrpc: "2.0", id, method, params });
  const headers = (token: string, sid?: string): Record<string,string> => ({
    Authorization: "Bearer " + token,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...(sid ? { "mcp-session-id": sid } : {}),
  });
  const post = async (token: string, data: object, sid?: string) => {
    const response = await fetch(endpoint() + "/mcp", {
      method: "POST", headers: headers(token, sid), body: JSON.stringify(data),
    });
    return { status: response.status, sid: response.headers.get("mcp-session-id"), body: await response.text() };
  };
  async function initialize(token: string) {
    const response = await post(token, rpc(1,"initialize",initParams));
    expect(response.status).toBe(200);
    expect(response.sid).toBeTruthy();
    return response.sid!;
  }
  async function issuePair(client: string, scope: string[]): Promise<{ access_token: string; refresh_token: string }> {
    const verifier = randomToken(40);
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    const query = new URLSearchParams({
      client_id:client, redirect_uri:CALLBACK, response_type:"code",
      code_challenge:challenge, code_challenge_method:"S256",
      scope:scope.join(" "), state:"state-" + client, resource:BASE + "/mcp",
    });
    const consent = await fetch(endpoint() + "/oauth/authorize?" + query, { redirect:"manual" });
    expect(consent.status).toBe(200);
    const requestId = /name="request_id" value="([^"]+)"/.exec(await consent.text())?.[1];
    expect(requestId).toBeTruthy();
    const approve = await fetch(endpoint() + "/oauth/authorize", {
      method:"POST", redirect:"manual",
      headers:{"Content-Type":"application/x-www-form-urlencoded"},
      body:new URLSearchParams({
        request_id:requestId!,bootstrap_code:bootstrap,decision:"approve",
      }),
    });
    expect(approve.status).toBe(302);
    const code = new URL(approve.headers.get("location")!).searchParams.get("code");
    expect(code).toBeTruthy();
    const grant = await fetch(endpoint() + "/oauth/token", {
      method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},
      body:new URLSearchParams({
        grant_type:"authorization_code",code:code!,
        client_id:client,redirect_uri:CALLBACK,code_verifier:verifier,
        resource:BASE + "/mcp",
      }),
    });
    expect(grant.status).toBe(200);
    const tokens = await grant.json() as {access_token:string;refresh_token:string;scope:string};
    expect(tokens.scope.split(" ")).toEqual(scope);
    return tokens;
  }
  async function issue(client: string, scope: string[]) {
    return (await issuePair(client, scope)).access_token;
  }

  beforeAll(async () => {
    setFullYoloMode(false);setYoloMode(false);
    root = fs.mkdtempSync(path.join(process.cwd(),".tmp-hermes-oauth-http-"));
    const generated = generateBootstrapCode();
    bootstrap = generated.code;
    handle = await startMcpHttpServer({
      port:0,allowDangerous:true,authMode:"oauth",
      oauth:{publicBaseUrl:BASE,bootstrapCodeHash:generated.codeHash},
      auditLogPath:path.join(root,"audit.jsonl"),
    });
    handle.oauthStore!.registerClient("client-a",[CALLBACK]);
    handle.oauthStore!.registerClient("client-b",[CALLBACK]);
  }, 30000);
  afterAll(async () => {
    await handle?.close();
    if (root) fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
    setFullYoloMode(false);setYoloMode(false);
  });

  it("rejects another client DELETE and keeps the legitimate session alive", async () => {
    const a = await issue("client-a",["mcp:tools"]);
    const b = await issue("client-b",["mcp:tools"]);
    const sidA = await initialize(a);
    const sidB = await initialize(b);
    expect(sidA).not.toBe(sidB);
    const foreign = await fetch(endpoint() + "/mcp", {
      method:"DELETE",headers:headers(b,sidA),
    });
    expect(foreign.status).toBe(403);
    await foreign.text();
    const check = await post(a,rpc(2,"tools/list"),sidA);
    expect(check.status).toBe(200);
    expect(check.body).toContain("superagent_tool_search");
    const discovered = await post(a, rpc(10, "tools/call", {
      name: "superagent_tool_search", arguments: { query: "superagent_read_files" },
    }), sidA);
    expect(discovered.body).toContain("superagent_read_files");
    const own = await fetch(endpoint() + "/mcp",{method:"DELETE",headers:headers(a,sidA)});
    expect(own.status).toBe(200);
    await own.text();
    expect((await post(a,rpc(3,"tools/list"),sidA)).status).toBe(404);
  }, 25000);

  it("binds a session to the exact token even for two scopes of one OAuth client", async () => {
    const writer = await issue("client-a",["mcp:tools","mcp:tools:write"]);
    const reader = await issue("client-a",["mcp:tools"]);
    const writerSession = await initialize(writer);
    expect((await post(reader,rpc(4,"tools/list"),writerSession)).status).toBe(403);
    const deniedDelete = await fetch(endpoint() + "/mcp", {
      method:"DELETE",headers:headers(reader,writerSession),
    });
    expect(deniedDelete.status).toBe(403);
    await deniedDelete.text();
    const readerSession = await initialize(reader);
    const readList = await post(reader,rpc(5,"tools/list"),readerSession);
    expect(readList.body).toContain("superagent_tool_search");
    expect(readList.body).not.toContain('"name":"superagent_write_files"');
    const discoveredReader = await post(reader, rpc(51, "tools/call", {
      name: "superagent_tool_search", arguments: { query: "superagent_read_files" },
    }), readerSession);
    expect(discoveredReader.body).toContain("superagent_read_files");
    const hiddenWriter = await post(reader, rpc(52, "tools/call", {
      name: "superagent_tool_search", arguments: { query: "superagent_write_files" },
    }), readerSession);
    expect(hiddenWriter.body).not.toContain('"name":"superagent_write_files"');
    const target = path.join(root,"must-not-write.txt");
    const denied = await post(reader,rpc(6,"tools/call", {
      name:"superagent_write_files",
      arguments:{files:[{filePath:target,content:"DENIED_SENTINEL"}]},
    }),readerSession);
    expect(denied.body).toContain("mcp:tools:write");
    expect(fs.existsSync(target)).toBe(false);
    expect((await post(writer,rpc(7,"tools/list"),writerSession)).status).toBe(200);
    expect(handle.oauthStore!.revokeToken(writer)).toBe(true);
    expect((await post(writer,rpc(8,"tools/list"),writerSession)).status).toBe(401);
    expect((await post(reader,rpc(9,"tools/list"),readerSession)).status).toBe(200);
    expect(fs.readFileSync(path.join(root,"audit.jsonl"),"utf8")).not.toContain("DENIED_SENTINEL");
  }, 35000);

  it("keeps Brain mutation unavailable when local YOLO is OFF even with OAuth write scope", async () => {
    const alice = await issue("client-a", ["mcp:tools", "mcp:tools:write"]);
    const bob = await issue("client-b", ["mcp:tools", "mcp:tools:write"]);
    const reader = await issue("client-a", ["mcp:tools"]);
    const aliceSession = await initialize(alice);
    const bobSession = await initialize(bob);
    const readerSession = await initialize(reader);
    expect((await post(reader, rpc(65, "tools/list"), readerSession)).body)
      .not.toContain('"name":"superagent_brain"');
    const readDenied = await post(reader, rpc(66, "tools/call", {
      name: "superagent_brain", arguments: { action: "create", sessionId: "sess_http_owner" },
    }), readerSession);
    expect(readDenied.body).toContain("mcp:tools:write");
    const created = await post(alice, rpc(67, "tools/call", {
      name: "superagent_brain", arguments: { action: "create", sessionId: "sess_http_owner" },
    }), aliceSession);
    expect(created.status).toBe(200);
    expect(created.body).toContain("YOLO OFF");
    expect(created.body).not.toContain('"sessionId":"sess_http_owner"');
    const bobDenied = await post(bob, rpc(69, "tools/call", {
      name: "superagent_brain", arguments: {
        action: "read", sessionId: "sess_http_owner", filePath: "artifacts/result.txt",
      },
    }), bobSession);
    expect(bobDenied.body).not.toContain("ALICE_ONLY_SENTINEL");
  }, 30000);

  it("requires separately consented admin scope for project access management over HTTP", async () => {
    const writer = await issue("client-a", ["mcp:tools", "mcp:tools:write"]);
    const admin = await issue("client-b", ["mcp:tools", "mcp:tools:write", "mcp:tools:admin"]);
    const writerSession = await initialize(writer);
    const adminSession = await initialize(admin);
    const listWriter = await post(writer, rpc(21, "tools/list"), writerSession);
    expect(listWriter.status).toBe(200);
    expect(listWriter.body).not.toContain('"name":"superagent_grant_project_access"');
    expect(listWriter.body).toContain('"name":"superagent_tool_search"');
    const writerSearch = await post(writer, rpc(211, "tools/call", {
      name: "superagent_tool_search", arguments: { query: "superagent_write_files" },
    }), writerSession);
    // OAuth write scope is insufficient when local YOLO is OFF.
    expect(writerSearch.body).not.toContain('"name":"superagent_write_files"');
    const listAdmin = await post(admin, rpc(22, "tools/list"), adminSession);
    expect(listAdmin.status).toBe(200);
    expect(listAdmin.body).toContain('"name":"superagent_tool_search"');
    const adminSearch = await post(admin, rpc(221, "tools/call", {
      name: "superagent_tool_search", arguments: { query: "superagent_grant_project_access" },
    }), adminSession);
    expect(adminSearch.body).not.toContain('"name":"superagent_grant_project_access"');
    const denied = await post(writer, rpc(23, "tools/call", {
      name: "superagent_grant_project_access",
      arguments: { projectId: "nonexistent", capabilities: ["read"] },
    }), writerSession);
    expect(denied.body).toContain("mcp:tools:admin");
    // Admin scope is necessary, but local Full YOLO and project checks remain
    // independently enforced; this test never changes a real access grant.
    const notElevated = await post(admin, rpc(24, "tools/call", {
      name: "superagent_grant_project_access",
      arguments: { projectId: "nonexistent", capabilities: ["read"] },
    }), adminSession);
    expect(notElevated.body).not.toContain("requires OAuth mcp:tools:admin");
  }, 30000);

  it("enforces OAuth read and admin scope for MCP resources and prompts over HTTP", async () => {
    const reader = await issue("client-a", ["mcp:tools"]);
    const admin = await issue("client-b", ["mcp:tools", "mcp:tools:write", "mcp:tools:admin"]);
    const readerSession = await initialize(reader);
    const adminSession = await initialize(admin);
    const listReader = await post(reader, rpc(31, "resources/list"), readerSession);
    expect(listReader.status).toBe(200);
    expect(listReader.body).toContain("superagent://instructions/agentic-mcp");
    expect(listReader.body).not.toContain("superagent://memory/pinned");
    expect(listReader.body).not.toContain("superagent://history/sessions");
    const direct = await post(reader, rpc(32, "resources/read", {
      uri: "superagent://memory/pinned",
    }), readerSession);
    expect(direct.body).toContain("mcp:tools:admin");
    expect(direct.body).not.toContain("pinnedKnowledge");
    // Stateless MCP requests are subject to the same server-side guard.
    const stateless = await post(reader, rpc(33, "resources/read", {
      uri: "superagent://config/current",
    }));
    expect(stateless.body).toContain("mcp:tools:admin");

    const adminList = await post(admin, rpc(34, "resources/list"), adminSession);
    expect(adminList.status).toBe(200);
    expect(adminList.body).toContain("superagent://memory/pinned");
    const prompts = await post(reader, rpc(35, "prompts/list"), readerSession);
    expect(prompts.status).toBe(200);
    expect(prompts.body).toContain("superagent_debug");
    expect((await post(reader, rpc(36, "prompts/get", {
      name: "superagent_debug", arguments: { error: "sample error" },
    }), readerSession)).status).toBe(200);
  }, 30000);

  it("rejects old tokens after a fresh OAuth HTTP server starts (no implicit session recovery)", async () => {
    const oldAccess = await issue("client-a", ["mcp:tools", "mcp:tools:write"]);
    const oldSession = await initialize(oldAccess);
    const freshBootstrap = generateBootstrapCode();
    const replacement = await startMcpHttpServer({
      port: 0, allowDangerous: true, authMode: "oauth",
      oauth: { publicBaseUrl: BASE, bootstrapCodeHash: freshBootstrap.codeHash },
      auditLogPath: path.join(root, "new-runtime-audit.jsonl"),
    });
    try {
      const freshUrl = "http://127.0.0.1:" + replacement.port + "/mcp";
      const forbidden = await fetch(freshUrl, {
        method: "POST",
        headers: headers(oldAccess, oldSession),
        body: JSON.stringify(rpc(41, "tools/list")),
      });
      expect(forbidden.status).toBe(401);
      expect(forbidden.headers.get("mcp-session-id")).toBeNull();
      await forbidden.text();
      const probe = await fetch(freshUrl, { method: "HEAD" });
      expect(probe.status).toBe(401);
      expect(probe.headers.get("www-authenticate")).toContain("oauth-protected-resource");
      expect(probe.headers.get("mcp-session-id")).toBeNull();
      // Starting a second isolated runtime must not revoke or mutate the
      // existing one; a real restart shuts down the old listener.
      expect((await post(oldAccess, rpc(42, "tools/list"), oldSession)).status).toBe(200);
    } finally {
      await replacement.close();
    }
  }, 30000);

  it("refresh rotation requires a new MCP session and rejects replayed refresh grants", async () => {
    const issued = await issuePair("client-b", ["mcp:tools"]);
    const oldSession = await initialize(issued.access_token);
    const rotate = async (refresh: string) => {
      const res = await fetch(endpoint() + "/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token", refresh_token: refresh,
          resource: BASE + "/mcp",
        }),
      });
      return { status: res.status, data: await res.json() as Record<string,string> };
    };
    const rotated = await rotate(issued.refresh_token);
    expect(rotated.status).toBe(200);
    expect(rotated.data.access_token).not.toBe(issued.access_token);
    expect((await rotate(issued.refresh_token)).status).toBe(400);
    expect((await post(rotated.data.access_token, rpc(11, "tools/list"), oldSession)).status).toBe(403);
    const newSession = await initialize(rotated.data.access_token);
    expect((await post(rotated.data.access_token, rpc(12, "tools/list"), newSession)).status).toBe(200);
  }, 30000);

  it("validates token audience against a foreign MCP resource", async () => {
    const token = await issue("client-b",["mcp:tools"]);
    expect(handle.oauthStore!.verifyAccessToken(token)?.resource).toBe(BASE + "/mcp");
    expect(handle.oauthStore!.verifyAccessToken(token,"https://foreign.example/mcp")).toBeNull();
  });
});

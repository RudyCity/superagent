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
import { ACTIVE_RULE_REQUESTS_FILENAME } from "../src/core/desktopUi/activeFileAccessRequestStore.js";
import { PERMANENT_ACCESS_FILENAME } from "../src/core/desktopUi/permanentRegistryStore.js";
import {
  approveProjectAccessRequest,
  listProjectAccessRequests,
} from "../src/core/project/projectAccessRequestStore.js";
import { registerProject } from "../src/core/project/projectRegistry.js";
import { identityOfSelf } from "../src/core/tools/registeredFileToolGate.js";

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
  const searchedToolNames = (body: string): string[] => {
    const data = body.split(/\r?\n/).find((line) => line.startsWith("data: "));
    expect(data, "MCP response must contain a JSON-RPC SSE message").toBeDefined();
    const response = JSON.parse(data!.slice(6));
    expect(response.error).toBeUndefined();
    const text = response.result?.content?.find((item: {type: string}) => item.type === "text")?.text;
    const names = JSON.parse(text)?.tools;
    expect(Array.isArray(names)).toBe(true);
    return names.map((tool: {name: string}) => tool.name);
  };
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

  it("keeps Brain mutation unavailable without MCP Connection Security Approval even with OAuth write scope", async () => {
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
    // MCP Connections establishes the connection only. Operational authority is
    // Project Access, so a missing Execute grant must fail before any Brain mutation.
    expect(created.body).toContain("PROJECT_GRANT_MISSING");
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
    // Tool discovery reflects OAuth capability; execution still needs human-approved project grants.
    expect(searchedToolNames(writerSearch.body)).toContain("superagent_write_files");
    const listAdmin = await post(admin, rpc(22, "tools/list"), adminSession);
    expect(listAdmin.status).toBe(200);
    expect(listAdmin.body).toContain('"name":"superagent_tool_search"');
    const adminSearch = await post(admin, rpc(221, "tools/call", {
      name: "superagent_tool_search", arguments: { query: "superagent_grant_project_access" },
    }), adminSession);
    expect(searchedToolNames(adminSearch.body)).toContain("superagent_grant_project_access");
    const denied = await post(writer, rpc(23, "tools/call", {
      name: "superagent_grant_project_access",
      arguments: { projectId: "nonexistent", capabilities: ["read"] },
    }), writerSession);
    expect(denied.body).toContain("mcp:tools:admin");
    // Admin OAuth scope alone never permits self-grant; only human approval issues project grants.
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

  it("advertises all three access-request tools at connection start and queues pending Tray requests without auto-granting", async () => {
    const previousConfigDir = process.env.SUPERAGENT_CONFIG_DIR;
    const configDir = path.join(root, "access-e2e-config");
    const projectDir = path.join(root, "access-e2e-project");
    const targetFile = path.join(projectDir, "artifact.txt");
    const targetExe = path.join(configDir, process.platform === "win32" ? "viewer.exe" : "viewer");
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(targetFile, "protected-e2e-content", "utf8");
    process.env.SUPERAGENT_CONFIG_DIR = configDir;

    const parseSseResult = (body: string) => {
      const data = body.split(/\r?\n/).find((line) => line.startsWith("data: "));
      expect(data, "MCP response must contain a JSON-RPC SSE message").toBeDefined();
      const response = JSON.parse(data!.slice(6));
      expect(response.error).toBeUndefined();
      return response.result;
    };

    try {
      registerProject({
        id: "e2e-access-proj",
        name: "E2E Access Project",
        type: "local",
        root: projectDir,
      });

      const reader = await issue("client-a", ["mcp:tools"]);
      const sessionId = await initialize(reader);

      const listRes = await post(reader, rpc(70, "tools/list"), sessionId);
      expect(listRes.status).toBe(200);
      const listedNames = (parseSseResult(listRes.body).tools as Array<{ name: string }>).map((t) => t.name);
      expect(listedNames).toEqual(expect.arrayContaining([
        "superagent_request_project_access",
        "superagent_request_file_access",
        "superagent_request_application_access",
      ]));

      const projCall = await post(reader, rpc(71, "tools/call", {
        name: "superagent_request_project_access",
        arguments: {
          projectId: "e2e-access-proj",
          capabilities: ["read"],
          reason: "Inspect project files after operator approval.",
        },
      }), sessionId);
      expect(projCall.status).toBe(200);
      const projPayload = JSON.parse(parseSseResult(projCall.body).content[0].text);
      expect(projPayload).toMatchObject({
        projectId: "e2e-access-proj",
        status: "pending",
        code: "APPROVAL_PENDING",
      });

      const fileCall = await post(reader, rpc(72, "tools/call", {
        name: "superagent_request_file_access",
        arguments: {
          filePath: targetFile,
          operations: ["read"],
          reason: "Read one selected artifact after Tray approval.",
        },
      }), sessionId);
      expect(fileCall.status).toBe(200);
      const filePayload = JSON.parse(parseSseResult(fileCall.body).content[0].text);
      expect(filePayload).toMatchObject({
        status: "pending",
        kind: "file",
        grantCreated: false,
        filePath: targetFile,
      });

      const appCall = await post(reader, rpc(73, "tools/call", {
        name: "superagent_request_application_access",
        arguments: {
          executablePath: targetExe,
          operations: ["view"],
          reason: "Inspect the selected desktop application window.",
        },
      }), sessionId);
      expect(appCall.status).toBe(200);
      const appPayload = JSON.parse(parseSseResult(appCall.body).content[0].text);
      expect(appPayload).toMatchObject({
        status: "pending",
        kind: "desktop",
        grantCreated: false,
        executablePath: targetExe,
      });

      const pendingProjectRequests = listProjectAccessRequests();
      expect(pendingProjectRequests).toHaveLength(1);
      expect(pendingProjectRequests[0]).toMatchObject({
        projectId: "e2e-access-proj",
        status: "pending",
      });

      const queueEntries = JSON.parse(
        fs.readFileSync(path.join(configDir, ACTIVE_RULE_REQUESTS_FILENAME), "utf8"),
      ) as Array<{ kind: string; status: string }>;
      expect(queueEntries).toHaveLength(2);
      expect(queueEntries.map((entry) => ({
        kind: entry.kind,
        status: entry.status,
      }))).toEqual(expect.arrayContaining([
        { kind: "file", status: "pending" },
        { kind: "desktop", status: "pending" },
      ]));

      const readBeforeApproval = await post(reader, rpc(74, "tools/call", {
        name: "superagent_read_files",
        arguments: { files: [targetFile] },
      }), sessionId);
      expect(readBeforeApproval.body).not.toContain("protected-e2e-content");
    } finally {
      if (previousConfigDir === undefined) delete process.env.SUPERAGENT_CONFIG_DIR;
      else process.env.SUPERAGENT_CONFIG_DIR = previousConfigDir;
    }
  }, 30000);

  it("allows reading an approved file after operator project approval and permanent rule, while keeping unapproved files and writes denied", async () => {
    const previousConfigDir = process.env.SUPERAGENT_CONFIG_DIR;
    const configDir = path.join(root, "approved-e2e-config");
    const projectDir = path.join(root, "approved-e2e-project");
    const allowedFile = path.join(projectDir, "allowed.txt");
    const unapprovedFile = path.join(projectDir, "blocked.txt");
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(allowedFile, "approved-e2e-secret", "utf8");
    fs.writeFileSync(unapprovedFile, "blocked-e2e-secret", "utf8");
    process.env.SUPERAGENT_CONFIG_DIR = configDir;

    const parseSseResult = (body: string) => {
      const data = body.split(/\r?\n/).find((line) => line.startsWith("data: "));
      expect(data, "MCP response must contain a JSON-RPC SSE message").toBeDefined();
      const response = JSON.parse(data!.slice(6));
      expect(response.error).toBeUndefined();
      return response.result;
    };

    try {
      const selfIdentity = identityOfSelf();
      expect(selfIdentity).not.toBeNull();
      const canonicalAllowedFile = fs.realpathSync.native(allowedFile).replace(/^\\\\\?\\/, "");

      registerProject({
        id: "e2e-approved-proj",
        name: "E2E Approved Project",
        type: "local",
        root: projectDir,
      });

      const writer = await issue("client-a", ["mcp:tools", "mcp:tools:write"]);
      const sessionId = await initialize(writer);

      const projReq = await post(writer, rpc(80, "tools/call", {
        name: "superagent_request_project_access",
        arguments: {
          projectId: "e2e-approved-proj",
          capabilities: ["read"],
          reason: "Read approved artifact in E2E workflow.",
        },
      }), sessionId);
      expect(projReq.status).toBe(200);
      const reqPayload = JSON.parse(parseSseResult(projReq.body).content[0].text);
      expect(reqPayload.status).toBe("pending");

      const approval = approveProjectAccessRequest(reqPayload.requestId);
      expect(approval.success).toBe(true);
      expect(approval.grant.capabilities).toEqual(["read"]);

      fs.writeFileSync(
        path.join(configDir, PERMANENT_ACCESS_FILENAME),
        JSON.stringify({
          version: 2,
          defaultEffect: "deny",
          rules: [
            {
              id: "allow-e2e-read",
              kind: "file",
              effect: "allow",
              app: selfIdentity,
              operations: ["read"],
              scope: { path: canonicalAllowedFile, recursive: false },
            },
          ],
        }),
        "utf8",
      );

      const allowedRead = await post(writer, rpc(81, "tools/call", {
        name: "superagent_tool_execute",
        arguments: {
          name: "superagent_read_files",
          arguments: { projectId: "e2e-approved-proj", files: [allowedFile] },
        },
      }), sessionId);
      expect(allowedRead.status).toBe(200);
      expect(allowedRead.body).toContain("approved-e2e-secret");

      const unapprovedRead = await post(writer, rpc(82, "tools/call", {
        name: "superagent_tool_execute",
        arguments: {
          name: "superagent_read_files",
          arguments: { projectId: "e2e-approved-proj", files: [unapprovedFile] },
        },
      }), sessionId);
      expect(unapprovedRead.body).not.toContain("blocked-e2e-secret");

      const ungrantedWrite = await post(writer, rpc(83, "tools/call", {
        name: "superagent_tool_execute",
        arguments: {
          name: "superagent_write_files",
          arguments: {
            projectId: "e2e-approved-proj",
            files: [{ filePath: allowedFile, content: "mutated" }],
          },
        },
      }), sessionId);
      expect(ungrantedWrite.body).toMatch(
        /PROJECT_GRANT_MISSING|HOST_POLICY_BLOCKED|Access denied by host permanent file policy/i,
      );
      expect(JSON.parse(ungrantedWrite.body.split(/\r?\n/).find((l) => l.startsWith("data: "))!.slice(6)).result?.isError).toBe(true);
      expect(fs.readFileSync(allowedFile, "utf8")).toBe("approved-e2e-secret");
    } finally {
      if (previousConfigDir === undefined) delete process.env.SUPERAGENT_CONFIG_DIR;
      else process.env.SUPERAGENT_CONFIG_DIR = previousConfigDir;
    }
  }, 30000);
});

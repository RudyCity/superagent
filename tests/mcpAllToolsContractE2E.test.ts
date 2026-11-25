import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  startMcpHttpServer,
  type McpHttpServerHandle,
} from "../src/core/mcp/mcpHttpTransport.js";
import { generateBootstrapCode } from "../src/core/mcp/mcpOAuthRoutes.js";
import { randomToken } from "../src/core/mcp/mcpOAuthStore.js";
import { MCP_TOOL_DEFINITIONS } from "../src/core/mcp/superagentMcpServer.js";
import {
  DISABLED_MCP_TOOLS,
  MCP_TOOL_CLASSIFICATION,
  PRIVILEGED_MCP_TOOLS,
} from "../src/core/mcp/mcpToolPolicy.js";
import {
  MCP_GATEWAY_TOOL_NAMES,
  isGatewayInitiallyAdvertisedTool,
} from "../src/core/mcp/mcpToolGateway.js";
import { setFullYoloMode, setYoloMode } from "../src/core/permissions.js";

const BASE = "http://127.0.0.1";
const CALLBACK = "http://127.0.0.1/oauth-all-tools-callback";
const GATEWAY_META_SET = new Set<string>(Object.values(MCP_GATEWAY_TOOL_NAMES));

describe("Layer 1 All-Tools Contract & Policy E2E over OAuth HTTP/MCP", () => {
  let handle: McpHttpServerHandle;
  let root: string;
  let configDir: string;
  let bootstrap: string;
  let previousConfigDir: string | undefined;
  let reqId = 1;

  const endpoint = () => `http://127.0.0.1:${handle.port}`;
  const rpc = (method: string, params: object = {}) => ({
    jsonrpc: "2.0",
    id: reqId++,
    method,
    params,
  });
  const headers = (token: string, sid?: string): Record<string, string> => ({
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...(sid ? { "mcp-session-id": sid } : {}),
  });

  const post = async (token: string, data: object, sid?: string) => {
    const response = await fetch(`${endpoint()}/mcp`, {
      method: "POST",
      headers: headers(token, sid),
      body: JSON.stringify(data),
    });
    return {
      status: response.status,
      sid: response.headers.get("mcp-session-id"),
      body: await response.text(),
    };
  };

  const parseSseJson = (body: string) => {
    const data = body.split(/\r?\n/).find((line) => line.startsWith("data: "));
    expect(data, "MCP response must contain a JSON-RPC SSE message").toBeDefined();
    return JSON.parse(data!.slice(6));
  };

  const callToolJson = async (
    token: string,
    sid: string,
    name: string,
    args: Record<string, unknown> = {},
  ) => {
    const res = await post(token, rpc("tools/call", { name, arguments: args }), sid);
    expect(res.status).toBe(200);
    const parsed = parseSseJson(res.body);
    return { raw: res.body, rpc: parsed, result: parsed.result, error: parsed.error };
  };

  async function issueToken(client: string, scope: string[]): Promise<string> {
    const verifier = randomToken(40);
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    const query = new URLSearchParams({
      client_id: client,
      redirect_uri: CALLBACK,
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: scope.join(" "),
      state: `state-${client}`,
      resource: `${BASE}/mcp`,
    });
    const consent = await fetch(`${endpoint()}/oauth/authorize?${query}`, { redirect: "manual" });
    expect(consent.status).toBe(200);
    const requestId = /name="request_id" value="([^"]+)"/.exec(await consent.text())?.[1];
    expect(requestId).toBeTruthy();
    const approve = await fetch(`${endpoint()}/oauth/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        request_id: requestId!,
        bootstrap_code: bootstrap,
        decision: "approve",
      }),
    });
    expect(approve.status).toBe(302);
    const code = new URL(approve.headers.get("location")!).searchParams.get("code");
    expect(code).toBeTruthy();
    const grant = await fetch(`${endpoint()}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code!,
        client_id: client,
        redirect_uri: CALLBACK,
        code_verifier: verifier,
        resource: `${BASE}/mcp`,
      }),
    });
    expect(grant.status).toBe(200);
    const tokens = (await grant.json()) as { access_token: string };
    return tokens.access_token;
  }

  async function initialize(token: string): Promise<string> {
    const res = await post(
      token,
      rpc("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "all-tools-e2e-client", version: "1.0.0" },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.sid).toBeTruthy();
    return res.sid!;
  }

  beforeAll(async () => {
    setFullYoloMode(false);
    setYoloMode(false);
    previousConfigDir = process.env.SUPERAGENT_CONFIG_DIR;
    root = fs.mkdtempSync(path.join(os.tmpdir(), "sa-all-tools-e2e-"));
    configDir = path.join(root, "config");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "desktop-access-registry.json"),
      JSON.stringify({ version: 2, defaultEffect: "deny", rules: [] }),
      "utf8",
    );
    process.env.SUPERAGENT_CONFIG_DIR = configDir;

    const generated = generateBootstrapCode();
    bootstrap = generated.code;
    handle = await startMcpHttpServer({
      port: 0,
      allowDangerous: true,
      authMode: "oauth",
      toolExposure: "gateway",
      oauth: { publicBaseUrl: BASE, bootstrapCodeHash: generated.codeHash },
      auditLogPath: path.join(root, "audit.jsonl"),
    });
    handle.oauthStore!.registerClient("all-tools-reader", [CALLBACK]);
    handle.oauthStore!.registerClient("all-tools-writer", [CALLBACK]);
    handle.oauthStore!.registerClient("all-tools-admin", [CALLBACK]);
  }, 30000);

  afterAll(async () => {
    await handle?.close();
    if (previousConfigDir === undefined) delete process.env.SUPERAGENT_CONFIG_DIR;
    else process.env.SUPERAGENT_CONFIG_DIR = previousConfigDir;
    if (root) {
      try {
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      } catch {
        // Ignore transient Windows file handle locks during temp dir cleanup.
      }
    }
    setFullYoloMode(false);
    setYoloMode(false);
  });

  it("enforces OAuth scope visibility, gateway advertisement, and disabled-tool isolation across all 255 definitions", async () => {
    const activeTools = MCP_TOOL_DEFINITIONS.filter((t) => !DISABLED_MCP_TOOLS.has(t.name));
    const safeTools = activeTools.filter((t) => MCP_TOOL_CLASSIFICATION[t.name] === "safe");
    const dangerousTools = activeTools.filter((t) => MCP_TOOL_CLASSIFICATION[t.name] === "dangerous");

    expect(activeTools.length + DISABLED_MCP_TOOLS.size).toBe(MCP_TOOL_DEFINITIONS.length);
    expect(safeTools.length + dangerousTools.length).toBe(activeTools.length);

    const readerToken = await issueToken("all-tools-reader", ["mcp:tools"]);
    const writerToken = await issueToken("all-tools-writer", ["mcp:tools", "mcp:tools:write"]);
    const adminToken = await issueToken("all-tools-admin", [
      "mcp:tools",
      "mcp:tools:write",
      "mcp:tools:admin",
    ]);

    const readerSid = await initialize(readerToken);
    const writerSid = await initialize(writerToken);
    const adminSid = await initialize(adminToken);

    const checkListAndStatus = async (
      token: string,
      sid: string,
      expectedVisibleCount: number,
      allowDangerous: boolean,
      allowAdmin: boolean,
    ) => {
      const listRes = await post(token, rpc("tools/list"), sid);
      expect(listRes.status).toBe(200);
      const listedNames = (parseSseJson(listRes.body).result.tools as Array<{ name: string }>).map(
        (t) => t.name,
      );
      expect(listedNames.every((name) => isGatewayInitiallyAdvertisedTool(name))).toBe(true);
      for (const disabledName of DISABLED_MCP_TOOLS) {
        expect(listedNames).not.toContain(disabledName);
      }
      if (!allowDangerous) {
        expect(listedNames.some((n) => MCP_TOOL_CLASSIFICATION[n] === "dangerous")).toBe(false);
      }
      if (!allowAdmin) {
        expect(listedNames.some((n) => PRIVILEGED_MCP_TOOLS.has(n))).toBe(false);
      }

      const statusCall = await callToolJson(token, sid, MCP_GATEWAY_TOOL_NAMES.status);
      const statusPayload = JSON.parse(statusCall.result.content[0].text);
      expect(statusPayload.mode).toBe("gateway");
      expect(statusPayload.visibleToolCount).toBe(expectedVisibleCount);
      expect(statusPayload.filePolicy).toMatchObject({ active: true });
      expect(statusPayload.filePolicy.readinessCounts.uncertified).toBe(0);
    };

    const nonGatewaySafeCount = safeTools.filter((t) => !GATEWAY_META_SET.has(t.name)).length;
    const nonGatewayWriterCount = activeTools.filter(
      (t) => !GATEWAY_META_SET.has(t.name) && !PRIVILEGED_MCP_TOOLS.has(t.name),
    ).length;
    const nonGatewayAdminCount = activeTools.filter((t) => !GATEWAY_META_SET.has(t.name)).length;

    await checkListAndStatus(readerToken, readerSid, nonGatewaySafeCount, false, false);
    await checkListAndStatus(writerToken, writerSid, nonGatewayWriterCount, true, false);
    await checkListAndStatus(adminToken, adminSid, nonGatewayAdminCount, true, true);

    // Every disabled tool must fail describe, preflight, and execute even with admin scope.
    for (const disabledName of DISABLED_MCP_TOOLS) {
      const desc = await callToolJson(adminToken, adminSid, MCP_GATEWAY_TOOL_NAMES.describe, {
        name: disabledName,
      });
      expect(desc.result?.isError).toBe(true);

      const exec = await callToolJson(adminToken, adminSid, MCP_GATEWAY_TOOL_NAMES.execute, {
        name: disabledName,
        arguments: {},
      });
      expect(exec.result?.isError).toBe(true);

      const preflight = await callToolJson(adminToken, adminSid, MCP_GATEWAY_TOOL_NAMES.preflight, {
        name: disabledName,
      });
      const preflightJson = JSON.parse(preflight.result.content[0].text);
      expect(preflightJson.ok).toBe(false);
      expect(preflightJson.reasonCode).toBe("unsupported_action");
    }

    // Reader cannot describe or execute dangerous tools.
    for (const sampleDangerous of ["superagent_exec_command", "superagent_write_files", "superagent_grant_project_access"]) {
      const desc = await callToolJson(readerToken, readerSid, MCP_GATEWAY_TOOL_NAMES.describe, {
        name: sampleDangerous,
      });
      expect(desc.result?.isError).toBe(true);

      const exec = await callToolJson(readerToken, readerSid, MCP_GATEWAY_TOOL_NAMES.execute, {
        name: sampleDangerous,
        arguments: {},
      });
      expect(exec.result?.isError).toBe(true);
    }
  }, 60000);

  it("audits all 243 active tools via doctor, describe, and preflight over HTTP", async () => {
    const activeTools = MCP_TOOL_DEFINITIONS.filter((t) => !DISABLED_MCP_TOOLS.has(t.name));
    const adminToken = await issueToken("all-tools-admin", [
      "mcp:tools",
      "mcp:tools:write",
      "mcp:tools:admin",
    ]);
    const adminSid = await initialize(adminToken);

    const doctorCall = await callToolJson(adminToken, adminSid, MCP_GATEWAY_TOOL_NAMES.doctor, {
      filter: "all",
      runSmokeTests: false,
    });
    expect(doctorCall.result?.isError).not.toBe(true);
    const doctorReport = JSON.parse(doctorCall.result.content[0].text);
    expect(doctorReport.summary.totalTools).toBe(MCP_TOOL_DEFINITIONS.length);
    expect(doctorReport.summary.activeTools).toBe(activeTools.length);
    expect(doctorReport.summary.disabledTools).toBe(DISABLED_MCP_TOOLS.size);
    expect(doctorReport.summary.hostPolicyActive).toBe(true);
    const auditedNames = new Set((doctorReport.actions as Array<{ toolName: string }>).map((a) => a.toolName));
    for (const tool of activeTools) {
      expect(auditedNames.has(tool.name), `Doctor missing ${tool.name}`).toBe(true);
    }

    // Verify describe for all 237 non-gateway tools and preflight for all 243 active tools.
    for (const tool of activeTools) {
      if (!GATEWAY_META_SET.has(tool.name)) {
        const desc = await callToolJson(adminToken, adminSid, MCP_GATEWAY_TOOL_NAMES.describe, {
          name: tool.name,
        });
        expect(desc.result?.isError, `describe failed for ${tool.name}`).not.toBe(true);
        const descPayload = JSON.parse(desc.result.content[0].text);
        expect(descPayload.name).toBe(tool.name);
        expect(descPayload.inputSchema?.type).toBe("object");
        expect(descPayload.filePolicy).not.toBe("uncertified");
      }

      const preflight = await callToolJson(adminToken, adminSid, MCP_GATEWAY_TOOL_NAMES.preflight, {
        name: tool.name,
      });
      expect(preflight.result?.isError, `preflight errored for ${tool.name}`).not.toBe(true);
      const preflightPayload = JSON.parse(preflight.result.content[0].text);
      expect(preflightPayload.toolName).toBe(tool.name);
      expect(typeof preflightPayload.ok).toBe("boolean");
      expect(typeof preflightPayload.readiness).toBe("string");
      expect(typeof preflightPayload.reasonCode).toBe("string");
    }
  }, 60000);

  it("executes safe local metadata tools live and keeps workspace-scoped tools fail-closed without project grants", async () => {
    const adminToken = await issueToken("all-tools-admin", [
      "mcp:tools",
      "mcp:tools:write",
      "mcp:tools:admin",
    ]);
    const adminSid = await initialize(adminToken);

    const safeLocalMetadataCalls: Array<{ name: string; args?: Record<string, unknown> }> = [
      { name: "superagent_server_health" },
      { name: "superagent_list_projects" },
      { name: "superagent_discover_projects", args: { limit: 5 } },
      { name: "superagent_list_project_access" },
      { name: "superagent_lan_capabilities" },
      { name: "superagent_tool_status" },
      { name: "superagent_tool_search", args: { query: "project", limit: 5 } },
    ];

    for (const spec of safeLocalMetadataCalls) {
      const res = await callToolJson(adminToken, adminSid, spec.name, spec.args ?? {});
      expect(res.error, `${spec.name} returned JSON-RPC error`).toBeUndefined();
      expect(res.result?.isError, `${spec.name} returned tool isError`).not.toBe(true);
    }

    // Even with admin OAuth scope, workspace-scoped and connection-gated tools remain blocked until an operator grants access.
    const gatedWorkspaceSamples: Array<{ name: string; args: Record<string, unknown> }> = [
      { name: "superagent_get_workspace", args: {} },
      { name: "superagent_media_capabilities", args: {} },
      { name: "superagent_core_status", args: {} },
      { name: "superagent_read_files", args: { files: [path.join(root, "nope.txt")] } },
      { name: "superagent_write_files", args: { files: [{ filePath: path.join(root, "nope.txt"), content: "x" }] } },
      { name: "superagent_exec_command", args: { command: "echo blocked" } },
      { name: "superagent_git_action", args: { action: "status" } },
      { name: "superagent_brain", args: { action: "create", sessionId: "sess_no_grant" } },
    ];

    for (const sample of gatedWorkspaceSamples) {
      const res = await callToolJson(adminToken, adminSid, MCP_GATEWAY_TOOL_NAMES.execute, {
        name: sample.name,
        arguments: sample.args,
      });
      const isBlocked = res.error !== undefined || res.result?.isError === true;
      expect(isBlocked, `${sample.name} must fail closed without grants`).toBe(true);
      const text = JSON.stringify(res);
      expect(text).toMatch(/PROJECT_GRANT_MISSING|HOST_POLICY_BLOCKED|Access denied by host permanent file policy/i);
    }
  }, 60000);
});

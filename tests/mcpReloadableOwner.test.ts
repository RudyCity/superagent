import { afterEach, describe, expect, it, vi } from "vitest";
import net from "node:net";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const mock = vi.hoisted(() => ({
  startQuickTunnel: vi.fn(async () => ({ publicUrl: "https://unchanged-mcp.trycloudflare.com" })),
  stopQuickTunnel: vi.fn(async () => true),
  getTunnelStatus: vi.fn(() => ({ isRunning: false })),
}));
vi.mock("../src/core/remoteAgent/cloudflareTunnel.js", async orig => {
  const actual = await orig<typeof import("../src/core/remoteAgent/cloudflareTunnel.js")>();
  return { ...actual, ...mock };
});
import { startReloadableMcpTunnelOwner } from "../src/core/runtime/mcpReloadableOwner.js";
import { getMcpStateFile, readMcpStateFile } from "../src/core/mcp/mcpTunnel.js";
import { readMcpOwnerLogs, mcpOwnerLogPath } from "../src/core/runtime/mcpOwnerLog.js";

const nextPort = async () => new Promise<number>((resolve, reject) => {
  const srv = net.createServer();
  srv.once("error", reject);
  srv.listen(0,"127.0.0.1", () => {
    const addr = srv.address();
    const port = typeof addr === "object" && addr ? addr.port : -1;
    srv.close(() => resolve(port));
  });
});

describe("MCP hot reload through durable ingress (no live external tunnel)", () => {
  afterEach(() => vi.clearAllMocks());

  it("keeps ingress URL, owner PID, Cloudflare process and existing MCP sessions across worker swap", async () => {
    const port = await nextPort();
    const nonce = "f".repeat(64);
    const cliEntry = path.resolve("dist/cli.js");
    expect(fs.existsSync(cliEntry)).toBe(true);
    const owner = await startReloadableMcpTunnelOwner({
      port, nonce, createdAt: Date.now(), cliEntry,
      authMode: "static-bearer", allowDangerous: false,
    });
    const local = "http://127.0.0.1:" + port;
    const control = async (operation: string, method = "GET") => {
      const r = await fetch(local + "/_internal/owner/" + operation, {
        method, headers: { Authorization: "Bearer " + nonce },
      });
      return { status: r.status, body: await r.json() };
    };
    let old: Client | null = null;
    let newest: Client | null = null;
    try {
      expect(owner.info.publicUrl).toBe("https://unchanged-mcp.trycloudflare.com/mcp");
      expect((await fetch(local + "/_internal/owner/status")).status).toBe(401);
      expect((await fetch(local + "/_internal/owner/reload", {
        method: "GET", headers: {Authorization:"Bearer " + nonce},
      })).status).toBe(404);
      expect((await fetch(local + "/not-an-mcp-route")).status).toBe(404);
      const state1 = (await control("status")).body;
      expect(state1.reloadable).toBe(true);
      expect(state1.backendGenerations).toBe(1);
      expect(readMcpStateFile(getMcpStateFile(port))?.reloadable).toBe(true);
      expect(readMcpOwnerLogs(port).map(e => e.event)).toContain("owner_started");
      const getClient = async () => {
        const c = new Client({name:"hot-reload-test", version:"1.0.0"}, {capabilities:{}});
        await c.connect(new StreamableHTTPClientTransport(new URL(local + "/mcp"), {
          requestInit: { headers: { Authorization: "Bearer " + owner.info.bearerToken } },
        }));
        return c;
      };
      old = await getClient();
      const oldTools = (await old.listTools()).tools.map(tool => tool.name);
      expect(oldTools).toContain("superagent_delegate_read_chat");
      const migrated = await control("reload", "POST");
      expect(migrated.status).toBe(200);
      expect(migrated.body.success).toBe(true);
      expect(migrated.body.pid).not.toBe(state1.backendPid);
      expect(migrated.body.url).toBe(owner.info.publicUrl);
      const state2 = (await control("status")).body;
      expect(state2.pid).toBe(state1.pid);
      expect(state2.startedAt).toBe(state1.startedAt);
      expect(state2.backendPid).not.toBe(state1.backendPid);
      expect(state2.backendGenerations).toBe(2);
      const snapshot = readMcpStateFile(getMcpStateFile(port));
      expect(snapshot?.backendPid).toBe(state2.backendPid);
      expect(snapshot?.backendGeneration).toBe(2);
      expect(snapshot?.lastReloadAt).toBeTypeOf("number");
      expect(readMcpOwnerLogs(port).map(e => e.event)).toEqual(expect.arrayContaining([
        "owner_started", "backend_reload_started", "backend_reload_succeeded",
      ]));
      expect(mock.startQuickTunnel).toHaveBeenCalledTimes(1);
      expect(mock.stopQuickTunnel).toHaveBeenCalledTimes(0);
      // The old session is routed by its original MCP session-id.
      expect((await old.listTools()).tools.map(t => t.name)).toContain("superagent_delegate_read_chat");
      newest = await getClient();
      expect((await newest.listTools()).tools.map(t => t.name)).toContain("superagent_delegate_read_chat");
      const privateResult = await fetch(local + "/_internal/owner/status", {
        headers: { Host: "unchanged-mcp.trycloudflare.com", Authorization: "Bearer " + nonce },
      });
      expect(privateResult.status).toBe(404);
      expect((await control("status")).body.backendGenerations).toBe(2);
      expect(fs.existsSync(getMcpStateFile(port))).toBe(true);
    } finally {
      await newest?.close().catch(() => undefined);
      await old?.close().catch(() => undefined);
      await owner.close();
      fs.rmSync(getMcpStateFile(port), { force:true });
      fs.rmSync(mcpOwnerLogPath(port), { force:true });
    }
    expect(mock.stopQuickTunnel).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(getMcpStateFile(port))).toBe(false);
  }, 70_000);

  it("rotates a truly single-use OAuth bootstrap code without touching tunnel, issuer, owner, backend or existing grants", async () => {
    const port = await nextPort();
    const nonce = "b".repeat(64);
    const owner = await startReloadableMcpTunnelOwner({
      port, nonce, createdAt:Date.now(), cliEntry:path.resolve("dist/cli.js"),
      authMode:"oauth", allowDangerous:false,
    });
    const root = "http://127.0.0.1:" + port;
    const control = (url: string) => fetch(root + "/_internal/owner/" + url, {
      method:"POST", headers:{Authorization:"Bearer " + nonce},
    });
    const clientId = "bootstrap-rotate-test";
    const redirect = "https://chatgpt.example/oauth/callback";
    let mintedAccessToken = "";
    try {
      const initial = owner.info.bootstrapCode;
      expect(initial).toMatch(/^[a-zA-Z0-9_-]{24,}$/);
      const before = await fetch(root + "/_internal/owner/status", {
        headers:{Authorization:"Bearer " + nonce},
      }).then(r=>r.json());
      expect((await control("bootstrap/rotate")).status).toBe(200);
      // A separate call is independently privileged and returns the *latest*
      // code one time. The earlier code is not accepted after rotation.
      const rotatedResponse = await control("bootstrap/rotate");
      expect(rotatedResponse.status).toBe(200);
      expect(rotatedResponse.headers.get("cache-control")).toBe("no-store");
      const rotated = await rotatedResponse.json();
      expect(rotated.code).toMatch(/^[a-zA-Z0-9_-]{24,}$/);
      expect(rotated.code).not.toBe(initial);
      expect(rotated.url).toBe(owner.info.publicUrl);
      expect(rotated.backendPid).toBe(before.backendPid);
      const after = await fetch(root + "/_internal/owner/status", {
        headers:{Authorization:"Bearer " + nonce},
      }).then(r=>r.json());
      expect(after.pid).toBe(before.pid);
      expect(after.backendPid).toBe(before.backendPid);
      expect(mock.startQuickTunnel).toHaveBeenCalledTimes(1);
      expect(mock.stopQuickTunnel).toHaveBeenCalledTimes(0);
      expect((await fetch(root + "/_internal/owner/bootstrap/rotate",{
        method:"POST",
      })).status).toBe(401);
      expect((await fetch(root + "/_internal/owner/bootstrap/rotate",{
        method:"POST", headers:{Host:"unchanged-mcp.trycloudflare.com", Authorization:"Bearer "+nonce},
      })).status).toBe(404);
      async function beginApproval() {
        const verifier = crypto.randomBytes(32).toString("base64url");
        const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
        const query = new URLSearchParams({
          client_id:clientId, redirect_uri:redirect, code_challenge:challenge,
          code_challenge_method:"S256", scope:"mcp:tools",
        });
        const page = await fetch(root + "/oauth/authorize?" + query);
        expect(page.status).toBe(200);
        const html = await page.text();
        const id = /name="request_id" value="([^"]+)"/.exec(html)?.[1];
        expect(id).toBeTruthy();
        return {id:id!,verifier};
      }
      const approve = async (id: string, code:string) => fetch(root + "/oauth/authorize",{
        method:"POST", redirect:"manual",
        headers:{"Content-Type":"application/x-www-form-urlencoded"},
        body:new URLSearchParams({request_id:id,bootstrap_code:code,decision:"approve"}),
      });

      const expired = await beginApproval();
      expect((await approve(expired.id, initial!)).status).toBe(403);
      const valid = await beginApproval();
      const authorized = await approve(valid.id, rotated.code);
      expect(authorized.status).toBe(302);
      const authorizationCode = new URL(authorized.headers.get("location")!).searchParams.get("code");
      expect(authorizationCode).toBeTruthy();
      const exchange = await fetch(root + "/oauth/token",{
        method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},
        body:new URLSearchParams({
          grant_type:"authorization_code", code:authorizationCode!,
          client_id:clientId, redirect_uri:redirect, code_verifier:valid.verifier,
        }),
      });
      expect(exchange.status).toBe(200);
      const minted = await exchange.json();
      mintedAccessToken = minted.access_token;
      expect(mintedAccessToken).toBeTruthy();
      const replay = await beginApproval();
      expect((await approve(replay.id, rotated.code)).status).toBe(403);

      // A reload must NOT resurrect a consumed approval code.
      for(let retry=0;retry<30;retry++){
        if(readMcpOwnerLogs(port).some(e=>e.event==="bootstrap_consumed")) break;
        await new Promise(resolve=>setTimeout(resolve,20));
      }
      expect(readMcpOwnerLogs(port).map(e=>e.event)).toContain("bootstrap_consumed");
      if (owner.info.oauthStatePersistent) {
        const swapped = await control("reload");
        expect(swapped.status).toBe(200);
        const yetAnother = await beginApproval();
        expect((await approve(yetAnother.id, rotated.code)).status).toBe(403);
      }

      const againResponse = await control("bootstrap/rotate");
      expect(againResponse.status).toBe(200);
      const again = await againResponse.json();
      expect(again.code).not.toBe(rotated.code);
      // The original OAuth token remains valid even after bootstrap changes.
      const tokenCheck = await fetch(root + "/mcp",{
        method:"GET",headers:{Authorization:"Bearer " + mintedAccessToken},
      });
      expect(tokenCheck.status).not.toBe(401);
      const journal = fs.readFileSync(mcpOwnerLogPath(port),"utf8");
      expect(journal).toContain("bootstrap_rotated");
      expect(journal).toContain("bootstrap_consumed");
      expect(journal).not.toContain(rotated.code);
      expect(journal).not.toContain(again.code);
      expect(fs.readFileSync(getMcpStateFile(port),"utf8")).not.toContain(again.code);
    } finally {
      await owner.close();
      fs.rmSync(getMcpStateFile(port),{force:true});
      fs.rmSync(mcpOwnerLogPath(port),{force:true});
    }
  },70_000);

  it("keeps OAuth issuer constant, or refuses reload if OAuth persistence is unavailable", async () => {
    const port = await nextPort();
    const nonce = "e".repeat(64);
    const owner = await startReloadableMcpTunnelOwner({
      port, nonce, createdAt: Date.now(),
      cliEntry: path.resolve("dist/cli.js"),
      authMode: "oauth", allowDangerous: true,
    });
    const root = "http://127.0.0.1:" + port;
    try {
      const issuer = owner.info.publicUrl.replace(/\/mcp$/, "");
      const discovery = await fetch(root + "/.well-known/oauth-authorization-server");
      expect(discovery.status).toBe(200);
      const metadata = await discovery.json();
      expect(metadata.issuer).toBe(issuer);
      const first = await fetch(root + "/_internal/owner/status", {
        headers: { Authorization: "Bearer " + nonce },
      }).then(r=>r.json());
      const reload = await fetch(root + "/_internal/owner/reload", {
        method: "POST", headers: { Authorization: "Bearer " + nonce },
      });
      if (owner.info.oauthStatePersistent) {
        expect(reload.status).toBe(200);
        const reply = await reload.json();
        expect(reply.url).toBe(owner.info.publicUrl);
        expect(reply.pid).not.toBe(first.backendPid);
      } else {
        expect(reload.status).toBe(409);
        const reply = await reload.json();
        expect(reply.error).toContain("OAUTH_NOT_PERSISTENT");
        const stillServing = await fetch(root + "/_internal/owner/status", {
          headers: { Authorization: "Bearer " + nonce },
        }).then(r=>r.json());
        expect(stillServing.backendPid).toBe(first.backendPid);
      }
      const after = await fetch(root + "/.well-known/oauth-authorization-server");
      expect(after.status).toBe(200);
      expect((await after.json()).issuer).toBe(issuer);
    } finally {
      await owner.close();
      fs.rmSync(getMcpStateFile(port), {force:true});
      fs.rmSync(mcpOwnerLogPath(port), {force:true});
    }
  }, 70_000);
});

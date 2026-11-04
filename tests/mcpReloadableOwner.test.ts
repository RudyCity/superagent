import { afterEach, describe, expect, it, vi } from "vitest";
import net from "node:net";
import path from "node:path";
import fs from "node:fs";
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
import { getMcpStateFile } from "../src/core/mcp/mcpTunnel.js";

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
    }
    expect(mock.stopQuickTunnel).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(getMcpStateFile(port))).toBe(false);
  }, 70_000);

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
    }
  }, 70_000);
});

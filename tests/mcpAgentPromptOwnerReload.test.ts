import { afterEach, describe, expect, it, vi } from "vitest";
import net from "node:net";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const mock = vi.hoisted(() => ({
  startQuickTunnel: vi.fn(async () => ({ publicUrl: "https://prompt-reload.trycloudflare.com" })),
  stopQuickTunnel: vi.fn(async () => true),
  getTunnelStatus: vi.fn(() => ({ isRunning: false })),
}));
vi.mock("../src/core/remoteAgent/cloudflareTunnel.js", async orig => {
  const actual = await orig<typeof import("../src/core/remoteAgent/cloudflareTunnel.js")>();
  return { ...actual, ...mock };
});
import { startReloadableMcpTunnelOwner } from "../src/core/runtime/mcpReloadableOwner.js";
import { getMcpStateFile } from "../src/core/mcp/mcpTunnel.js";
import { readMcpOwnerLogs, mcpOwnerLogPath } from "../src/core/runtime/mcpOwnerLog.js";
import { saveMcpAgentPrompt } from "../src/core/mcp/mcpAgentPrompt.js";

const nextPort = async () => new Promise<number>((resolve, reject) => {
  const srv = net.createServer();
  srv.once("error", reject);
  srv.listen(0, "127.0.0.1", () => {
    const addr = srv.address();
    const port = typeof addr === "object" && addr ? addr.port : -1;
    srv.close(() => resolve(port));
  });
});

describe("operator prompt on a real reloaded MCP owner", () => {
  afterEach(() => vi.clearAllMocks());

  it("closes the live session and advertises the saved prompt at the next initialize", async () => {
    const priorConfig = process.env.SUPERAGENT_CONFIG_DIR;
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "sa-prompt-reload-"));
    process.env.SUPERAGENT_CONFIG_DIR = sandbox;
    const port = await nextPort();
    const nonce = "a".repeat(64);
    const owner = await startReloadableMcpTunnelOwner({
      port, nonce, createdAt: Date.now(), cliEntry: path.resolve("dist/cli.js"),
      authMode: "static-bearer", allowDangerous: false, toolExposure: "gateway",
    });
    const root = "http://127.0.0.1:" + port;
    const status = async () => fetch(root + "/_internal/owner/status", {
      headers: { Authorization: "Bearer " + nonce },
    }).then(response => response.json());
    const connect = async (name: string) => {
      const client = new Client({ name, version: "1.0.0" }, { capabilities: {} });
      await client.connect(new StreamableHTTPClientTransport(new URL(root + "/mcp"), {
        requestInit: { headers: { Authorization: "Bearer " + owner.info.bearerToken } },
      }));
      return client;
    };
    let before: Client | undefined;
    let after: Client | undefined;
    try {
      before = await connect("prompt-reload-before");
      expect(before.getInstructions() ?? "").toContain("SUPERAGENT MCP AGENTIC INSTRUCTION PROTOCOL");
      expect(before.getInstructions() ?? "").not.toContain("## OPERATOR SESSION PROMPT");

      const saved = saveMcpAgentPrompt("Before writing files, read the workspace status tool.");
      expect(saved.length).toBeGreaterThan(0);

      const initial = await status();
      const originalUrl = owner.info.publicUrl;
      const apply = await fetch(root + "/_internal/owner/configure", {
        method: "POST",
        headers: { Authorization: "Bearer " + nonce, "Content-Type": "application/json" },
        body: JSON.stringify({
          toolMode: "safe", toolExposure: "gateway",
          expectedBackendPid: initial.backendPid, expectedPublicUrl: originalUrl,
        }),
      });
      expect(apply.status, JSON.stringify(await apply.clone().json())).toBe(200);
      const applied = await apply.json();
      expect(applied).toMatchObject({
        success: true, url: originalUrl, toolMode: "safe", toolExposure: "gateway",
      });
      expect(applied.sessionsClosed).toBeGreaterThanOrEqual(1);
      expect(applied.backendPid).not.toBe(initial.backendPid);

      const afterState = await status();
      expect(afterState).toMatchObject({
        pid: initial.pid, startedAt: initial.startedAt, publicUrl: originalUrl, activeSessions: 0,
      });
      expect(afterState.backendPid).toBe(applied.backendPid);
      await expect(before.listTools()).rejects.toThrow();
      expect(readMcpOwnerLogs(port).map(entry => entry.event)).toEqual(expect.arrayContaining([
        "owner_started", "backend_reload_started", "backend_reload_succeeded",
      ]));

      after = await connect("prompt-reload-after");
      const instructions = after.getInstructions() ?? "";
      expect(instructions).toContain("SUPERAGENT MCP AGENTIC INSTRUCTION PROTOCOL");
      expect(instructions).toContain("## OPERATOR SESSION PROMPT");
      expect(instructions).toContain("Before writing files, read the workspace status tool.");
      expect(instructions).toContain("never grants permissions");
    } finally {
      await after?.close().catch(() => undefined);
      await before?.close().catch(() => undefined);
      await owner.close();
      fs.rmSync(getMcpStateFile(port), { force: true });
      fs.rmSync(mcpOwnerLogPath(port), { force: true });
      fs.rmSync(sandbox, { recursive: true, force: true });
      if (priorConfig === undefined) delete process.env.SUPERAGENT_CONFIG_DIR;
      else process.env.SUPERAGENT_CONFIG_DIR = priorConfig;
    }
    expect(mock.stopQuickTunnel).toHaveBeenCalledTimes(1);
  }, 70_000);
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const mocks = vi.hoisted(() => ({
  startQuickTunnel: vi.fn(),
  stopQuickTunnel: vi.fn(),
  getTunnelStatus: vi.fn(),
  claimTunnelServiceKind: vi.fn(),
  startMcpHttpServer: vi.fn(),
  generateMcpBearerToken: vi.fn(() => "test-mcp-bearer"),
  getDefaultSafeTools: vi.fn(() => []),
}));

vi.mock("../src/core/remoteAgent/cloudflareTunnel.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/remoteAgent/cloudflareTunnel.js")>();
  return {
    ...actual,
    startQuickTunnel: mocks.startQuickTunnel,
    stopQuickTunnel: mocks.stopQuickTunnel,
    getTunnelStatus: mocks.getTunnelStatus,
    claimTunnelServiceKind: mocks.claimTunnelServiceKind,
  };
});

vi.mock("../src/core/mcp/mcpHttpTransport.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/mcp/mcpHttpTransport.js")>();
  return {
    ...actual,
    startMcpHttpServer: mocks.startMcpHttpServer,
    generateMcpBearerToken: mocks.generateMcpBearerToken,
    getDefaultSafeTools: mocks.getDefaultSafeTools,
  };
});

import { getMcpStateFile, startMcpTunnel, stopMcpTunnel } from "../src/core/mcp/mcpTunnel.js";

function tunnelMetadata(port: number, serviceKind: "mcp-http" | "muse-websocket" = "mcp-http") {
  return {
    pid: process.pid,
    port,
    serviceKind,
    publicUrl: `https://fixture-${port}.trycloudflare.com`,
    ...(serviceKind === "muse-websocket" ? { wssUrl: `wss://fixture-${port}.trycloudflare.com/muse` } : {}),
    localUrl: `http://127.0.0.1:${port}`,
    startedAt: Date.now(),
    workspace: process.cwd(),
  };
}

describe("MCP tunnel startup ownership and rollback", () => {
  let tempHome: string;
  let homedirSpy: { mockRestore(): void };

  beforeEach(() => {
    vi.clearAllMocks();
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-tunnel-lifecycle-"));
    homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(tempHome);
    mocks.getTunnelStatus.mockReturnValue({ isRunning: false });
    mocks.startQuickTunnel.mockImplementation(async ({ port, serviceKind }: { port: number; serviceKind: "mcp-http" | "muse-websocket" }) =>
      tunnelMetadata(port, serviceKind));
    mocks.claimTunnelServiceKind.mockImplementation((port: number, serviceKind: "mcp-http" | "muse-websocket") =>
      tunnelMetadata(port, serviceKind));
    mocks.stopQuickTunnel.mockResolvedValue(true);
    mocks.startMcpHttpServer.mockRejectedValue(new Error("EADDRINUSE: test bind conflict"));
  });

  afterEach(() => {
    vi.clearAllMocks();
    homedirSpy?.mockRestore();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it("rolls back only the new MCP tunnel when local HTTP server startup fails", async () => {
    await expect(startMcpTunnel({ port: 19327 })).rejects.toThrow("EADDRINUSE");

    expect(mocks.startQuickTunnel).toHaveBeenCalledWith({
      port: 19327,
      host: "127.0.0.1",
      path: "",
      serviceKind: "mcp-http",
    });
    expect(mocks.stopQuickTunnel).toHaveBeenCalledWith(19327, "mcp-http");
  });

  it("does not stop a reused MCP tunnel when local HTTP server startup fails", async () => {
    mocks.getTunnelStatus.mockReturnValue({
      isRunning: true,
      serviceKind: "mcp-http",
      publicUrl: "https://existing-mcp.trycloudflare.com",
      localUrl: "http://127.0.0.1:19328",
      port: 19328,
    });

    await expect(startMcpTunnel({ port: 19328 })).rejects.toThrow("EADDRINUSE");

    expect(mocks.startQuickTunnel).not.toHaveBeenCalled();
    expect(mocks.stopQuickTunnel).not.toHaveBeenCalled();
  });

  it("refuses to repurpose a known Muse tunnel as MCP", async () => {
    mocks.getTunnelStatus.mockReturnValue({
      isRunning: true,
      ...tunnelMetadata(19329, "muse-websocket"),
    });

    await expect(startMcpTunnel({ port: 19329 })).rejects.toThrow("already has a muse-websocket tunnel");

    expect(mocks.startQuickTunnel).not.toHaveBeenCalled();
    expect(mocks.startMcpHttpServer).not.toHaveBeenCalled();
    expect(mocks.stopQuickTunnel).not.toHaveBeenCalled();
  });

  it("rejects a tunnel whose recorded local target points at another port", async () => {
    mocks.getTunnelStatus.mockReturnValue({
      isRunning: true,
      serviceKind: "mcp-http",
      publicUrl: "https://misdirected-mcp.trycloudflare.com",
      localUrl: "http://127.0.0.1:19330",
      port: 19329,
    });

    await expect(startMcpTunnel({ port: 19329 })).rejects.toThrow("forwards to http://127.0.0.1:19330");
    expect(mocks.startQuickTunnel).not.toHaveBeenCalled();
    expect(mocks.startMcpHttpServer).not.toHaveBeenCalled();
    expect(mocks.stopQuickTunnel).not.toHaveBeenCalled();
  });

  it("does not stop a reused MCP tunnel when its local HTTP server stops", async () => {
    const handle = { url: "http://127.0.0.1:19330/mcp", close: vi.fn().mockResolvedValue(undefined) };
    mocks.getTunnelStatus.mockReturnValue({
      isRunning: true,
      serviceKind: "mcp-http",
      publicUrl: "https://shared-mcp.trycloudflare.com",
      localUrl: "http://127.0.0.1:19330",
      port: 19330,
    });
    mocks.startMcpHttpServer.mockResolvedValue(handle);

    await startMcpTunnel({ port: 19330 });
    await stopMcpTunnel(19330);

    expect(mocks.startQuickTunnel).not.toHaveBeenCalled();
    expect(handle.close).toHaveBeenCalledOnce();
    expect(mocks.stopQuickTunnel).not.toHaveBeenCalled();
  });

  it("does not stop or erase MCP resources recorded for another process", async () => {
    const foreignState = {
      port: 19331,
      pid: process.pid + 100000,
      publicUrl: "https://foreign-mcp.trycloudflare.com/mcp",
      localUrl: "http://127.0.0.1:19331/mcp",
      toolMode: "safe",
      startedAt: Date.now(),
      workspace: process.cwd(),
      authMode: "static-bearer",
    };
    const stateFile = getMcpStateFile(19331);
    fs.writeFileSync(stateFile, JSON.stringify(foreignState), "utf-8");

    await stopMcpTunnel(19331);

    expect(mocks.stopQuickTunnel).not.toHaveBeenCalled();
    expect(fs.existsSync(stateFile)).toBe(true);
  });

  it("stops an MCP tunnel created by the same server instance", async () => {
    const handle = { url: "http://127.0.0.1:19332/mcp", close: vi.fn().mockResolvedValue(undefined) };
    mocks.getTunnelStatus.mockReturnValue({ isRunning: false });
    mocks.startMcpHttpServer.mockResolvedValue(handle);

    await startMcpTunnel({ port: 19332 });
    await stopMcpTunnel(19332);

    expect(mocks.startQuickTunnel).toHaveBeenCalledOnce();
    expect(mocks.stopQuickTunnel).toHaveBeenCalledWith(19332, "mcp-http");
    expect(handle.close).toHaveBeenCalledOnce();
  });
});

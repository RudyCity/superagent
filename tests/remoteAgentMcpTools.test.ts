import { beforeEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({
  config: {
    botToken: "123456:telegram-test-token-not-real",
    groupId: "-100123456789",
    museBotId: "987654321",
    wsPort: 9225,
    wsHost: "127.0.0.1",
    wsPath: "/muse",
    wsToken: "muse-test-ws-token-not-real",
    wsMode: "server",
    transport: "websocket",
    workspaces: ["C:/workspace"],
  } as Record<string, any>,
  tunnelStatus: { isRunning: false } as Record<string, any>,
  watcherActive: false,
  watcher: null as any,
  startOptions: null as any,
  stopCalls: 0,
  stopOwnedCalls: 0,
  sendEnvelope: vi.fn(),
}));

vi.mock("../src/core/remoteAgent/config.js", () => ({
  loadRemoteAgentConfig: vi.fn(() => ({ ...testState.config })),
  updateRemoteAgentConfig: vi.fn((patch: Record<string, unknown>) => {
    Object.assign(testState.config, patch);
    return { ...testState.config };
  }),
  generateSecureWsToken: vi.fn(() => "generated-ws-token-never-return-this"),
  getWatchedWorkspaces: vi.fn(() => ["C:/workspace"]),
}));

vi.mock("../src/core/remoteAgent/cloudflareTunnel.js", () => ({
  getTunnelStatus: vi.fn(() => ({ ...testState.tunnelStatus })),
  isSameTunnelTarget: vi.fn((actual: string, expected: string) => actual === expected),
}));

vi.mock("../src/core/remoteAgent/museWatcherRegistry.js", () => ({
  getMuseWatcher: vi.fn(() => testState.watcher),
  isMuseWatcherActive: vi.fn(() => testState.watcherActive),
  startMuseWatcher: vi.fn(async (options: any) => {
    testState.startOptions = options;
    testState.watcherActive = true;
    testState.watcher = {
      getStats: () => ({
        isRunning: true,
        tunnel: true,
        tunnelUrl: "wss://muse-test.trycloudflare.com/muse",
        tunnelPort: 9225,
        museConnected: false,
        workspaces: ["C:/workspace"],
      }),
    };
    testState.tunnelStatus = {
      isRunning: true,
      serviceKind: "muse-websocket",
      publicUrl: "https://muse-test.trycloudflare.com",
      wssUrl: "wss://muse-test.trycloudflare.com/muse",
      localUrl: "http://127.0.0.1:9225",
      port: 9225,
    };
    return testState.watcher;
  }),
  stopMuseWatcher: vi.fn(async () => {
    testState.stopCalls += 1;
    testState.watcherActive = false;
    testState.watcher = null;
    testState.tunnelStatus = { isRunning: false };
    return true;
  }),
}));

vi.mock("../src/core/remoteAgent/museWatcherTunnel.js", () => ({
  stopOwnedMuseTunnel: vi.fn(async () => {
    testState.stopOwnedCalls += 1;
    testState.tunnelStatus = { isRunning: false };
    return true;
  }),
}));

vi.mock("../src/core/remoteAgent/museClient.js", () => ({
  MuseClient: class {
    sendEnvelope(...args: unknown[]) {
      return testState.sendEnvelope(...args);
    }
  },
}));

const {
  handleMuseTunnelStart,
  handleMuseTunnelRestart,
  handleTelegramSendToMuse,
  handleMuseChat,
  REMOTE_AGENT_MCP_TOOL_CLASSIFICATIONS,
} = await import("../src/core/mcp/tools/remoteAgentMcpTools.js");

describe("Remote-agent MCP tools", () => {
  beforeEach(() => {
    Object.assign(testState.config, {
      botToken: "123456:telegram-test-token-not-real",
      groupId: "-100123456789",
      museBotId: "987654321",
      wsPort: 9225,
      wsHost: "127.0.0.1",
      wsPath: "/muse",
      wsToken: "muse-test-ws-token-not-real",
      wsMode: "server",
      transport: "websocket",
      workspaces: ["C:/workspace"],
    });
    testState.tunnelStatus = { isRunning: false };
    testState.watcherActive = false;
    testState.watcher = null;
    testState.startOptions = null;
    testState.stopCalls = 0;
    testState.stopOwnedCalls = 0;
    testState.sendEnvelope.mockReset();
    testState.sendEnvelope.mockResolvedValue(true);
  });

  it("classifies all state-changing remote-agent tools as dangerous", () => {
    expect(REMOTE_AGENT_MCP_TOOL_CLASSIFICATIONS).toEqual({
      superagent_muse_tunnel_start: "dangerous",
      superagent_muse_tunnel_restart: "dangerous",
      superagent_telegram_send_to_muse: "dangerous",
      superagent_muse_chat: "dangerous",
    });
  });

  it("starts the Muse tunnel without returning the WebSocket token", async () => {
    delete testState.config.wsToken;

    const result = await handleMuseTunnelStart({});
    const text = result.content[0].text;

    expect(result.isError).toBeUndefined();
    expect(text).toContain('"state": "started"');
    expect(text).toContain("wss://muse-test.trycloudflare.com/muse");
    expect(text).not.toContain("generated-ws-token-never-return-this");
    expect(text).not.toContain("muse-test-ws-token-not-real");
    expect(testState.config.wsToken).toBe("generated-ws-token-never-return-this");
    expect(testState.startOptions).toMatchObject({
      transportType: "websocket",
      tunnel: true,
      wsPort: 9225,
      announce: false,
    });
  });

  it("does not start a duplicate watcher for a tunnel already managed by another runtime", async () => {
    testState.tunnelStatus = {
      isRunning: true,
      serviceKind: "muse-websocket",
      publicUrl: "https://muse-test.trycloudflare.com",
      wssUrl: "wss://muse-test.trycloudflare.com/muse",
      localUrl: "http://127.0.0.1:9225",
      port: 9225,
      workspaces: ["C:/workspace"],
    };

    const result = await handleMuseTunnelStart({});

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('"state": "already_running"');
    expect(result.content[0].text).toContain('"watcherActive": false');
    expect(testState.startOptions).toBeNull();
  });

  it("refuses to start over a non-Muse tunnel", async () => {
    testState.tunnelStatus = {
      isRunning: true,
      serviceKind: "mcp-http",
      localUrl: "http://127.0.0.1:9225",
      publicUrl: "https://mcp-test.trycloudflare.com",
    };

    const result = await handleMuseTunnelStart({});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Refusing to stop or reuse it");
    expect(testState.startOptions).toBeNull();
  });

  it("restarts only the verified Muse tunnel", async () => {
    testState.watcherActive = true;
    testState.watcher = {
      getStats: () => ({
        isRunning: true,
        tunnel: true,
        tunnelUrl: "wss://muse-old.trycloudflare.com/muse",
        museConnected: false,
        workspaces: ["C:/workspace"],
      }),
    };
    testState.tunnelStatus = {
      isRunning: true,
      serviceKind: "muse-websocket",
      publicUrl: "https://muse-old.trycloudflare.com",
      wssUrl: "wss://muse-old.trycloudflare.com/muse",
      localUrl: "http://127.0.0.1:9225",
      port: 9225,
    };

    const result = await handleMuseTunnelRestart({});

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('"state": "restarted"');
    expect(testState.stopCalls).toBe(1);
    expect(testState.startOptions).toMatchObject({ transportType: "websocket", tunnel: true, wsPort: 9225 });
    expect(result.content[0].text).not.toContain("muse-test-ws-token-not-real");
  });

  it("does not stop a non-Muse tunnel or mutate transport config", async () => {
    testState.config.transport = "telegram";
    testState.tunnelStatus = {
      isRunning: true,
      serviceKind: "mcp-http",
      localUrl: "http://127.0.0.1:9225",
      publicUrl: "https://mcp-test.trycloudflare.com",
    };

    const result = await handleMuseTunnelRestart({});

    expect(result.isError).toBe(true);
    expect(testState.stopCalls).toBe(0);
    expect(testState.stopOwnedCalls).toBe(0);
    expect(testState.startOptions).toBeNull();
    expect(testState.config.transport).toBe("telegram");
  });

  it("sends a chat envelope through the configured Muse Telegram transport", async () => {
    const result = await handleTelegramSendToMuse({ text: "Please check the remote tunnel." });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('"state": "accepted_by_telegram"');
    expect(testState.sendEnvelope).toHaveBeenCalledTimes(1);
    const [envelope, groupId] = testState.sendEnvelope.mock.calls[0];
    expect(envelope).toMatchObject({
      v: 1,
      kind: "chat",
      text: "Please check the remote tunnel.",
    });
    expect(envelope.id).toMatch(/^mcp-chat-/);
    expect(groupId).toBe("-100123456789");
    expect(result.content[0].text).not.toContain("telegram-test-token-not-real");
  });

  it("waits for a correlated reply through direct MCP-to-Muse WebSocket chat", async () => {
    const requestChat = vi.fn(async (text: string, timeoutMs: number) => ({
      requestId: "mcp-muse-chat-request",
      responseId: "muse-chat-reply",
      reply: "Halo juga dari Muse.",
    }));
    testState.watcherActive = true;
    testState.watcher = {
      getTransport: () => ({ type: "websocket", isConnected: () => true }),
      requestChat,
    };

    const result = await handleMuseChat({ text: "Halo Muse", timeoutMs: 5000 });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('"state": "reply_received"');
    expect(result.content[0].text).toContain("Halo juga dari Muse.");
    expect(requestChat).toHaveBeenCalledWith("Halo Muse", 5000);
  });

  it("requires a connected Muse WebSocket for direct chat", async () => {
    testState.watcherActive = true;
    testState.watcher = {
      getTransport: () => ({ type: "websocket", isConnected: () => false }),
    };

    const result = await handleMuseChat({ text: "Halo Muse" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not connected");
  });

  it("does not attempt to send when Muse Telegram is not configured", async () => {
    delete testState.config.botToken;
    delete testState.config.groupId;
    delete testState.config.museBotId;

    const result = await handleTelegramSendToMuse({ text: "Hello Muse" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not configured");
    expect(testState.sendEnvelope).not.toHaveBeenCalled();
  });

  it("reports Telegram rejection and bounds messages", async () => {
    testState.sendEnvelope.mockResolvedValue(false);

    const rejected = await handleTelegramSendToMuse({ text: "Hello Muse" });
    expect(rejected.isError).toBe(true);
    expect(rejected.content[0].text).toContain("did not confirm");

    testState.sendEnvelope.mockClear();
    const oversized = await handleTelegramSendToMuse({ text: "x".repeat(12_001) });
    expect(oversized.isError).toBe(true);
    expect(oversized.content[0].text).toContain("12000-character limit");
    expect(testState.sendEnvelope).not.toHaveBeenCalled();
  });
});

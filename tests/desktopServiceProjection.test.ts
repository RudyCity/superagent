import { describe, it, expect } from "vitest";
import { projectDesktopServices } from "../src/core/runtime/desktopServiceProjection.js";

describe("desktop runtime services projection", () => {
  it("shows Core-local status but never exposes tokens, URLs, bot identities or task IDs", () => {
    const result = projectDesktopServices({
      timestamp: 123,
      anyActive: true,
      channelHosts: [],
      tunnel: {
        active: true, count: 1, watcherActive: true, watcherTransport: "telegram",
        museConnected: true, tunnels: [{
          publicUrl: "https://secret-link.example", token: "sensitive-secret",
        } as any],
      },
      telegram: {
        active: true, museWatcherActive: true, telegramFallbackActive: false,
        gatewayEnabled: true, gatewayConfigured: true,
        museWatcherGroupId: "private-group",
        museWatcherBotId: "private-bot",
        gatewayStats: { messagesReceived: 1, messagesSent: 0, errors: 0 },
      },
      mcp: {
        active: true, tunnelServerCount: 1, tunnelServers: [],
        clientServerCount: 2, clientServers: [
          { name: "secret-name", status: "connected", toolCount: 1, tools: ["secret-tool"] },
          { name: "other", status: "disconnected", toolCount: 0, tools: [] },
        ],
      },
    } as any);
    expect(result.muse).toMatchObject({ watcherActive: true, transport: "telegram", connected: true });
    expect(result.mcp.connectedClientCount).toBe(1);
    expect(result.scope).toBe("this-core-process");
    const serialized = JSON.stringify(result);
    for (const secret of ["secret-link", "sensitive-secret", "private-group", "private-bot", "secret-name", "secret-tool"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("does not treat an idle process as an authenticated Muse connection", () => {
    const projected = projectDesktopServices({
      timestamp: 0, anyActive: false,
      tunnel: { active: false, count: 0, watcherActive: true, museConnected: false, tunnels: [] },
      telegram: { active: false, museWatcherActive: false, telegramFallbackActive: false,
        gatewayEnabled: false, gatewayConfigured: false, gatewayStats: { messagesReceived: 0, messagesSent: 0, errors: 0 } },
      mcp: { active: false, tunnelServerCount: 0, tunnelServers: [], clientServerCount: 0, clientServers: [] },
    } as any);
    expect(projected.muse.watcherActive).toBe(true);
    expect(projected.muse.connected).toBe(false);
  });
});

/**
 * Browser Runtime Health Check Diagnostics Unit Tests (Milestone M1)
 *
 * Validates CDP endpoint health probing (/json/version, /json/list),
 * browser identity fingerprint generation, target counting, and stopped/unhealthy status detection.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import {
  BrowserProcessManager,
  resetBrowserProcessManagerForTest,
} from "../src/core/browserRuntime/browserProcessManager.js";

describe("Browser Runtime Health Diagnostics", () => {
  let manager: BrowserProcessManager;
  let mockServer: http.Server | null = null;
  const mockPort = 19222;

  beforeEach(() => {
    resetBrowserProcessManagerForTest();
    manager = new BrowserProcessManager();
  });

  afterEach(async () => {
    resetBrowserProcessManagerForTest();
    if (mockServer) {
      await new Promise<void>((resolve) => mockServer!.close(() => resolve()));
      mockServer = null;
    }
  });

  it("reports stopped status when port is not listening", async () => {
    const health = await manager.checkHealth(19999);
    expect(health.status).toBe("stopped");
    expect(health.listening).toBe(false);
    expect(health.port).toBe(19999);
  });

  it("reports healthy status with version and targets from responsive CDP endpoint", async () => {
    mockServer = http.createServer((req, res) => {
      if (req.url === "/json/version") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            Browser: "Chrome/120.0.6099.109",
            "Protocol-Version": "1.3",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
            webSocketDebuggerUrl: `ws://127.0.0.1:${mockPort}/devtools/browser/11111111-2222-3333-4444-555555555555`,
          })
        );
      } else if (req.url === "/json/list") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify([
            { id: "tab-1", type: "page", title: "Tab 1", url: "https://example.com" },
            { id: "tab-2", type: "page", title: "Tab 2", url: "https://superagent.local" },
          ])
        );
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve) => mockServer!.listen(mockPort, "127.0.0.1", () => resolve()));

    const health = await manager.checkHealth(mockPort);
    expect(health.status).toBe("healthy");
    expect(health.listening).toBe(true);
    expect(health.port).toBe(mockPort);
    expect(health.browserVersion).toBe("Chrome/120.0.6099.109");
    expect(health.protocolVersion).toBe("1.3");
    expect(health.targetCount).toBe(2);
    expect(health.browserFingerprint).toBeDefined();
    expect(health.browserFingerprint?.length).toBe(64);
  });

  it("reports unhealthy status when /json/version returns an error", async () => {
    mockServer = http.createServer((req, res) => {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal Chrome Error");
    });

    await new Promise<void>((resolve) => mockServer!.listen(mockPort, "127.0.0.1", () => resolve()));

    const health = await manager.checkHealth(mockPort);
    expect(health.status).toBe("unhealthy");
    expect(health.listening).toBe(true);
    expect(health.error).toContain("HTTP 500");
  });
});

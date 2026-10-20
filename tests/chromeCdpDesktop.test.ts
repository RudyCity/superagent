import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { discoverDesktopTargets } from "../src/core/tools/chromeCdpDesktop.js";

describe("Electron/TLine local CDP discovery", () => {
  it("probes only explicit loopback ports and labels probable TLine targets without asserting app identity", async () => {
    const server = createServer((req, res) => {
      if (req.url === "/json/list") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify([{
          id: "tab-tline", type: "page", title: "TLine Workspace",
          url: "file:///tline/index.html",
          webSocketDebuggerUrl: "ws://127.0.0.1:12345/devtools/page/tab-tline",
        }]));
      } else { res.statusCode = 404; res.end(); }
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as any).port as number;
      const result = await discoverDesktopTargets(String(port));
      expect(result.probes).toHaveLength(1);
      expect(result.probes[0].available).toBe(true);
      expect(result.probes[0].applicationHint).toBe("possible-tline-electron");
      expect(result.probes[0].targets[0].id).toBe("tab-tline");
      expect(result.note).toMatch(/debug_port/);
    } finally { await new Promise<void>((r) => server.close(() => r())); }
  });

  it("falls back to WebSocket discovery when Electron endpoint returns HTTP 426", async () => {
    const server = createServer((_req, res) => { res.statusCode = 426; res.end(); });
    const wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", (req, socket, head) => {
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.send(JSON.stringify([{
          id: "electron-page", type: "page", title: "TLine workspace",
          url: "file:///app/index.html", webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/electron-page",
        }]));
      });
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as any).port as number;
      const result = await discoverDesktopTargets(String(port));
      expect(result.probes[0].available).toBe(true);
      expect(result.probes[0].targets[0].id).toBe("electron-page");
    } finally {
      await new Promise<void>((r) => wss.close(() => r()));
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("rejects wide port scans, non-numeric ports and privileged ports", async () => {
    await expect(discoverDesktopTargets("1,2,3,4,5,6,7,8,9")).rejects.toThrow(/1-8/);
    await expect(discoverDesktopTargets("abc")).rejects.toThrow(/1-8/);
    await expect(discoverDesktopTargets("80")).rejects.toThrow(/1-8/);
  });
});

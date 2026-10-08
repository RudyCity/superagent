import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { createServer, Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { AddressInfo } from "net";
import { controlChromeCdpTool } from "../src/core/tools/chromeCdpTools.js";

describe("control_chrome_cdp (mock CDP server)", () => {
  let httpServer: Server;
  let wss: WebSocketServer;
  let blackhole: WebSocketServer;
  let httpPort = 0;
  let wsPort = 0;
  let blackholePort = 0;
  let savedPort: string | undefined;
  let savedTimeout: string | undefined;

  beforeAll(async () => {
    // 1. answering WS server (mock CDP target endpoint)
    wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((r) => wss.on("listening", () => r()));
    wsPort = (wss.address() as AddressInfo).port;
    wss.on("connection", (ws: WebSocket) => {
      ws.on("message", (data) => {
        let msg: any;
        try {
          msg = JSON.parse(String(data));
        } catch {
          return;
        }
        const canned: Record<string, any> = {
          "Page.navigate": {},
          "Runtime.evaluate": { result: { value: "mock-title" } },
          "Page.captureScreenshot": { data: "iVBORw0KGgo=" },
          "Page.printToPDF": { data: "JVBERi0xLjQ=" },
          "Storage.getCookies": { cookies: [{ name: "sid", value: "abc123", domain: "example.com" }] },
        };
        if (msg.method in canned) {
          ws.send(JSON.stringify({ id: msg.id, result: canned[msg.method] }));
        }
      });
    });

    // 2. black-hole WS server: accepts connections, never responds (timeout test)
    blackhole = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((r) => blackhole.on("listening", () => r()));
    blackholePort = (blackhole.address() as AddressInfo).port;

    // 3. mock CDP HTTP endpoint (/json/list)
    httpServer = createServer((req, res) => {
      if (req.url === "/json/list") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify([
            {
              id: "T1",
              type: "page",
              title: "Mock Tab",
              url: "https://example.com/",
              webSocketDebuggerUrl: `ws://127.0.0.1:${wsPort}/devtools/page/T1`,
            },
            {
              id: "T2",
              type: "page",
              title: "Silent Tab",
              url: "https://silent.test/",
              webSocketDebuggerUrl: `ws://127.0.0.1:${blackholePort}/devtools/page/T2`,
            },
          ])
        );
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", () => r()));
    httpPort = (httpServer.address() as AddressInfo).port;

    savedPort = process.env.SUPERAGENT_CDP_PORT;
    savedTimeout = process.env.SUPERAGENT_CDP_TIMEOUT_MS;
    process.env.SUPERAGENT_CDP_PORT = String(httpPort);
    process.env.SUPERAGENT_CDP_TIMEOUT_MS = "3000";
  });

  afterAll(async () => {
    if (savedPort === undefined) delete process.env.SUPERAGENT_CDP_PORT;
    else process.env.SUPERAGENT_CDP_PORT = savedPort;
    if (savedTimeout === undefined) delete process.env.SUPERAGENT_CDP_TIMEOUT_MS;
    else process.env.SUPERAGENT_CDP_TIMEOUT_MS = savedTimeout;
    wss.close();
    blackhole.close();
    await new Promise<void>((r) => httpServer.close(() => r()));
  });

  test("tool is registered with the right name and commands", () => {
    expect(controlChromeCdpTool.name).toBe("control_chrome_cdp");
    const cmds = (controlChromeCdpTool.parameters as any).properties.command.enum as string[];
    expect(cmds).toEqual(["list_targets", "navigate", "evaluate", "screenshot", "pdf", "get_cookies"]);
    expect(controlChromeCdpTool.description).toContain("--remote-debugging-port=9222");
    expect(controlChromeCdpTool.description).toContain("no extension required");
  });

  test("list_targets returns mocked page targets", async () => {
    const res = await controlChromeCdpTool.execute({ command: "list_targets" });
    expect(res).toContain("T1");
    expect(res).toContain("Mock Tab");
    expect(res).toContain("https://example.com/");
  });

  test("navigate sends Page.navigate", async () => {
    const res = await controlChromeCdpTool.execute({
      command: "navigate",
      payload: JSON.stringify({ url: "https://example.org/" }),
    });
    expect(res).toContain("navigated");
    expect(res).toContain("https://example.org/");
  });

  test("navigate without url fails with a clear message", async () => {
    const res = await controlChromeCdpTool.execute({ command: "navigate", payload: "{}" });
    expect(res).toContain('needs payload {"url"');
  });

  test("evaluate returns the JS result", async () => {
    const res = await controlChromeCdpTool.execute({
      command: "evaluate",
      payload: JSON.stringify({ expression: "document.title" }),
    });
    expect(res).toContain("mock-title");
  });

  test("screenshot returns base64 PNG data", async () => {
    const res = await controlChromeCdpTool.execute({ command: "screenshot" });
    expect(res).toContain("iVBORw0KGgo=");
  });

  test("pdf returns base64 data", async () => {
    const res = await controlChromeCdpTool.execute({ command: "pdf" });
    expect(res).toContain("JVBERi0xLjQ=");
  });

  test("get_cookies returns the cookie list", async () => {
    const res = await controlChromeCdpTool.execute({ command: "get_cookies" });
    expect(res).toContain("sid");
    expect(res).toContain("example.com");
  });

  test("unknown command fails with the valid list", async () => {
    const res = await controlChromeCdpTool.execute({ command: "frobnicate" });
    expect(res).toContain("unknown command");
    expect(res).toContain("list_targets");
  });

  test("silent target fails fast on timeout", async () => {
    const res = await controlChromeCdpTool.execute({
      command: "evaluate",
      targetId: "T2",
      payload: JSON.stringify({ expression: "1+1" }),
    });
    expect(res).toContain("Timed out after 3000ms");
  });

  test("closed debug port fails fast with an actionable message", async () => {
    // grab a free port, then close it so nothing listens there
    const tmp = createServer();
    await new Promise<void>((r) => tmp.listen(0, "127.0.0.1", () => r()));
    const closedPort = (tmp.address() as AddressInfo).port;
    await new Promise<void>((r) => tmp.close(() => r()));
    process.env.SUPERAGENT_CDP_PORT = String(closedPort);
    try {
      const res = await controlChromeCdpTool.execute({ command: "list_targets" });
      expect(res).toContain("--remote-debugging-port=9222");
    } finally {
      process.env.SUPERAGENT_CDP_PORT = String(httpPort);
    }
  });
});

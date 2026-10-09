import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { createServer, Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { AddressInfo } from "net";
import * as path from "path";
import { existsSync, unlinkSync } from "fs";
import { controlChromeCdpTool, _cdpTestHooks } from "../src/core/tools/chromeCdpTools.js";
import { controlChromeVisionTool } from "../src/core/tools/chromeVisionTools.js";

describe("control_chrome_cdp (mock CDP server)", () => {
  let httpServer: Server;
  let wss: WebSocketServer;
  let blackhole: WebSocketServer;
  let httpPort = 0;
  let wsPort = 0;
  let blackholePort = 0;
  let savedPort: string | undefined;
  let savedTimeout: string | undefined;
  let snapshotReturnsEmpty = false;
  let snapshotChanged = false;
  const mockElementsChanged = [
    { index: 0, tag: "button", text: "Sign In", selector: "button" },
    { index: 1, tag: "input", text: "", type: "text", placeholder: "Search...", selector: 'input[name="q"]' },
    { index: 2, tag: "a", text: "Help", selector: "a.help" },
  ];
  let lastTypeExpression = "";
  const mockElements = [
    { index: 0, tag: "button", text: "Login", selector: "button" },
    { index: 1, tag: "input", text: "", type: "text", placeholder: "Search...", selector: 'input[name="q"]' },
  ];

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
        // marker-aware Runtime.evaluate for the snapshot/click/type page snippets
        if (msg.method === "Runtime.evaluate") {
          const expr = String((msg.params && msg.params.expression) || "");
          if (expr.includes("cdp-snapshot-walk")) {
            const els = snapshotReturnsEmpty ? [] : snapshotChanged ? mockElementsChanged : mockElements;
            ws.send(JSON.stringify({ id: msg.id, result: { result: { value: els } } }));
            return;
          }
          if (expr.includes("cdp-wait-for")) {
            // __NEVER__ simulates content that never appears (timeout path)
            if (expr.includes("__NEVER__")) {
              ws.send(
                JSON.stringify({ id: msg.id, result: { result: { value: JSON.stringify({ ok: false, reason: "timeout after 800ms waiting for selector '__NEVER__'" }) } } })
              );
            } else {
              // simulate a late-appearing element: the tool must actually wait
              setTimeout(() => {
                try {
                  ws.send(
                    JSON.stringify({ id: msg.id, result: { result: { value: JSON.stringify({ ok: true, kind: "selector", selector: "#login", tag: "button", foundText: "Login" }) } } })
                  );
                } catch {
                  /* test may have torn down */
                }
              }, 300);
            }
            return;
          }
          if (expr.includes("cdp-click")) {
            ws.send(
              JSON.stringify({ id: msg.id, result: { result: { value: JSON.stringify({ ok: true, tag: "button", text: "Login" }) } } })
            );
            return;
          }
          if (expr.includes("cdp-type")) {
            lastTypeExpression = expr;
            ws.send(
              JSON.stringify({ id: msg.id, result: { result: { value: JSON.stringify({ ok: true, tag: "input", typed: "hello" }) } } })
            );
            return;
          }
          if (expr.includes("cdp-read-page")) {
            ws.send(
              JSON.stringify({
                id: msg.id,
                result: {
                  result: {
                    value: {
                      title: "Mock Tab",
                      url: "https://example.com/",
                      headings: [{ tag: "h1", text: "Welcome to Groq Console" }],
                      alerts: ["Email verification required"],
                      bodyText: "Please check your email mmxzrmxljenlsndpnl@jbsze.com for the login link.",
                      links: [{ text: "Verify Email", href: "https://auth.groq.com/verify-email?token=xyz123" }],
                    },
                  },
                },
              })
            );
            return;
          }
          if (expr.includes("cdp-extract-links")) {
            ws.send(
              JSON.stringify({
                id: msg.id,
                result: {
                  result: {
                    value: [
                      { text: "Verify Email", href: "https://auth.groq.com/verify-email?token=xyz123" },
                      { text: "Terms of Service", href: "https://groq.com/terms" },
                    ],
                  },
                },
              })
            );
            return;
          }
        }
        const canned: Record<string, any> = {
          "Page.navigate": {},
          "Runtime.evaluate": { result: { value: "mock-title" } },
          "Page.captureScreenshot": { data: "iVBORw0KGgo=" },
          "Page.printToPDF": { data: "JVBERi0xLjQ=" },
          "Storage.getCookies": { cookies: [{ name: "sid", value: "abc123", domain: "example.com" }] },
          "Input.insertText": {},
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
      } else if (req.url?.startsWith("/json/new")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: "T_NEW", url: "https://new.test/" }));
      } else if (req.url?.startsWith("/json/close/")) {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("Target is closing");
      } else if (req.url?.startsWith("/json/activate/")) {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("Target activated");
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
    _cdpTestHooks.closeAll();
    wss.close();
    blackhole.close();
    await new Promise<void>((r) => httpServer.close(() => r()));
  });

  test("tool is registered with the right name and commands", () => {
    expect(controlChromeCdpTool.name).toBe("control_chrome_cdp");
    const cmds = (controlChromeCdpTool.parameters as any).properties.command.enum as string[];
    expect(cmds).toEqual([
      "list_targets",
      "new_tab",
      "close_tab",
      "activate",
      "navigate",
      "evaluate",
      "snapshot",
      "read_page",
      "extract_links",
      "click",
      "type",
      "wait_for",
      "screenshot",
      "pdf",
      "get_cookies",
    ]);
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

  test("screenshot returns base64 PNG data, dataUrl, and saves to disk", async () => {
    const tmpOut = path.join(process.cwd(), `test_cdp_shot_${Date.now()}.png`);
    try {
      const res = await controlChromeCdpTool.execute({
        command: "screenshot",
        payload: JSON.stringify({ outputPath: tmpOut }),
      });
      expect(res).toContain("screenshot captured");
      expect(res).toContain("saved to");
      expect(res).toContain(tmpOut);
      expect(res).toContain("data:image/png;base64,iVBORw0KGgo=");
      expect(existsSync(tmpOut)).toBe(true);
    } finally {
      if (existsSync(tmpOut)) unlinkSync(tmpOut);
    }
  });

  test("navigate automatically captures screenshot unless disabled", async () => {
    const res = await controlChromeCdpTool.execute({
      command: "navigate",
      payload: JSON.stringify({ url: "https://example.com" }),
    });
    expect(res).toContain("navigated tab 'Mock Tab' to https://example.com");
    expect(res).toContain("Screenshot saved:");
    expect(res).toContain("data:image/png;base64,iVBORw0KGgo=");

    const resNoShot = await controlChromeCdpTool.execute({
      command: "navigate",
      payload: JSON.stringify({ url: "https://example.com", screenshot: false }),
    });
    expect(resNoShot).toContain("navigated tab 'Mock Tab' to https://example.com");
    expect(resNoShot).not.toContain("Screenshot saved:");
  });

  test("click and type with screenshot: true captures visual feedback", async () => {
    await controlChromeCdpTool.execute({ command: "snapshot" });
    const clickRes = await controlChromeCdpTool.execute({
      command: "click",
      payload: JSON.stringify({ index: 0, screenshot: true }),
    });
    expect(clickRes).toContain("clicked <button>");
    expect(clickRes).toContain("Screenshot saved:");
    expect(clickRes).toContain("data:image/png;base64,iVBORw0KGgo=");

    const typeRes = await controlChromeCdpTool.execute({
      command: "type",
      payload: JSON.stringify({ index: 1, text: "query", screenshot: true }),
    });
    expect(typeRes).toContain("typed into <input>");
    expect(typeRes).toContain("Screenshot saved:");
    expect(typeRes).toContain("data:image/png;base64,iVBORw0KGgo=");
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

  test("snapshot returns a numbered element list", async () => {
    const res = await controlChromeCdpTool.execute({ command: "snapshot" });
    expect(res).toContain("[0] <button>");
    expect(res).toContain("Login");
    expect(res).toContain("[1] <input");
    expect(res).toContain("Search...");
  });

  test("click by index uses the snapshot", async () => {
    await controlChromeCdpTool.execute({ command: "snapshot" });
    const res = await controlChromeCdpTool.execute({
      command: "click",
      payload: JSON.stringify({ index: 0 }),
    });
    expect(res).toContain("clicked <button>");
    expect(res).toContain("Login");
  });

  test("click by selector works without a snapshot", async () => {
    const res = await controlChromeCdpTool.execute({
      command: "click",
      payload: JSON.stringify({ selector: "#login" }),
    });
    expect(res).toContain("clicked <button>");
  });

  test("type by index dispatches input/change via native setter, blur, and React valueTracker", async () => {
    await controlChromeCdpTool.execute({ command: "snapshot" });
    const res = await controlChromeCdpTool.execute({
      command: "type",
      payload: JSON.stringify({ index: 1, text: "hello" }),
    });
    expect(res).toContain("typed into <input>");
    expect(lastTypeExpression).toContain('new Event("input"');
    expect(lastTypeExpression).toContain('new Event("change"');
    expect(lastTypeExpression).toContain('new Event("blur"');
    expect(lastTypeExpression).toContain("HTMLInputElement");
    expect(lastTypeExpression).toContain("_valueTracker");
    expect(lastTypeExpression).toContain("shadowRoot");
  });

  test("type with native flag dispatches both evaluate and Input.insertText", async () => {
    await controlChromeCdpTool.execute({ command: "snapshot" });
    const res = await controlChromeCdpTool.execute({
      command: "type",
      payload: JSON.stringify({ index: 1, text: "secret123", native: true }),
    });
    expect(res).toContain("typed into <input>");
  });

  test("click with out-of-range index fails clearly", async () => {
    await controlChromeCdpTool.execute({ command: "snapshot" });
    const res = await controlChromeCdpTool.execute({
      command: "click",
      payload: JSON.stringify({ index: 99 }),
    });
    expect(res).toContain("out of range");
    expect(res).toContain("0..1");
  });

  test("click by index with no snapshot for the tab fails clearly", async () => {
    const res = await controlChromeCdpTool.execute({
      command: "click",
      targetId: "T2",
      payload: JSON.stringify({ index: 0 }),
    });
    expect(res).toContain("no snapshot for this tab yet");
    expect(res).toContain("'snapshot'");
  });

  test("empty snapshot reports clearly", async () => {
    snapshotReturnsEmpty = true;
    try {
      const res = await controlChromeCdpTool.execute({ command: "snapshot" });
      expect(res).toContain("no interactive elements");
    } finally {
      snapshotReturnsEmpty = false;
    }
  });

  test("type without text fails clearly", async () => {
    const res = await controlChromeCdpTool.execute({
      command: "type",
      payload: JSON.stringify({ index: 0 }),
    });
    expect(res).toContain('needs payload {"text"');
  });

  test("wait_for succeeds when the element appears", async () => {
    const res = await controlChromeCdpTool.execute({
      command: "wait_for",
      payload: JSON.stringify({ selector: "#login", timeout_ms: 2000 }),
    });
    expect(res).toContain("wait_for matched");
    expect(res).toContain("#login");
  });

  test("wait_for without selector or text fails clearly", async () => {
    const res = await controlChromeCdpTool.execute({ command: "wait_for", payload: "{}" });
    expect(res).toContain("needs payload");
  });

  test("wait_for times out with a clear message", async () => {
    const res = await controlChromeCdpTool.execute({
      command: "wait_for",
      payload: JSON.stringify({ selector: "__NEVER__", timeout_ms: 800 }),
    });
    expect(res).toContain("timeout");
    expect(res).toContain("__NEVER__");
  });

  test("snapshot compact omits long attributes", async () => {
    const res = await controlChromeCdpTool.execute({
      command: "snapshot",
      payload: JSON.stringify({ compact: true }),
    });
    expect(res).toContain("[0] <button>");
    expect(res).toContain("Login");
    expect(res).not.toContain('placeholder="Search..."');
    expect(res).toContain("(compact)");
  });

  test("snapshot max_elements limits the list", async () => {
    const res = await controlChromeCdpTool.execute({
      command: "snapshot",
      payload: JSON.stringify({ max_elements: 1 }),
    });
    expect(res).toContain("[0] <button>");
    expect(res).not.toContain("[1] <input");
    expect(res).toContain("(limited to 1)");
  });

  test("snapshot max_elements rejects invalid values", async () => {
    const res = await controlChromeCdpTool.execute({
      command: "snapshot",
      payload: JSON.stringify({ max_elements: 0 }),
    });
    expect(res).toContain("max_elements");
    expect(res).toContain("positive integer");
  });

  test("snapshot diff reports added/changed vs previous snapshot", async () => {
    await controlChromeCdpTool.execute({ command: "snapshot" });
    snapshotChanged = true;
    try {
      const res = await controlChromeCdpTool.execute({
        command: "snapshot",
        payload: JSON.stringify({ diff: true }),
      });
      expect(res).toContain("snapshot diff");
      expect(res).toContain("+1 added");
      expect(res).toContain("~1 changed");
      expect(res).toContain("Help");
    } finally {
      snapshotChanged = false;
    }
  });

  test("snapshot diff with no previous snapshot shows full list", async () => {
    _cdpTestHooks.clearSnapshots();
    const res = await controlChromeCdpTool.execute({
      command: "snapshot",
      payload: JSON.stringify({ diff: true }),
    });
    expect(res).toContain("no previous snapshot");
    expect(res).toContain("[0] <button>");
  });

  test("click auto-waits for a late-appearing element instead of failing instantly", async () => {
    const start = Date.now();
    const res = await controlChromeCdpTool.execute({
      command: "click",
      payload: JSON.stringify({ selector: "#late-button", timeout_ms: 5000 }),
    });
    const elapsed = Date.now() - start;
    expect(res).toContain("clicked <button>");
    // the mock delays the wait_for response ~300ms: proves we waited
    expect(elapsed).toBeGreaterThanOrEqual(200);
  });

  test("sequential commands reuse one persistent CDP connection", async () => {
    _cdpTestHooks.closeAll();
    expect(_cdpTestHooks.connectionCount()).toBe(0);
    await controlChromeCdpTool.execute({ command: "get_cookies" });
    await controlChromeCdpTool.execute({ command: "screenshot" });
    expect(_cdpTestHooks.connectionCount()).toBe(1);
  });

  test("new_tab opens a new page and returns targetId", async () => {
    const res = await controlChromeCdpTool.execute({
      command: "new_tab",
      payload: JSON.stringify({ url: "https://new.test/" }),
    });
    expect(res).toContain("opened new tab");
    expect(res).toContain("T_NEW");
  });

  test("activate brings the tab to front", async () => {
    const res = await controlChromeCdpTool.execute({
      command: "activate",
      targetId: "T1",
    });
    expect(res).toContain("activated tab");
    expect(res).toContain("T1");
  });

  test("close_tab closes the target tab", async () => {
    const res = await controlChromeCdpTool.execute({
      command: "close_tab",
      targetId: "T1",
    });
    expect(res).toContain("closed tab");
    expect(res).toContain("T1");
  });

  test("permissive argument parsing supports object payload and top-level url/index shortcuts", async () => {
    // 1. Top-level url shortcut with auto-snapshot
    const res1 = await controlChromeCdpTool.execute({
      command: "navigate",
      url: "https://example.com/shortcut",
    });
    expect(res1).toContain("navigated tab 'Mock Tab' to https://example.com/shortcut");
    expect(res1).toContain("Interactive elements");

    // 2. Object payload without JSON string serialization and auto_snapshot disabled
    const res2 = await controlChromeCdpTool.execute({
      command: "navigate",
      payload: { url: "https://example.com/obj", auto_snapshot: false } as any,
    });
    expect(res2).toContain("navigated tab 'Mock Tab' to https://example.com/obj");
    expect(res2).not.toContain("Interactive elements");
  });

  test("read_page extracts headings, alerts, body text, and key links", async () => {
    const res = await controlChromeCdpTool.execute({ command: "read_page" });
    expect(res).toContain("page content for 'Mock Tab'");
    expect(res).toContain("[H1] Welcome to Groq Console");
    expect(res).toContain("Email verification required");
    expect(res).toContain("Please check your email");
    expect(res).toContain("https://auth.groq.com/verify-email?token=xyz123");
  });

  test("extract_links extracts hyperlinks matching pattern", async () => {
    const res = await controlChromeCdpTool.execute({
      command: "extract_links",
      pattern: "verify",
    });
    expect(res).toContain("extracted 2 link(s)");
    expect(res).toContain("https://auth.groq.com/verify-email?token=xyz123");
  });
});

describe("control_chrome_cdp (Chrome 155+ 426 fallback)", () => {
  let httpServer: Server;
  let wss: WebSocketServer;
  let port = 0;
  let savedPort: string | undefined;
  let savedTimeout: string | undefined;

  beforeAll(async () => {
    // Simulate Chrome 155+: plain HTTP to the discovery endpoint gets 426.
    httpServer = createServer((req, res) => {
      if (req.url === "/json/list") {
        res.writeHead(426, { "Content-Type": "text/plain" });
        res.end("Upgrade Required");
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", () => r()));
    port = (httpServer.address() as AddressInfo).port;

    // The same server upgrades /json/list to WebSocket and delivers the JSON
    // discovery document as a single text message.
    wss = new WebSocketServer({ server: httpServer });
    wss.on("connection", (ws: WebSocket, req: any) => {
      if (req.url === "/json/list") {
        ws.send(
          JSON.stringify([
            {
              id: "W1",
              type: "page",
              title: "WS Tab",
              url: "https://ws.example/",
              webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/W1`,
            },
          ])
        );
      } else {
        ws.close(1008);
      }
    });

    savedPort = process.env.SUPERAGENT_CDP_PORT;
    savedTimeout = process.env.SUPERAGENT_CDP_TIMEOUT_MS;
    process.env.SUPERAGENT_CDP_PORT = String(port);
    process.env.SUPERAGENT_CDP_TIMEOUT_MS = "3000";
  });

  afterAll(async () => {
    if (savedPort === undefined) delete process.env.SUPERAGENT_CDP_PORT;
    else process.env.SUPERAGENT_CDP_PORT = savedPort;
    if (savedTimeout === undefined) delete process.env.SUPERAGENT_CDP_TIMEOUT_MS;
    else process.env.SUPERAGENT_CDP_TIMEOUT_MS = savedTimeout;
    _cdpTestHooks.closeAll();
    wss.close();
    await new Promise<void>((r) => httpServer.close(() => r()));
  });

  test("list_targets works when /json/list answers 426 (WS fallback)", async () => {
    const res = await controlChromeCdpTool.execute({ command: "list_targets" });
    expect(res).toContain("W1");
    expect(res).toContain("WS Tab");
    expect(res).toContain("https://ws.example/");
  });

  test("426 with immediate WS close surfaces a clear error, not Invalid JSON", async () => {
    const http2 = createServer((_req, res) => {
      res.writeHead(426, { "Content-Type": "text/plain" });
      res.end("Upgrade Required");
    });
    await new Promise<void>((r) => http2.listen(0, "127.0.0.1", () => r()));
    const p2 = (http2.address() as AddressInfo).port;
    const wss2 = new WebSocketServer({ server: http2 });
    wss2.on("connection", (ws: WebSocket) => ws.close(1008));
    process.env.SUPERAGENT_CDP_PORT = String(p2);
    try {
      const res = await controlChromeCdpTool.execute({ command: "list_targets" });
      expect(res).toContain("426");
      expect(res).not.toContain("Invalid JSON");
    } finally {
      process.env.SUPERAGENT_CDP_PORT = String(port);
      wss2.close();
      await new Promise<void>((r) => http2.close(() => r()));
    }
  });

  test("dual-stack fallback seamlessly connects to ::1 when 127.0.0.1 is unreachable", async () => {
    let ipv6Server: Server;
    try {
      ipv6Server = createServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify([{
          id: "IPV6-T1",
          type: "page",
          title: "IPv6 Page",
          url: "https://ipv6.example/",
          webSocketDebuggerUrl: "ws://[::1]:9999/devtools/page/IPV6-T1"
        }]));
      });
      await new Promise<void>((resolve, reject) => {
        ipv6Server.listen(0, "::1", () => resolve());
        ipv6Server.on("error", reject);
      });
    } catch {
      // IPv6 loopback not supported on this host environment
      return;
    }
    const ipv6Port = (ipv6Server.address() as AddressInfo).port;
    const prevPort = process.env.SUPERAGENT_CDP_PORT;
    const prevHost = process.env.SUPERAGENT_CDP_HOST;
    delete process.env.SUPERAGENT_CDP_HOST;
    process.env.SUPERAGENT_CDP_PORT = String(ipv6Port);
    _cdpTestHooks.resetResolvedHost();

    try {
      const res = await controlChromeCdpTool.execute({ command: "list_targets" });
      expect(res).toContain("IPV6-T1");
      expect(res).toContain("IPv6 Page");
    } finally {
      if (prevPort !== undefined) process.env.SUPERAGENT_CDP_PORT = prevPort;
      else delete process.env.SUPERAGENT_CDP_PORT;
      if (prevHost !== undefined) process.env.SUPERAGENT_CDP_HOST = prevHost;
      _cdpTestHooks.resetResolvedHost();
      await new Promise<void>((r) => ipv6Server.close(() => r()));
    }
  });
});

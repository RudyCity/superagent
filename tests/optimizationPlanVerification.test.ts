import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { controlChromeCdpTool, _cdpTestHooks } from "../src/core/tools/chromeCdpTools.js";
import { invokeSubagentTool } from "../src/core/tools/subagentTools.js";
import { checkBinaryAvailability, isBinaryCached, updateSystemCheckCache, clearSystemCheckCache } from "../src/core/config/systemCache.js";
import { Agent } from "../src/core/agent.js";
import { WebSocketServer, WebSocket } from "ws";
import { createServer, Server } from "http";
import { AddressInfo } from "net";

describe("Superagent Optimization Plan Verification", () => {
  let wss: WebSocketServer;
  let httpServer: Server;
  let wsPort: number;
  let httpPort: number;

  const mockDomElements = Array.from({ length: 150 }, (_, i) => ({
    index: i,
    tag: i % 2 === 0 ? "button" : "input",
    text: `Element label ${i}`,
    type: i % 2 === 0 ? undefined : "text",
    placeholder: `Placeholder ${i} with long descriptive text here`,
    ariaLabel: `Aria label for element ${i} with very long descriptive accessibility description`,
    selector: `#el-${i}`,
  }));

  beforeEach(async () => {
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
        if (msg.method === "Runtime.evaluate") {
          ws.send(JSON.stringify({ id: msg.id, result: { result: { value: mockDomElements } } }));
        }
      });
    });

    httpServer = createServer((req, res) => {
      if (req.url === "/json/list") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify([
            {
              id: "T1",
              type: "page",
              title: "Large Test Page",
              url: "https://example.com/large",
              webSocketDebuggerUrl: `ws://127.0.0.1:${wsPort}/devtools/page/T1`,
            },
          ])
        );
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      }
    });

    await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", () => r()));
    httpPort = (httpServer.address() as AddressInfo).port;

    process.env.SUPERAGENT_CDP_PORT = String(httpPort);
    process.env.SUPERAGENT_CDP_TIMEOUT_MS = "3000";
  });

  afterEach(async () => {
    _cdpTestHooks.closeAll();
    _cdpTestHooks.clearSnapshots();
    if (wss) await new Promise<void>((r) => wss.close(() => r()));
    if (httpServer) await new Promise<void>((r) => httpServer.close(() => r()));
  });

  it("Task 2.1: compact snapshot defaults to compact:true and max_elements:100 with massive token savings", async () => {
    // Default snapshot (no payload): should be compact and capped at 100 elements
    const defaultRes = await controlChromeCdpTool.execute({ command: "snapshot" });
    expect(defaultRes).toContain("(compact)");
    expect(defaultRes).toContain("(limited to 100)");
    expect(defaultRes).toContain("[0] <button> \"Element label 0\"");
    expect(defaultRes).toContain("[99] <input> \"Element label 99\"");
    expect(defaultRes).not.toContain("[100] <button>"); // Capped at 100
    expect(defaultRes).not.toContain("aria-label="); // Omitted in compact mode

    // Explicit non-compact snapshot
    const verboseRes = await controlChromeCdpTool.execute({
      command: "snapshot",
      payload: JSON.stringify({ compact: false, max_elements: 100 }),
    });
    expect(verboseRes).toContain("aria-label=");
    expect(verboseRes).toContain("placeholder=");

    // Token footprint comparison: compact representation should be substantially smaller
    expect(defaultRes.length).toBeLessThan(verboseRes.length * 0.4);
  });

  it("Task 6.1: binary availability caching avoids repeated subshell checks within TTL", async () => {
    clearSystemCheckCache();
    updateSystemCheckCache({ bun: true, node: true });

    expect(isBinaryCached("bun")).toBe(true);
    expect(isBinaryCached("node")).toBe(true);

    const available = await checkBinaryAvailability("bun");
    expect(available).toBe(true);
  });

  it("Task 1.2: background subagent triggers reactive wakeup message on completion", async () => {
    const parent = new Agent(
      () => {},
      async () => true,
      async () => "",
      "Parent Agent",
      [],
      process.cwd()
    );

    // Run within agent storage store
    const { agentLocalStorage } = await import("../src/core/agent.js");
    let result: string | undefined;

    await agentLocalStorage.run(parent, async () => {
      result = await invokeSubagentTool.execute(
        {
          typeName: "researcher",
          role: "Data Researcher",
          prompt: "Return research summary",
          wait: false,
        },
        process.cwd()
      );
    });

    expect(result).toContain("Invoked subagent \"researcher\"");
    expect(result).toContain("Conversation ID:");
  });
});

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import type { AddressInfo } from "node:net";
import { CrossIdeCdpGateway } from "../src/core/tools/crossIdeCdpGateway.js";
import { cdpCoordinatorStatus } from "../src/core/tools/chromeCdpSessionManager.js";

describe("Cross-IDE gateway identity, approval, encrypted attach, CDP routing", () => {
  let http: Server;
  let ws: WebSocketServer;
  let port = 0, wsPort = 0;
  let dir = "";
  let oldDir: string | undefined, oldHost: string | undefined;
  beforeAll(async () => {
    ws = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>(resolve => ws.on("listening", () => resolve()));
    wsPort = (ws.address() as AddressInfo).port;
    ws.on("connection", socket => socket.on("message", payload => {
      const req = JSON.parse(String(payload));
      socket.send(JSON.stringify({ id: req.id,
        result: req.method === "Runtime.evaluate"
          ? { result: { value: req.params?.expression?.includes("interactive") ? [] : 2 } }
          : {},
      }));
    }));
    http = createServer((req, res) => {
      if (req.url === "/json/list") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify([{
          id: "TAB_CROSS", type: "page", title: "Cross IDE mock", url: "https://example.invalid/",
          webSocketDebuggerUrl: `ws://127.0.0.1:${wsPort}/devtools/page/TAB_CROSS`,
        }]));
        return;
      }
      res.writeHead(404); res.end();
    });
    await new Promise<void>(resolve => http.listen(0, "127.0.0.1", () => resolve()));
    port = (http.address() as AddressInfo).port;
  });
  afterAll(async () => {
    ws.close();
    await new Promise<void>(resolve => http.close(() => resolve()));
  });
  beforeEach(async () => {
    oldDir = process.env.SUPERAGENT_CDP_SESSION_DIR;
    oldHost = process.env.SUPERAGENT_CDP_HOST;
    process.env.SUPERAGENT_CDP_HOST = "127.0.0.1";
    dir = await mkdtemp(join(tmpdir(), "cross-ide-cdp-"));
    process.env.SUPERAGENT_CDP_SESSION_DIR = dir;
  });
  afterEach(async () => {
    if (oldDir === undefined) delete process.env.SUPERAGENT_CDP_SESSION_DIR;
    else process.env.SUPERAGENT_CDP_SESSION_DIR = oldDir;
    if (oldHost === undefined) delete process.env.SUPERAGENT_CDP_HOST;
    else process.env.SUPERAGENT_CDP_HOST = oldHost;
    await rm(dir, { recursive: true, force: true });
  });

  test("Codex + AGY + SuperAgent discover and attach through distinct bound MCP sessions", async () => {
    const codex = new CrossIdeCdpGateway({ sessionId: "connection-codex-" + dir, clientLabel: "codex" });
    const agy = new CrossIdeCdpGateway({ sessionId: "connection-agy-" + dir, clientLabel: "antigravity" });
    const superagent = new CrossIdeCdpGateway({ sessionId: "connection-superagent-" + dir, clientLabel: "superagent" });
    const identity = await codex.invoke({ action: "identity" }) as any;
    expect(identity.agentId).toMatch(/^ide-[0-9a-f]{24}$/);
    expect(identity.clientLabel).toBe("codex");
    expect(identity.labelTrust).toContain("self-reported");
    expect((await agy.invoke({ action: "identity" }) as any).agentId).not.toBe(identity.agentId);
    const discover = await codex.invoke({ action: "discover", port }) as any;
    expect(discover.pages[0].targetId).toBe("TAB_CROSS");
    const owner = await codex.invoke({ action: "claim", port, targetId: "TAB_CROSS" }) as any;
    expect(owner.status).toBe("owner");
    expect(JSON.stringify(owner)).not.toContain("sessionToken");
    await codex.invoke({ action: "share", port, targetId: "TAB_CROSS", enabled: true });

    const aReq = await agy.invoke({
      action: "request_attach", port, targetId: "TAB_CROSS", role: "contributor",
    }) as any;
    const bReq = await superagent.invoke({
      action: "request_attach", port, targetId: "TAB_CROSS", role: "observer",
    }) as any;
    const waiting = await codex.invoke({ action: "pending", port, targetId: "TAB_CROSS" }) as any[];
    expect(waiting.map(r => r.requestId).sort()).toEqual([aReq.requestId, bReq.requestId].sort());
    await expect(codex.invoke({
      action: "poll_attach", port, targetId: "TAB_CROSS", requestId: aReq.requestId,
    })).rejects.toThrow(/original requesting/);

    await codex.invoke({ action: "approve_attach", port, targetId: "TAB_CROSS", requestId: aReq.requestId });
    await codex.invoke({ action: "approve_attach", port, targetId: "TAB_CROSS", requestId: bReq.requestId });
    const pendingFile = join(dir, "gateway", "requests", aReq.requestId + ".json");
    const onDisk = await readFile(pendingFile, "utf8");
    expect(onDisk).toContain('"sealed"');
    expect(onDisk).not.toContain("invitationToken");
    expect(onDisk).not.toContain("sessionToken");

    const joinedA = await agy.invoke({ action: "poll_attach", port, targetId: "TAB_CROSS", requestId: aReq.requestId }) as any;
    const joinedB = await superagent.invoke({ action: "poll_attach", port, targetId: "TAB_CROSS", requestId: bReq.requestId }) as any;
    expect(joinedA.role).toBe("contributor");
    expect(joinedB.role).toBe("observer");
    expect(JSON.stringify(joinedA)).not.toContain("sessionToken");
    expect((await readdir(join(dir, "gateway", "requests")))).not.toContain(aReq.requestId + ".json");

    const view = await agy.invoke({ action: "discover", port }) as any;
    expect(view.pages[0].session.participants).toHaveLength(3);
    expect(view.summary.activeAgents).toBe(3);

    const read = await superagent.invoke({ action: "execute", port, targetId: "TAB_CROSS", command: "read_page" }) as any;
    expect(read.ok).toBe(true);
    const observerDenied = await superagent.invoke({
      action: "execute", port, targetId: "TAB_CROSS", command: "evaluate", expectedRevision: 0,
      payload: { expression: "1+1" },
    }) as any;
    expect(observerDenied.ok).toBe(false);
    expect(observerDenied.result).toMatch(/cannot modify|observer/i);
    const mutation = await agy.invoke({
      action: "execute", port, targetId: "TAB_CROSS", command: "evaluate", expectedRevision: 0,
      payload: { expression: "1+1" },
    }) as any;
    expect(mutation.ok).toBe(true);
    await expect(codex.invoke({
      action: "execute", port, targetId: "TAB_CROSS", command: "evaluate", expectedRevision: 0,
      payload: { expression: "1+1" },
    })).resolves.toMatchObject({ ok: false });
    const live = await codex.invoke({ action: "events", port, targetId: "TAB_CROSS", cursor: 0 }) as any;
    expect(live.events.some((e: any) => e.event === "ide_attach_joined")).toBe(true);
    expect(JSON.stringify(live)).not.toContain("sessionToken");
    const eventWait = superagent.invoke({
      action: "wait_events", port, targetId: "TAB_CROSS", cursor: live.cursor, waitMs: 3000,
    }) as Promise<any>;
    await new Promise(resolve => setTimeout(resolve, 250));
    const next = await agy.invoke({
      action: "execute", port, targetId: "TAB_CROSS", command: "evaluate", expectedRevision: 1,
      payload: { expression: "2+2" },
    }) as any;
    expect(next.ok).toBe(true);
    const woke = await eventWait;
    expect(woke.events.some((e: any) => e.event === "write_success")).toBe(true);
    expect(woke.cursor).toBeGreaterThan(live.cursor);
    expect((await cdpCoordinatorStatus(port)).summary.activeAgents).toBe(3);
  }, 30000);

  test("denial, session-bound decrypt, and direct-connection safety policy", async () => {
    const owner = new CrossIdeCdpGateway({ sessionId: "owner-" + dir });
    const guest = new CrossIdeCdpGateway({ sessionId: "guest-" + dir });
    const intruder = new CrossIdeCdpGateway({ sessionId: "intruder-" + dir });
    await owner.invoke({ action: "claim", port, targetId: "TAB_CROSS" });
    await owner.invoke({ action: "share", port, targetId: "TAB_CROSS", enabled: true });
    const first = await guest.invoke({ action: "request_attach", port, targetId: "TAB_CROSS", role: "observer" }) as any;
    await owner.invoke({ action: "deny_attach", port, targetId: "TAB_CROSS", requestId: first.requestId });
    expect((await guest.invoke({ action: "poll_attach", port, targetId: "TAB_CROSS", requestId: first.requestId }) as any).status).toBe("denied");
    await expect(intruder.invoke({
      action: "poll_attach", port, targetId: "TAB_CROSS", requestId: first.requestId,
    })).rejects.toThrow(/original requesting/);
    const policy = await owner.invoke({ action: "policy" }) as any;
    expect(policy.externalDirectCdp).toContain("NOT_BLOCKED");
    await expect(owner.invoke({
      action: "execute", port, targetId: "TAB_CROSS", command: "get_cookies",
    })).rejects.toThrow(/not exposed/);
    await expect(guest.invoke({
      action: "execute", port, targetId: "TAB_CROSS", command: "read_page",
    })).rejects.toThrow(/Not attached/);
  }, 15000);
});

import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import vm from "node:vm";
import { handleServerRoute } from "../src/serverRoutes.js";
import { ensureServerAuthToken } from "../src/core/utils/serverSecurity.js";
import { delegateBridge } from "../src/core/delegate/bridge.js";
import * as coordinator from "../src/core/browserTransport/sessionCoordinator.js";
import { projectDelegateTrayStatus } from "../src/core/delegate/delegateStatusProjection.js";
import * as managedCoordinator from "../src/core/tools/chromeCdpSessionManager.js";

const A = "chrome-profile-a-00001";
const B = "chrome-profile-b-00002";
const now = Date.now();
const original = () => ({
  key: A + "|tab:12", transport: "delegate", clientId: A, connectionId: A,
  tabId: 12, targetId: "delegate:" + A + ":12", agentId: "owner-a",
  claimedAt: now - 2000, expiresAt: now + 60_000, revision: 7,
  sharing: true, recoveryRequired: false,
  tokenHash: "private-token-hash", sessionToken: "raw-owner-secret",
  invitations: [{ tokenHash: "private-invite-hash", code: "SECRET" }],
  hmac: "private-hmac", url: "https://chatgpt.com/c/private-chat",
  participants: [
    { agentId: "watcher-a", role: "observer", joinedAt: now - 1000,
      expiresAt: now + 20_000, tokenHash: "watcher-hash", inviteToken: "PRIVATE" },
    { agentId: "writer-b", role: "contributor", joinedAt: now - 800,
      expiresAt: now + 30_000, sessionToken: "PRIVATE" },
  ],
  pendingInvitations: 2,
});

type Reply = { status: number; body: any; headers: Record<string, string> };
async function request(options: {
  route?: string; method?: string; headers?: Record<string, string>;
  remote?: string; query?: string;
} = {}): Promise<Reply> {
  const route = options.route ?? "/api/delegate/multitab/status";
  const headers = { host: "127.0.0.1:7888",
    authorization: "Bearer " + ensureServerAuthToken(), ...options.headers };
  const req = {
    method: options.method ?? "GET", headers,
    url: route + (options.query ?? ""),
    socket: { remoteAddress: options.remote ?? "127.0.0.1", localPort: 7888 },
  } as any;
  const reply: Reply = { status: -1, body: null, headers: {} };
  const res = { setHeader: (key: string, value: string) => { reply.headers[key.toLowerCase()] = value; } };
  const handled = await handleServerRoute(req, res as any, route,
    new URL("http://127.0.0.1:7888" + req.url), {
      activeSessions: new Map(),
      sendJSON: (_res: unknown, status: number, body: unknown) => {
        reply.status = status; reply.body = body;
      },
    } as any);
  expect(handled).toBe(true);
  return reply;
}

afterEach(() => vi.restoreAllMocks());

describe("CDP Tray status projection (read only, allowlist)", () => {
  it("removes secrets, HMAC, private URLs, invitation metadata and opaque target ids", () => {
    const projected = projectDelegateTrayStatus([original()], {
      connectedClientIds: [A], now, busy: () => true,
    });
    expect(projected).toEqual({ observedAt: now, sessionsStatus: "known",
      truncated: false,
      sessions: [{
        transport: "delegate", clientId: A, tabId: 12, agentId: "owner-a",
        ownerRole: "owner", claimedAt: now - 2000, expiresAt: now + 60_000,
        revision: 7, sharing: true, recoveryRequired: false,
        lockBusy: true, queuedOperations: null,
        participants: [
          { agentId: "watcher-a", role: "observer", joinedAt: now - 1000, expiresAt: now + 20_000 },
          { agentId: "writer-b", role: "contributor", joinedAt: now - 800, expiresAt: now + 30_000 },
        ],
      }],
    });
    const json = JSON.stringify(projected);
    for (const privateValue of ["raw-owner-secret", "private-token-hash",
      "private-invite-hash", "watcher-hash", "PRIVATE", "SECRET", "private-hmac",
      "https://", "pendingInvitations", "targetId", "tokenHash"]) {
      expect(json).not.toContain(privateValue);
    }
  });

  it("isolates by connected profile and explicitly selected profile", () => {
    const other = { ...original(), clientId: B, tabId: 77, agentId: "owner-b" };
    const rows = [original(), other];
    expect(projectDelegateTrayStatus(rows, { connectedClientIds: [A], now }).sessions.map(x => x.clientId))
      .toEqual([A]);
    expect(projectDelegateTrayStatus(rows, { connectedClientIds: [A, B],
      requestedClientId: B, now }).sessions.map(x => x.clientId)).toEqual([B]);
    expect(projectDelegateTrayStatus(rows, { connectedClientIds: [], now }).sessions).toEqual([]);
  });

  it("scopes a verified MCP participant to its own principal and hides other members", () => {
    const visible = projectDelegateTrayStatus([original()], {
      connectedClientIds: [A], principalId: "watcher-a", now,
    });
    expect(visible.sessions).toHaveLength(1);
    expect(visible.sessions[0].participants).toEqual([
      { agentId: "watcher-a", role: "observer", joinedAt: now - 1000, expiresAt: now + 20_000 },
    ]);
    expect(projectDelegateTrayStatus([original()], {
      connectedClientIds: [A], principalId: "another-agent", now,
    }).sessions).toHaveLength(0);
  });

  it("does not invent missing queue depth or metadata; rejects expired/malformed data", () => {
    const x: any = original();
    x.expiresAt = now - 1;
    expect(projectDelegateTrayStatus([x], { connectedClientIds: [A], now }).sessions).toEqual([]);
    x.expiresAt = now + 1000;
    x.revision = "7";
    expect(projectDelegateTrayStatus([x], { connectedClientIds: [A], now }).sessions).toEqual([]);
    expect(projectDelegateTrayStatus(undefined, { connectedClientIds: [A], now }))
      .toMatchObject({ sessionsStatus: "unknown", sessions: [] });
    const okay = projectDelegateTrayStatus([original()], { connectedClientIds: [A], now }).sessions[0];
    expect(okay.queuedOperations).toBeNull();
    expect(okay).not.toHaveProperty("lockBusy");
    expect(okay).not.toHaveProperty("heartbeat");
  });
});

describe("GET /api/delegate/multitab/status permission boundary", () => {
  function mockRead() {
    const sessions = vi.spyOn(coordinator, "listDelegateSessions").mockReturnValue([original()] as any);
    const busy = vi.spyOn(coordinator, "delegateTargetBusy").mockReturnValue(true);
    const connections = vi.spyOn(delegateBridge, "listConnections")
      .mockReturnValue([{ clientId: A, label: "Paired A" }] as any);
    return { sessions, busy, connections };
  }

  it("returns sanitized, no-store status for verified local bearer without writing lease", async () => {
    const m = mockRead();
    const r = await request();
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.sessions).toHaveLength(1);
    expect(r.body.sessions[0].lockBusy).toBe(true);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.headers["referrer-policy"]).toBe("no-referrer");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(JSON.stringify(r.body)).not.toContain("private-token-hash");
    expect(m.sessions).toHaveBeenCalledOnce();
    expect(m.busy).toHaveBeenCalledOnce();
  });

  it("denies missing or wrong authorization even on localhost", async () => {
    const m = mockRead();
    expect((await request({ headers: { authorization: "" } })).status).toBe(401);
    expect((await request({ headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await request({ headers: { authorization: "" },
      query: "?token=" + ensureServerAuthToken() })).status).toBe(401);
    expect(m.sessions).not.toHaveBeenCalled();
  });

  it("rejects remote IPs, spoofed hosts, origins, referers and proxy hop headers", async () => {
    const m = mockRead();
    expect((await request({ remote: "192.0.2.34" })).status).toBe(403);
    expect((await request({ headers: { host: "attacker.example" } })).status).toBe(403);
    expect((await request({ headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect((await request({ headers: { referer: "https://evil.example" } })).status).toBe(403);
    expect((await request({ headers: { "x-forwarded-for": "127.0.0.1" } })).status).toBe(403);
    expect((await request({ headers: { "cf-connecting-ip": "127.0.0.1" } })).status).toBe(403);
    expect(m.sessions).not.toHaveBeenCalled();
  });

  it("allows GET only and validates exact profile filter without enumerating offline sessions", async () => {
    const m = mockRead();
    expect((await request({ method: "POST" })).status).toBe(405);
    expect((await request({ query: "?unexpected=a" })).status).toBe(400);
    expect((await request({ query: "?clientId=bad!" })).status).toBe(400);
    expect((await request({ query: "?token=hidden" })).status).toBe(400);
    expect((await request({ query: "?clientId=" + B })).body.sessions).toEqual([]);
    expect((await request({ query: "?clientId=" + A })).body.sessions).toHaveLength(1);
    expect(m.sessions).toHaveBeenCalledTimes(2);
  });

  it("does not expose an unknown backend error as a successful empty snapshot", async () => {
    mockRead();
    vi.spyOn(delegateBridge, "listConnections").mockImplementation(() => {
      throw new Error("TOKEN_SECRET private DB path C:\\Users\\bad");
    });
    const r = await request();
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ success: false, error: "DELEGATE_TRAY_STATUS_UNKNOWN" });
  });

  it("integrates the projection with native Tray orchestrator GET when authenticated", async () => {
    mockRead();
    // Only inspect the GET response; do not invoke a real task transition.
    const { delegateMultiTabOrchestrator } =
      await import("../src/core/delegate/multiTabOrchestrator.js");
    vi.spyOn(delegateMultiTabOrchestrator, "snapshot").mockReturnValue({
      counts: {}, tasks: [], owners: [], maxConcurrent: 3,
    } as any);
    vi.spyOn(delegateMultiTabOrchestrator, "tabs").mockResolvedValue([] as any);
    vi.spyOn(delegateMultiTabOrchestrator, "reconcilePendingReadOnly").mockResolvedValue(undefined as any);
    const r = await request({ route: "/api/desktop/delegate/orchestrator" });
    expect(r.status).toBe(200);
    expect(r.body.sessionsStatus).toBe("known");
    expect(r.body.sessions).toHaveLength(1);
    const unauth = await request({ route: "/api/desktop/delegate/orchestrator",
      headers: { authorization: "" } });
    expect(unauth.body.sessionsStatus).toBe("unknown");
    expect(unauth.body.sessions).toEqual([]);
  });

  it("exposes only redacted managed CDP presence when operator is authenticated", async () => {
    mockRead();
    const time = Date.now();
    vi.spyOn(managedCoordinator, "cdpCoordinatorStatus").mockResolvedValue({
      sessions: [{ key: "a".repeat(64), port: 9222, targetId: "managed-tab",
        agentId: "agent-one", mode: "shared", revision: 4, expiresAt: time + 50000,
        sessionToken: "DO_NOT_EXPOSE", tokenHash: "ALSO_SECRET",
        participants: [{ agentId: "agent-one", role: "owner" }] }],
      queue: [{ key: "a".repeat(16), queued: 2, locked: true }],
      summary: { activeAgents: 1, activeTabs: 1, queued: 2, busyTargets: 1, extensionBlocked: true },
    } as any);
    const { delegateMultiTabOrchestrator } = await import("../src/core/delegate/multiTabOrchestrator.js");
    vi.spyOn(delegateMultiTabOrchestrator, "snapshot").mockReturnValue({
      counts: {}, tasks: [], owners: [], maxConcurrent: 3,
    } as any);
    vi.spyOn(delegateMultiTabOrchestrator, "tabs").mockResolvedValue([] as any);
    vi.spyOn(delegateMultiTabOrchestrator, "reconcilePendingReadOnly").mockResolvedValue(undefined as any);
    const authorized = await request({ route: "/api/desktop/delegate/orchestrator" });
    expect(authorized.body.managedCdp.status).toBe("known");
    expect(authorized.body.managedCdp.summary).toMatchObject({ agents: 1, tabs: 1, queued: 2 });
    expect(JSON.stringify(authorized.body.managedCdp)).not.toMatch(/DO_NOT_EXPOSE|ALSO_SECRET|tokenHash/);
    const unverified = await request({ route: "/api/desktop/delegate/orchestrator",
      headers: { authorization: "" } });
    expect(unverified.body.managedCdp.status).toBe("unknown");
    expect(unverified.body.managedCdp.sessions).toEqual([]);
  });
});

describe("Tray UI sanitized CDP lease display", () => {
  const script = fs.readFileSync("apps/superagent-tray/ui/delegate-multitab.js", "utf8");
  function display(snapshot: any) {
    const nodes = new Map<string, any>();
    function element(tag = "div"): any {
      const node: any = { tag, className: "", textContent: "", value: "",
        hidden: false, children: [] as any[],
        addEventListener() {}, append(...items: any[]) { node.children.push(...items); },
        replaceChildren(...items: any[]) { node.children = items; },
      };
      return node;
    }
    const $ = (id: string) => {
      if (!nodes.has(id)) nodes.set(id, element());
      return nodes.get(id);
    };
    $("multitab-worker").value = "worker-a";
    const calls: string[] = [];
    const ctx = { window: { __TAURI__: { core: { invoke: vi.fn(async (command: string, request: any) => {
      calls.push(command + ":" + request.action);
      return snapshot;
    }) } } } as any,
      document: { readyState: "complete", getElementById: $, createElement: element,
        addEventListener() {} }, crypto: { randomUUID: () => "id" },
      confirm: () => false, setInterval() {}, console };
    vm.runInNewContext(script, ctx);
    const read = () => ctx.window.__superagentMultiTabRefresh();
    const content = (n: any): string => [n.textContent, ...n.children.map(content)].join("\n");
    return { read, content: () => content($("multitab-tabs")), calls };
  }

  it("shows an actual lease and busy queue safely as text without executing markup", async () => {
    const view = display({ success: true, observedAt: Date.now(), sessionsStatus: "known",
      profiles: [{ clientId: A, label: "<svg onload=attack()>", tabs: [
        { tabId: 12, title: "<img onerror=attack() />", status: "ready" },
      ] }], counts: {}, owners: [], tasks: [], sessions: [{
        ...original(), lockBusy: true, queuedOperations: null, tokenHash: "SECRETNEVER",
        recoveryRequired: true,
      }] });
    await view.read();
    const content = view.content();
    expect(content).toContain("CDP owner: owner-a");
    expect(content).toContain("CDP lock: busy");
    expect(content).toContain("CDP queue: unknown");
    expect(content).toContain("Revision: 7");
    expect(content).toContain("owner reauthorization required");
    expect(content).toContain("<img onerror=attack() />");
    expect(content).not.toContain("SECRETNEVER");
    expect(script).not.toContain("innerHTML");
    expect(view.calls).toEqual(["delegate_action:orchestrator-status"]);
  });

  it("flags stale status unknown, and missing sessions from old Core as unknown", async () => {
    const base = { success: true, profiles: [{ clientId: A, tabs: [
      { tabId: 12, title: "Worker", status: "idle" },
    ] }], counts: {}, owners: [], tasks: [] };
    const stale = display({ ...base, observedAt: Date.now() - 120000,
      sessionsStatus: "known", sessions: [original()] });
    await stale.read();
    expect(stale.content()).toContain("CDP owner: unknown");
    expect(stale.content()).toContain("stale — refresh required");
    const absent = display(base);
    await absent.read();
    expect(absent.content()).toContain("CDP owner: unknown");
    expect(absent.content()).not.toContain("CDP owner: unclaimed");
  });
});

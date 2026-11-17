/**
 * mcpSessionRegistry.test.ts - unit tests for the per-session MCP registry.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  McpSessionRegistry,
  safeMcpClaimedClientLabel,
  type McpSessionEntry,
} from "../src/core/mcp/mcpSessionRegistry.js";
import type { McpIdentity } from "../src/core/mcp/mcpAuth.js";

function identity(subject = "bearer"): McpIdentity {
  return { mode: "static-bearer", subject, scopes: [], credentialHash: "abc" };
}

function fakeTransport() {
  return { close: async () => {} } as unknown as import("@modelcontextprotocol/sdk/server/streamableHttp.js").StreamableHTTPServerTransport;
}

function entry(id: string, subject = "bearer"): McpSessionEntry {
  return {
    sessionId: id,
    transport: fakeTransport(),
    identity: identity(subject),
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("McpSessionRegistry", () => {
  let reg: McpSessionRegistry;
  beforeEach(() => {
    reg = new McpSessionRegistry({ maxSessions: 4, idleTimeoutMs: 60000, maxLifetimeMs: 60000 });
  });
  afterEach(() => vi.useRealTimers());

  it("projects only live opaque sessions and marks every client name as untrusted metadata", async () => {
    const a=entry("private-secret-session", "principal-a");
    a.claimedClientName="Gemini";
    a.claimedClientVersion="1.0";
    reg.add(a);
    reg.noteToolRequest(a.sessionId, "superagent_list_projects");
    reg.beginRequest(a.sessionId);
    const busy=reg.connectedAgentSessions();
    expect(busy).toHaveLength(1);
    expect(busy[0]).toMatchObject({
      authMode:"static-bearer",claimedClientName:"Gemini",state:"active",
      inFlight:1,lastToolRequest:"superagent_list_projects",
    });
    expect(busy[0].sessionHandle).toMatch(/^ses_[a-f0-9]{12}$/);
    expect(busy[0].principalHandle).toMatch(/^idh_[a-f0-9]{16}$/);
    expect(JSON.stringify(busy)).not.toContain("private-secret-session");
    expect(JSON.stringify(busy)).not.toContain("principal-a");
    expect(JSON.stringify(busy)).not.toContain('"credentialHash"');
    reg.endRequest(a.sessionId);
    expect(reg.connectedAgentSessions()[0].state).toBe("idle");
    await reg.remove(a.sessionId);
    expect(reg.connectedAgentSessions()).toEqual([]);
  });

  it("sanitizes client-supplied labels and never treats them as authenticated app names", () => {
    expect(safeMcpClaimedClientLabel("  ChatGPT\u202e  ")).toBe("ChatGPT");
    expect(safeMcpClaimedClientLabel("<script>fake</script>")).toBe("<script>fake</script>");
    expect(safeMcpClaimedClientLabel("x".repeat(70))).toBeNull();
    expect(safeMcpClaimedClientLabel(null)).toBeNull();
    reg.add(entry("s1"));
    reg.noteToolRequest("s1","javascript:steal");
    expect(reg.connectedAgentSessions()[0].lastToolRequest).toBeNull();
  });

  it("only includes genuinely idle sessions in oldestIdleMs, not open requests", () => {
    const idle = entry("s1");
    const busy = entry("s2");
    idle.lastActivityAt = 2_000;
    busy.lastActivityAt = 1_000;
    reg.add(idle);
    reg.add(busy);
    reg.beginRequest("s2");
    expect(reg.snapshot(10_000).oldestIdleMs).toBe(8_000);
    reg.endRequest("s2");
    reg.touch("s1");
    expect(reg.snapshot(10_000).oldestIdleMs).toBeGreaterThanOrEqual(0);
  });
  it("adds and retrieves sessions", () => {
    reg.add(entry("s1"));
    expect(reg.size).toBe(1);
    expect(reg.get("s1")?.sessionId).toBe("s1");
    expect(reg.get("nope")).toBeUndefined();
  });

  it("rejects duplicate session IDs", () => {
    reg.add(entry("s1"));
    expect(() => reg.add(entry("s1"))).toThrow("already registered");
  });

  it("enforces max concurrent sessions", () => {
    reg.add(entry("s1"));
    reg.add(entry("s2"));
    reg.add(entry("s3"));
    reg.add(entry("s4"));
    expect(reg.isFull()).toBe(true);
    expect(() => reg.add(entry("s5"))).toThrow("too many");
    expect(reg.snapshot().rejectedGlobal).toBe(1);
  });

  it("caps one authenticated principal without starving another", () => {
    const r = new McpSessionRegistry({
      maxSessions: 6,
      maxSessionsPerPrincipal: 2,
      idleTimeoutMs: 60000,
      maxLifetimeMs: 60000,
    });
    r.add(entry("a1", "principal-a"));
    r.add(entry("a2", "principal-a"));
    expect(r.isFullFor(identity("principal-a"))).toBe(true);
    expect(() => r.add(entry("a3", "principal-a")))
      .toThrow("too many concurrent MCP sessions for principal");
    r.add(entry("b1", "principal-b"));
    const stats = r.snapshot();
    expect(stats.activeSessions).toBe(3);
    expect(stats.activePrincipals).toBe(2);
    expect(stats.largestPrincipalSessionCount).toBe(2);
    expect(stats.rejectedPrincipal).toBe(1);
  });

  it("removes sessions and closes their transport", async () => {
    let closed = false;
    const e = entry("s1");
    e.transport = { close: async () => { closed = true; } } as any;
    reg.add(e);
    expect(await reg.remove("s1")).toBe(true);
    expect(closed).toBe(true);
    expect(reg.get("s1")).toBeUndefined();
    expect(await reg.remove("s1")).toBe(false);
  });

  it("notifies an outer owner exactly once with the removal reason", async () => {
    const removed: Array<{id:string;reason:string}> = [];
    const r = new McpSessionRegistry({
      maxSessions: 4,
      idleTimeoutMs: 60000,
      maxLifetimeMs: 60000,
      onSessionRemoved: (sessionId, reason) => removed.push({id:sessionId,reason}),
    });
    r.add(entry("s1"));
    expect(await r.remove("s1", "client_delete")).toBe(true);
    expect(await r.remove("s1", "client_delete")).toBe(false);
    expect(removed).toEqual([{id:"s1",reason:"client_delete"}]);
    expect(r.snapshot().removals.client_delete).toBe(1);
  });

  it("touch updates lastActivityAt", async () => {
    reg.add(entry("s1"));
    const before = reg.get("s1")!.lastActivityAt;
    await sleep(5);
    reg.touch("s1");
    expect(reg.get("s1")!.lastActivityAt).toBeGreaterThanOrEqual(before);
    reg.touch("missing"); // no throw
  });

  it("removes idle sessions after the idle timeout", async () => {
    const removed: string[] = [];
    const r = new McpSessionRegistry({
      idleTimeoutMs: 30,
      maxLifetimeMs: 60000,
      onSessionRemoved: (sessionId) => removed.push(sessionId),
    });
    r.add(entry("idle1"));
    expect(r.get("idle1")).toBeDefined();
    await sleep(80);
    expect(r.get("idle1")).toBeUndefined();
    expect(removed).toEqual(["idle1"]);
  });

  it("keeps sessions alive while they are touched", async () => {
    const r = new McpSessionRegistry({ idleTimeoutMs: 180, maxLifetimeMs: 60000 });
    r.add(entry("busy"));
    for (let i = 0; i < 3; i++) {
      await sleep(40);
      r.touch("busy");
    }
    expect(r.get("busy")).toBeDefined();
    await r.closeAll();
  });

  it("removes sessions after max lifetime", async () => {
    const r = new McpSessionRegistry({ idleTimeoutMs: 60000, maxLifetimeMs: 30 });
    r.add(entry("old"));
    await sleep(80);
    expect(r.get("old")).toBeUndefined();
  });

  it("closeAll removes every session", async () => {
    reg.add(entry("s1"));
    reg.add(entry("s2"));
    await reg.closeAll();
    expect(reg.size).toBe(0);
  });

  it("proactively evicts oldest idle session when principal limit is reached", async () => {
    const r = new McpSessionRegistry({
      maxSessions: 4,
      maxSessionsPerPrincipal: 2,
      minIdleAgeMs: 20,
    });
    r.add(entry("p1", "user-1"));
    await sleep(25);
    r.add(entry("p2", "user-1"));
    expect(r.size).toBe(2);
    // Adding 3rd session for user-1 should evict p1 (which is >20ms idle)
    r.add(entry("p3", "user-1"));
    expect(r.get("p1")).toBeUndefined();
    expect(r.get("p2")).toBeDefined();
    expect(r.get("p3")).toBeDefined();
    expect(r.size).toBe(2);
    expect(r.snapshot().removals.capacity_eviction).toBe(1);
  });

  it("never evicts in-flight sessions even under capacity pressure", async () => {
    const r = new McpSessionRegistry({
      maxSessions: 4,
      maxSessionsPerPrincipal: 2,
      minIdleAgeMs: 20,
    });
    r.add(entry("p1", "user-1"));
    r.beginRequest("p1");
    await sleep(25);
    r.add(entry("p2", "user-1"));
    // p1 is in-flight, p2 is fresh (<20ms). Adding p3 must throw because no eligible idle session exists.
    expect(() => r.add(entry("p3", "user-1")))
      .toThrow("too many concurrent MCP sessions for principal");
    expect(r.get("p1")).toBeDefined();
    expect(r.get("p2")).toBeDefined();
    expect(r.get("p3")).toBeUndefined();
    // When p1 finishes it gets a fresh idle timestamp; p2 is now the oldest
    // eligible idle session, so pressure must evict p2 rather than p1.
    await sleep(5); // Distinguish p2 idle age from p1's freshly-ended request.
    r.endRequest("p1");
    await sleep(25);
    r.add(entry("p3", "user-1"));
    expect(r.get("p1")).toBeDefined();
    expect(r.get("p2")).toBeUndefined();
    expect(r.get("p3")).toBeDefined();
  });

  it("globally evicts oldest idle session when global maxSessions is reached", async () => {
    const r = new McpSessionRegistry({
      maxSessions: 2,
      maxSessionsPerPrincipal: 2,
      minIdleAgeMs: 20,
    });
    r.add(entry("g1", "user-a"));
    await sleep(25);
    r.add(entry("g2", "user-b"));
    expect(r.isFull()).toBe(true);
    // Global eviction should evict g1
    r.add(entry("g3", "user-c"));
    expect(r.get("g1")).toBeUndefined();
    expect(r.get("g2")).toBeDefined();
    expect(r.get("g3")).toBeDefined();
    expect(r.snapshot().removals.capacity_eviction).toBe(1);
  });

  it("does not expire an SSE or tool request while its response is in flight", async () => {
    vi.useFakeTimers();
    const closed = vi.fn(async () => {});
    const r = new McpSessionRegistry({ idleTimeoutMs: 25, maxLifetimeMs: 10_000 });
    const e = entry("stream");
    e.transport = { close: closed } as any;
    r.add(e);
    r.beginRequest("stream");
    await vi.advanceTimersByTimeAsync(50);
    expect(r.size).toBe(1);
    expect(r.snapshot()).toMatchObject({ activeSessions: 1, inFlightSessions: 1, retiringSessions: 0 });
    r.endRequest("stream");
    await vi.advanceTimersByTimeAsync(26);
    expect(r.size).toBe(0);
    expect(r.snapshot().removals.idle_timeout).toBe(1);
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it("defers maximum lifetime until all active responses close, rejecting new binds", async () => {
    vi.useFakeTimers();
    const closed = vi.fn(async () => {});
    const r = new McpSessionRegistry({ idleTimeoutMs: 10_000, maxLifetimeMs: 30 });
    const e = entry("busy");
    e.transport = { close: closed } as any;
    r.add(e);
    r.beginRequest("busy");
    r.beginRequest("busy");
    await vi.advanceTimersByTimeAsync(31);
    expect(r.isRetiring("busy")).toBe(true);
    expect(r.snapshot()).toMatchObject({ activeSessions: 1, inFlightSessions: 1, retiringSessions: 1 });
    r.endRequest("busy");
    expect(r.size).toBe(1);
    r.endRequest("busy");
    await Promise.resolve();
    expect(r.get("busy")).toBeUndefined();
    expect(r.snapshot().removals.max_lifetime).toBe(1);
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it("defers DELETE until the accepted tool call finishes and rejects re-use", async () => {
    vi.useFakeTimers();
    const removed: string[] = [];
    const closed = vi.fn(async () => {});
    const r = new McpSessionRegistry({
      idleTimeoutMs: 20, maxLifetimeMs: 60_000,
      onSessionRemoved: (_id, reason) => removed.push(reason),
    });
    const e = entry("active-delete");
    e.transport = { close: closed } as any;
    r.add(e);
    r.beginRequest("active-delete");
    expect(await r.remove("active-delete", "client_delete")).toBe(true);
    expect(r.isRetiring("active-delete")).toBe(true);
    expect(r.snapshot()).toMatchObject({ activeSessions: 1, inFlightSessions: 1, retiringSessions: 1 });
    expect(closed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(25);
    expect(r.get("active-delete")).toBeDefined();
    r.endRequest("active-delete");
    await Promise.resolve();
    expect(r.get("active-delete")).toBeUndefined();
    expect(closed).toHaveBeenCalledTimes(1);
    expect(removed).toEqual(["client_delete"]);
  });

  it("defers transport-close removal while another MCP call is in flight", async () => {
    vi.useFakeTimers();
    const r = new McpSessionRegistry({ idleTimeoutMs: 15, maxLifetimeMs: 60_000 });
    r.add(entry("sse-tool"));
    r.beginRequest("sse-tool");
    expect(await r.remove("sse-tool", "transport_close")).toBe(true);
    await vi.advanceTimersByTimeAsync(30);
    expect(r.isRetiring("sse-tool")).toBe(true);
    r.endRequest("sse-tool");
    expect(r.snapshot()).toMatchObject({ activeSessions: 0, retiringSessions: 0 });
    expect(r.snapshot().removals.transport_close).toBe(1);
  });

  it("does not keep expired entries or pending lifetime state after explicit close", async () => {
    vi.useFakeTimers();
    const r = new McpSessionRegistry({ idleTimeoutMs: 10_000, maxLifetimeMs: 30 });
    r.add(entry("s1"));
    r.beginRequest("s1");
    await vi.advanceTimersByTimeAsync(31);
    expect(r.isRetiring("s1")).toBe(true);
    expect(await r.remove("s1", "client_delete")).toBe(true);
    r.endRequest("s1");
    expect(r.snapshot()).toMatchObject({ activeSessions: 0, inFlightSessions: 0, retiringSessions: 0 });
    await r.closeAll();
  });

  it("grants static-bearer principal a generous default ceiling up to 32", () => {
    const r = new McpSessionRegistry({ maxSessions: 64 });
    const bearerId = identity("bearer");
    expect(r.maxSessionsFor(bearerId)).toBe(32);
    const oauthId = { mode: "oauth" as const, subject: "app-client", scopes: [], credentialHash: "def" };
    expect(r.maxSessionsFor(oauthId)).toBe(16);
  });
});

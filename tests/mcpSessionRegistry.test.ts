/**
 * mcpSessionRegistry.test.ts - unit tests for the per-session MCP registry.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  McpSessionRegistry,
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
});

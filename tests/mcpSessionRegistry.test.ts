/**
 * mcpSessionRegistry.test.ts - unit tests for the per-session MCP registry.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  McpSessionRegistry,
  type McpSessionEntry,
} from "../src/core/mcp/mcpSessionRegistry.js";
import type { McpIdentity } from "../src/core/mcp/mcpAuth.js";

function identity(): McpIdentity {
  return { mode: "static-bearer", subject: "bearer", scopes: [], credentialHash: "abc" };
}

function fakeTransport() {
  return { close: async () => {} } as unknown as import("@modelcontextprotocol/sdk/server/streamableHttp.js").StreamableHTTPServerTransport;
}

function entry(id: string): McpSessionEntry {
  return {
    sessionId: id,
    transport: fakeTransport(),
    identity: identity(),
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

  it("touch updates lastActivityAt", async () => {
    reg.add(entry("s1"));
    const before = reg.get("s1")!.lastActivityAt;
    await sleep(5);
    reg.touch("s1");
    expect(reg.get("s1")!.lastActivityAt).toBeGreaterThanOrEqual(before);
    reg.touch("missing"); // no throw
  });

  it("removes idle sessions after the idle timeout", async () => {
    const r = new McpSessionRegistry({ idleTimeoutMs: 30, maxLifetimeMs: 60000 });
    r.add(entry("idle1"));
    expect(r.get("idle1")).toBeDefined();
    await sleep(80);
    expect(r.get("idle1")).toBeUndefined();
  });

  it("keeps sessions alive while they are touched", async () => {
    const r = new McpSessionRegistry({ idleTimeoutMs: 60, maxLifetimeMs: 60000 });
    r.add(entry("busy"));
    for (let i = 0; i < 3; i++) {
      await sleep(30);
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

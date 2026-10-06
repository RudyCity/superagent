/**
 * mcpLogSanitizer.test.ts - tests for MCP log redaction.
 */
import { describe, it, expect } from "vitest";
import {
  sanitizeValue,
  summarizeArgs,
  argShape,
  REDACTED,
} from "../src/core/mcp/mcpLogSanitizer.js";

describe("sanitizeValue", () => {
  it("redacts sensitive keys", () => {
    const out: any = sanitizeValue({
      authorization: "Bearer secret",
      apiKey: "key123",
      password: "hunter2",
      normal: "visible",
    });
    expect(out.authorization).toBe(REDACTED);
    expect(out.apiKey).toBe(REDACTED);
    expect(out.password).toBe(REDACTED);
    expect(out.normal).toBe("visible");
  });

  it("redacts nested secrets", () => {
    const out: any = sanitizeValue({
      config: { credentials: { token: "abc" }, name: "x" },
    });
    // "credentials" key itself matches -> whole subtree redacted (conservative).
    expect(out.config.credentials).toBe(REDACTED);
    expect(out.config.name).toBe("x");
    const out2: any = sanitizeValue({ config: { nested: { api_token: "abc" } } });
    expect(out2.config.nested.api_token).toBe(REDACTED);
  });

  it("truncates long file content", () => {
    const big = "x".repeat(5000);
    const out = sanitizeValue({ content: big }) as any;
    expect(out.content.length).toBeLessThan(5000);
    expect(out.content).toContain("truncated");
  });

  it("handles circular values", () => {
    const obj: any = { a: 1 };
    obj.self = obj;
    const out: any = sanitizeValue(obj);
    expect(out.self).toBe("[circular]");
    expect(out.a).toBe(1);
  });

  it("handles arrays and primitives", () => {
    expect(sanitizeValue([1, "a", null])).toEqual([1, "a", null]);
    expect(sanitizeValue(42)).toBe(42);
    expect(sanitizeValue(null)).toBeNull();
  });

  it("never throws on malformed input", () => {
    expect(() => sanitizeValue(Object.create(null))).not.toThrow();
    const evil = { get x(): unknown { throw new Error("boom"); } };
    expect(() => sanitizeValue(evil)).not.toThrow();
  });
});

describe("summarizeArgs", () => {
  it("redacts bearer tokens from tool args", () => {
    const s = summarizeArgs({ command: "curl -H 'Authorization: Bearer secret123' https://x" });
    // The command string itself is preserved (bounded), but keyed secrets are redacted.
    expect(s).toContain("curl");
    const s2 = summarizeArgs({ headers: { Authorization: "Bearer secret123" } });
    expect(s2).not.toContain("secret123");
    expect(s2).toContain(REDACTED);
  });

  it("bounds long summaries", () => {
    const s = summarizeArgs({ data: "y".repeat(5000) });
    expect(s.length).toBeLessThan(1000);
  });

  it("handles unserializable values", () => {
    expect(summarizeArgs(undefined)).toBe("<undefined>");
  });
});

describe("argShape", () => {
  it("describes shape without values", () => {
    const shape = argShape({ command: "echo hi", nested: { a: 1 }, list: [1, 2] });
    expect(shape).toContain("command:string");
    expect(shape).toContain("nested:object");
    expect(shape).toContain("list:array");
    expect(shape).not.toContain("echo hi");
  });
});

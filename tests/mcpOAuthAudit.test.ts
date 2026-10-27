import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createMcpOAuthAuditLogger } from "../src/core/mcp/mcpOAuthAudit.js";

describe("MCP OAuth audit diagnostics", () => {
  let tempDir = "";

  afterEach(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = "";
  });

  it("persists only allow-listed diagnostic fields and omits credential-shaped extras", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-oauth-audit-"));
    const filePath = path.join(tempDir, "audit.jsonl");
    const log = createMcpOAuthAuditLogger(filePath);

    log({
      stage: "oauth.token_request",
      method: "POST",
      statusCode: 200,
      durationMs: 12.6,
      accessToken: "should-not-be-serialized",
      authorizationCode: "should-not-be-serialized",
      clientId: "should-not-be-serialized",
      state: "should-not-be-serialized",
    } as any);

    const raw = fs.readFileSync(filePath, "utf8");
    const event = JSON.parse(raw.trim());
    expect(event.stage).toBe("oauth.token_request");
    expect(event.method).toBe("POST");
    expect(event.statusCode).toBe(200);
    expect(event.durationMs).toBe(13);
    expect(raw).not.toContain("should-not-be-serialized");
    expect(event).not.toHaveProperty("accessToken");
    expect(event).not.toHaveProperty("authorizationCode");
    expect(event).not.toHaveProperty("clientId");
    expect(event).not.toHaveProperty("state");
  });

  it("rotates the audit file before it grows without bound", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-oauth-audit-rotate-"));
    const filePath = path.join(tempDir, "audit.jsonl");
    fs.writeFileSync(filePath, "x".repeat(5 * 1024 * 1024), { mode: 0o600 });
    const log = createMcpOAuthAuditLogger(filePath);

    log({ stage: "mcp.initialize", method: "POST", statusCode: 200 });

    expect(fs.statSync(filePath + ".1").size).toBe(5 * 1024 * 1024);
    const current = JSON.parse(fs.readFileSync(filePath, "utf8").trim());
    expect(current.stage).toBe("mcp.initialize");
    expect(current.statusCode).toBe(200);
  });

  it("persists validated auth diagnostics for rejected probes only", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-oauth-audit-auth-"));
    const filePath = path.join(tempDir, "audit.jsonl");
    const log = createMcpOAuthAuditLogger(filePath);

    log({
      stage: "mcp.endpoint_probe",
      method: "POST",
      statusCode: 401,
      authHeader: "bearer",
      credentialHashPrefix: "abcdef012345",
    });
    log({
      stage: "mcp.endpoint_probe",
      method: "POST",
      statusCode: 401,
      authHeader: "Bearer" as any,
      credentialHashPrefix: "not-a-hash" as any,
    });

    const events = fs.readFileSync(filePath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(events[0].authHeader).toBe("bearer");
    expect(events[0].credentialHashPrefix).toBe("abcdef012345");
    expect(events[1]).not.toHaveProperty("authHeader");
    expect(events[1]).not.toHaveProperty("credentialHashPrefix");
  });

  it("does not throw when the audit path is unavailable", () => {
    const log = createMcpOAuthAuditLogger(path.join(os.tmpdir(), "not-a-directory", "subdir", "audit.jsonl"));
    expect(() => log({
      stage: "mcp.initialize",
      method: "POST",
      statusCode: 200,
    })).not.toThrow();
  });
});

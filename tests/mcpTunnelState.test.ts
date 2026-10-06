/**
 * mcpTunnelState.test.ts - disk-state persistence + cross-workspace listing
 * for the MCP tunnel module.
 *
 * Uses an isolated HOME/USERPROFILE so the real ~/.superagent-r is untouched.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "path";
import os from "os";
import fs from "fs";
import {
  getMcpStateFile,
  readMcpStateFile,
  listActiveMcpServers,
  formatActiveMcpServers,
  type McpServerState,
} from "../src/core/mcp/mcpTunnel.js";

const TEST_PORT = 19227;

function sampleState(overrides: Partial<McpServerState> = {}): McpServerState {
  return {
    port: TEST_PORT,
    pid: process.pid,
    publicUrl: "https://example.trycloudflare.com/mcp",
    localUrl: `http://127.0.0.1:${TEST_PORT}/mcp`,
    toolMode: "safe",
    startedAt: Date.now() - 5000,
    workspace: "D:\\test-workspace",
    ...overrides,
  };
}

describe("mcpTunnel disk state (cross-workspace listing)", () => {
  let tmpHome: string;
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-state-test-"));
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    } catch {}
  });

  it("writes and reads back state for a port", () => {
    const state = sampleState();
    const file = getMcpStateFile(state.port);
    fs.writeFileSync(file, JSON.stringify(state, null, 2), "utf-8");
    const back = readMcpStateFile(file);
    expect(back?.port).toBe(state.port);
    expect(back?.pid).toBe(process.pid);
    expect(back?.publicUrl).toBe(state.publicUrl);
    expect(back?.workspace).toBe(state.workspace);
    expect(back?.toolMode).toBe("safe");
  });

  it("listActiveMcpServers sees a foreign server written to disk (live PID)", () => {
    const startedAt = Date.now() - 42_000;
    const state = sampleState({ toolMode: "dangerous", startedAt });
    fs.writeFileSync(getMcpStateFile(state.port), JSON.stringify(state), "utf-8");
    const list = listActiveMcpServers();
    const found = list.find((m) => m.port === state.port);
    expect(found).toBeDefined();
    expect(found?.pid).toBe(process.pid);
    expect(found?.publicUrl).toBe(state.publicUrl);
    expect(found?.workspace).toBe(state.workspace);
    expect(found!.uptimeSeconds).toBeGreaterThanOrEqual(40);
  });

  it("listActiveMcpServers deletes stale files whose PID is gone", () => {
    const deadPid = 2147483647; // cannot be a live PID
    const state = sampleState({ port: TEST_PORT + 1, pid: deadPid });
    const file = getMcpStateFile(state.port);
    fs.writeFileSync(file, JSON.stringify(state), "utf-8");
    const list = listActiveMcpServers();
    expect(list.find((m) => m.port === state.port)).toBeUndefined();
    expect(fs.existsSync(file)).toBe(false);
  });

  it("readMcpStateFile rejects malformed state", () => {
    const file = getMcpStateFile(TEST_PORT + 2);
    fs.writeFileSync(file, "{not json", "utf-8");
    expect(readMcpStateFile(file)).toBeNull();
    const missing = sampleState({ port: "x" as unknown as number });
    const file2 = getMcpStateFile(TEST_PORT + 3);
    fs.writeFileSync(file2, JSON.stringify(missing), "utf-8");
    expect(readMcpStateFile(file2)).toBeNull();
  });

  it("formatActiveMcpServers renders section header and NONE ACTIVE", () => {
    const empty = formatActiveMcpServers([]);
    expect(empty).toContain("Active MCP Servers: NONE ACTIVE");
    const out = formatActiveMcpServers([
      {
        ...sampleState({ workspace: "D:\\ws2" }),
        uptimeSeconds: 60,
      },
    ]);
    expect(out).toContain("Active MCP Servers (1):");
    expect(out).toContain(`Port ${TEST_PORT}`);
    expect(out).toContain("D:\\ws2");
  });
});

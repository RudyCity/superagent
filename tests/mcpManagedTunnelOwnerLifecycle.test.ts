import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const mocks = vi.hoisted(() => ({
  readListenerOwners: vi.fn(),
  verifyWindowsProcessBirth: vi.fn(),
  isProcessRunning: vi.fn(),
  listActiveMcpServers: vi.fn(),
  readMcpStateFile: vi.fn(),
}));

vi.mock("../src/core/runtime/coreMcpOwnershipAudit.js", () => ({
  readListenerOwners: mocks.readListenerOwners,
}));

vi.mock("../src/core/runtime/mcpProcessBirth.js", () => ({
  verifyWindowsProcessBirth: mocks.verifyWindowsProcessBirth,
}));

vi.mock("../src/core/remoteAgent/cloudflareTunnel.js", () => ({
  isProcessRunning: mocks.isProcessRunning,
}));

vi.mock("../src/core/mcp/mcpTunnel.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/mcp/mcpTunnel.js")>();
  return {
    ...actual,
    listActiveMcpServers: mocks.listActiveMcpServers,
    readMcpStateFile: mocks.readMcpStateFile,
  };
});

import {
  verifyManagedOwnerIdentity,
  stopManagedMcpTunnelOwner,
  startManagedMcpTunnelOwner,
  readManagedMcpTunnelLease,
  type ManagedMcpTunnelLease,
} from "../src/core/runtime/mcpManagedTunnelOwner.js";

describe("Managed MCP Tunnel Owner Lifecycle and Stale Lease Recovery", () => {
  let tempHome: string;
  let homedirSpy: { mockRestore(): void };
  const TEST_PORT = 19883;

  beforeEach(() => {
    vi.clearAllMocks();
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "managed-mcp-owner-test-"));
    homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(tempHome);
    mocks.readListenerOwners.mockReturnValue(new Map());
    mocks.verifyWindowsProcessBirth.mockReturnValue("matched");
    mocks.isProcessRunning.mockReturnValue(false);
    mocks.listActiveMcpServers.mockReturnValue([]);
    mocks.readMcpStateFile.mockReturnValue(null);
  });

  afterEach(() => {
    homedirSpy?.mockRestore();
    try {
      fs.rmSync(tempHome, { recursive: true, force: true });
    } catch {}
  });

  function writeTestLease(port: number, pid: number): ManagedMcpTunnelLease {
    const dir = path.join(tempHome, ".superagent-r");
    fs.mkdirSync(dir, { recursive: true });
    const lease: ManagedMcpTunnelLease = {
      version: 1,
      kind: "managed_mcp_tunnel_owner",
      pid,
      port,
      nonce: "a".repeat(64),
      createdAt: Date.now(),
      workspace: process.cwd(),
    };
    fs.writeFileSync(path.join(dir, `mcp-owner-${port}.json`), JSON.stringify(lease) + "\n");
    return lease;
  }

  it("verifyManagedOwnerIdentity succeeds when listener appears after a short propagation delay", async () => {
    const lease = writeTestLease(TEST_PORT, 4567);
    mocks.readMcpStateFile.mockReturnValue({ port: TEST_PORT, pid: 4567 });
    mocks.isProcessRunning.mockReturnValue(true);

    let attempts = 0;
    mocks.readListenerOwners.mockImplementation(() => {
      attempts++;
      const map = new Map<number, number>();
      // Simulate Windows kernel listener appearing on the 3rd poll
      if (attempts >= 3) {
        map.set(TEST_PORT, 4567);
      }
      return map;
    });

    await expect(
      verifyManagedOwnerIdentity(lease, { timeoutMs: 2_000, pollIntervalMs: 50 }),
    ).resolves.toBeUndefined();
    expect(attempts).toBeGreaterThanOrEqual(3);
  });

  it("verifyManagedOwnerIdentity throws when listener never matches within timeout", async () => {
    const lease = writeTestLease(TEST_PORT, 4567);
    mocks.readMcpStateFile.mockReturnValue({ port: TEST_PORT, pid: 4567 });
    mocks.isProcessRunning.mockReturnValue(true);
    mocks.readListenerOwners.mockReturnValue(new Map());

    await expect(
      verifyManagedOwnerIdentity(lease, { timeoutMs: 200, pollIntervalMs: 50 }),
    ).rejects.toThrow("MCP tunnel owner identity does not match state and kernel listener");
  });

  it("stopManagedMcpTunnelOwner cleanly removes stale lease when owner process is dead", async () => {
    writeTestLease(TEST_PORT, 99999);
    mocks.isProcessRunning.mockReturnValue(false); // Process is dead
    mocks.readListenerOwners.mockReturnValue(new Map()); // No listener

    expect(readManagedMcpTunnelLease(TEST_PORT)).not.toBeNull();

    const result = await stopManagedMcpTunnelOwner(TEST_PORT);
    expect(result.stopped).toBe(true);
    expect(result.activeSessions).toBe(0);

    // Stale lease should be completely removed
    expect(readManagedMcpTunnelLease(TEST_PORT)).toBeNull();
  });

  it("stopManagedMcpTunnelOwner with force removes stale lease when process is dead", async () => {
    writeTestLease(TEST_PORT, 99999);
    mocks.isProcessRunning.mockReturnValue(false);
    mocks.readListenerOwners.mockReturnValue(new Map());

    const result = await stopManagedMcpTunnelOwner(TEST_PORT, { force: true });
    expect(result.stopped).toBe(true);
    expect(readManagedMcpTunnelLease(TEST_PORT)).toBeNull();
  });

  it("startManagedMcpTunnelOwner throws when active owner lease process is still running", async () => {
    writeTestLease(TEST_PORT, 12345);
    mocks.isProcessRunning.mockReturnValue(true); // Active owner process is running

    await expect(
      startManagedMcpTunnelOwner(["--port", String(TEST_PORT)]),
    ).rejects.toThrow(`MCP port ${TEST_PORT} has an existing managed-owner lease; inspect it before retrying`);
  });

  it("startManagedMcpTunnelOwner cleans stale lease when process is dead and proceeds", async () => {
    writeTestLease(TEST_PORT, 99999);
    mocks.isProcessRunning.mockReturnValue(false); // Stale/dead owner
    mocks.readListenerOwners.mockReturnValue(new Map());

    // It should clean the lease; then attempt to fork entry (which fails because mock entry or succeeds in checking lease removal)
    try {
      await startManagedMcpTunnelOwner(["--port", String(TEST_PORT)], "non-existent-entry.js");
    } catch (e: any) {
      // The lease should have been cleaned BEFORE trying to stat the entry
      expect(readManagedMcpTunnelLease(TEST_PORT)).toBeNull();
      expect(e.message).not.toContain("has an existing managed-owner lease");
    }
  });
});

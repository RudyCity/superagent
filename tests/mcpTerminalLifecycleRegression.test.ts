import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProcessSupervisor } from "../src/core/process/processSupervisor.js";
import { discoverObservedMcpPort } from "../src/core/runtime/serviceManager.js";

describe("MCP terminal lifecycle and status regression", () => {
  it("selects a live registered MCP port, never a stale or mismatched port", () => {
    const records = [
      { port: 8857, pid: 111, startedAt: 100 },
      { port: 9230, pid: 222, startedAt: 200 },
      { port: 9330, pid: 333, startedAt: 300 },
    ];
    expect(discoverObservedMcpPort(new Map([[9230, 222]]), records)).toBe(9230);
    expect(discoverObservedMcpPort(new Map([[9230, 999]]), records)).toBe(8857);
    expect(discoverObservedMcpPort(null, records)).toBe(8857);
    expect(discoverObservedMcpPort(new Map([[8857, 111], [9230, 222]]), records)).toBe(9230);
    expect(discoverObservedMcpPort(new Map([[9230, 222], [9330, 333]]), records)).toBe(9330);
  });

  it("identifies missing subprocess PIDs as stale and durably records exit", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "superagent-mcp-lifecycle-"));
    const storagePath = path.join(root, "process-registry.json");
    try {
      const supervisor = new ProcessSupervisor({ storagePath });
      const record = await supervisor.registerProcess({
        component: "mcp_exec_command",
        executable: "node",
        args: ["--version"],
        workspaceRoot: root,
        launchIntent: "headless",
        cleanupPolicy: "caller_owned",
      });
      await supervisor.recordProcessSpawn(record.recordId, 99999999, {
        creationIdentity: "win:123456789012345678",
      });
      const stale = await supervisor.getProcessDiagnostics({ callerWorkspaceRoot: root });
      expect(stale.totalTracked).toBe(1);
      expect(stale.stalePidCount).toBe(1);
      expect(stale.entries[0].reason).toContain("STALE:");

      await supervisor.recordProcessExit(record.recordId, {
        exitCode: 0,
        source: "mcp_terminal_test",
      });
      // Reloading from disk is the durability check; no process signal is sent.
      const fromDisk = new ProcessSupervisor({ storagePath });
      const settled = await fromDisk.getProcessDiagnostics({ callerWorkspaceRoot: root });
      expect(settled.entries[0].state).toBe("exited");
      expect(settled.stalePidCount).toBe(0);
      expect(settled.terminalCount).toBe(1);
    } finally {
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});

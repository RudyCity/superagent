import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  getRuntimeMemorySnapshot,
  shouldThrottleLargeObservability,
  __setMockMemoryPressureLevel,
} from "../src/core/runtime/runtimeMemoryDiagnostics.js";
import {
  McpActivityJournal,
  resetActivityJournalForTests,
  type McpJournalEntry,
} from "../src/core/mcp/mcpActivityJournal.js";
import {
  emitMcpActivity,
  onMcpActivity,
} from "../src/core/mcp/mcpActivityBus.js";
import {
  createSession,
  killSession,
  __resetForTests as __resetSessionsForTests,
  getActiveSessionCount,
  sessionEmitters,
  sessionEventBuffers,
} from "../src/core/tools/cliBridgeSession.js";
import {
  pruneJobs,
  getRetainedJobCount,
  __resetDelegateJobsForTests,
} from "../src/core/tools/cliBridgeDelegateJobs.js";

describe("SuperAgent MCP Memory Lifecycle & Churn Verification (M0 / S1 / S3 / S4)", () => {
  let testDir: string;
  let journalPath: string;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `mcp-mem-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(testDir, { recursive: true });
    journalPath = path.join(testDir, "mcp-activity.jsonl");

    const customJournal = new McpActivityJournal({
      journalPath,
      maxJournalBytes: 256 * 1024, // 256 KB rotation for test
      maxArchives: 3,
    });
    resetActivityJournalForTests(customJournal);

    __resetSessionsForTests();
    await __resetDelegateJobsForTests();
  });

  afterEach(async () => {
    resetActivityJournalForTests();
    __resetSessionsForTests();
    await __resetDelegateJobsForTests();
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  it("captures runtime memory snapshot with accurate metrics and pressure evaluation", () => {
    const snap = getRuntimeMemorySnapshot();

    expect(snap.pid).toBe(process.pid);
    expect(snap.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(snap.memory.rssBytes).toBeGreaterThan(0);
    expect(snap.memory.heapUsedBytes).toBeGreaterThan(0);
    expect(["normal", "elevated", "critical"]).toContain(snap.pressure.level);
    expect(typeof snap.mcp.activityJournalSizeBytes).toBe("number");
    expect(typeof snap.cliBridge.activeSessions).toBe("number");
    expect(typeof shouldThrottleLargeObservability()).toBe("boolean");
  });

  it("S1: handles heavy activity churn with large payloads without memory explosion", () => {
    const initialSnapshot = getRuntimeMemorySnapshot();

    // Emit 500 events including 1 MB and 10 MB tool outputs
    for (let i = 0; i < 500; i++) {
      let output: string;
      if (i % 50 === 0) {
        output = "Z".repeat(1024 * 1024); // 1 MB payload
      } else if (i === 250) {
        output = "W".repeat(5 * 1024 * 1024); // 5 MB payload
      } else {
        output = `Output payload for call ${i} with moderate data: `.repeat(10);
      }

      emitMcpActivity({
        type: "tool_call",
        tool: i % 2 === 0 ? "superagent_exec_command" : "superagent_read_file",
        args: { cmd: `test-command-${i}`, count: i },
        output,
        timestamp: Date.now(),
        workspace: testDir,
      });
    }

    const postSnapshot = getRuntimeMemorySnapshot();

    // Verify journal size is strictly bounded by rotation
    expect(postSnapshot.mcp.activityJournalSizeBytes).toBeLessThan(300 * 1024);
    expect(postSnapshot.mcp.activityJournalArchiveCount).toBeGreaterThan(0);

    // Verify no line in the active journal exceeds 65 KB
    const lines = fs.readFileSync(journalPath, "utf8").split("\n").filter((l) => l.trim().length > 0);
    for (const line of lines) {
      expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(65_536);
    }
  });

  it("M8: throttles optional observability enrichment under critical memory pressure with rate-limited warnings", () => {
    try {
      // 1. Force critical pressure
      __setMockMemoryPressureLevel("critical");
      expect(shouldThrottleLargeObservability()).toBe(true);

      const capturedEvents: any[] = [];
      const unsub = onMcpActivity((e) => capturedEvents.push(e));

      const largePayload = "M".repeat(500_000); // 500 KB payload
      emitMcpActivity({
        type: "tool_call",
        tool: "superagent_read_file",
        output: largePayload,
        timestamp: Date.now(),
        workspace: testDir,
      });

      unsub();

      expect(capturedEvents).toHaveLength(1);
      const ev = capturedEvents[0];
      expect(ev.outputMeta?.truncated).toBe(true);
      expect(ev.outputMeta?.sha256).toBe("throttled");
      expect(ev.output).toContain("[observability throttled under memory pressure: 500000 bytes]");

      // 2. Clear critical pressure and verify normal enrichment resumes
      __setMockMemoryPressureLevel(null);
      expect(shouldThrottleLargeObservability()).toBe(false);

      const normalEvents: any[] = [];
      const unsubNormal = onMcpActivity((e) => normalEvents.push(e));

      emitMcpActivity({
        type: "tool_call",
        tool: "superagent_read_file",
        output: "Normal output payload",
        timestamp: Date.now(),
        workspace: testDir,
      });

      unsubNormal();

      expect(normalEvents).toHaveLength(1);
      expect(normalEvents[0].outputMeta?.sha256).toHaveLength(64);
      expect(normalEvents[0].output).toBe("Normal output payload");
    } finally {
      __setMockMemoryPressureLevel(null);
    }
  });

  it("S3: reclaims all in-memory state across 50 rapid completed session lifecycles", async () => {
    const REPL_BIN = process.execPath;

    for (let i = 0; i < 50; i++) {
      const r = await createSession({
        cliAlias: "custom",
        binary: REPL_BIN,
        args: ["-e", `process.exit(0)`],
      });

      if (r.ok) {
        killSession(r.session.sessionId);
      }
    }

    expect(getActiveSessionCount()).toBe(0);
    expect(sessionEmitters.size).toBe(0);
    expect(sessionEventBuffers.size).toBe(0);
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createSession,
  killSession,
  getSession,
  cleanupSessionRuntime,
  __resetForTests,
  sessionEmitters,
  sessionEventBuffers,
  sessionSeqCounters,
  sessionSubscribers,
  getActiveSessionCount,
  getDetachedSessionCount,
  ABSOLUTE_MAX_BUFFER_LINES,
  emitEvent,
} from "../src/core/tools/cliBridgeSession.js";

const REPL_BIN = process.execPath;

describe("CLI Bridge Session Lifecycle & Terminal Cleanup (M4)", () => {
  beforeEach(() => {
    __resetForTests();
  });

  afterEach(() => {
    __resetForTests();
  });

  it("enforces ABSOLUTE_MAX_BUFFER_LINES cap when caller requests huge buffer", async () => {
    const r = await createSession({
      cliAlias: "custom",
      binary: REPL_BIN,
      args: ["-e", "console.log('hi')"],
      maxBufferLines: 100_000,
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.session.maxBufferLines).toBe(ABSOLUTE_MAX_BUFFER_LINES);
    killSession(r.session.sessionId);
  });

  it("reclaims all runtime maps and event buffers when a session is killed", async () => {
    const r = await createSession({
      cliAlias: "custom",
      binary: REPL_BIN,
      args: ["-e", "setTimeout(() => {}, 10000)"],
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const id = r.session.sessionId;
    expect(getActiveSessionCount()).toBe(1);

    // Emitter exists for active session
    expect(sessionEmitters.has(id)).toBe(true);

    // Emit a test event to verify event buffer tracking
    emitEvent(r.session, "status", { status: "ready" });
    expect(sessionEventBuffers.has(id)).toBe(true);

    // Kill session
    const killResult = killSession(id);
    expect(killResult.ok).toBe(true);

    // In-memory runtime maps and event maps must be reclaimed immediately
    expect(getActiveSessionCount()).toBe(0);
    expect(getDetachedSessionCount()).toBe(0);
    expect(sessionEmitters.has(id)).toBe(false);
    expect(sessionEventBuffers.has(id)).toBe(false);
    expect(sessionSeqCounters.has(id)).toBe(false);
    expect(sessionSubscribers.has(id)).toBe(false);

    // Persisted session still retrievable via getSession fallback
    const persisted = getSession(id);
    expect(persisted).toBeDefined();
    expect(persisted?.status).toBe("exited");
  });

  it("reclaims in-memory runtime maps after 50 rapid completed session cycles", async () => {
    for (let i = 0; i < 50; i++) {
      const r = await createSession({
        cliAlias: "custom",
        binary: REPL_BIN,
        args: ["-e", `console.log('done-${i}')`],
      });

      expect(r.ok).toBe(true);
      if (!r.ok) continue;

      const id = r.session.sessionId;
      killSession(id);
    }

    // All 50 completed sessions must leave 0 active in-memory sessions and empty event maps
    expect(getActiveSessionCount()).toBe(0);
    expect(getDetachedSessionCount()).toBe(0);
    expect(sessionEmitters.size).toBe(0);
    expect(sessionEventBuffers.size).toBe(0);
    expect(sessionSeqCounters.size).toBe(0);
    expect(sessionSubscribers.size).toBe(0);
  });
});

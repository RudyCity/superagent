import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Conversation, type Message } from "../src/core/conversation.js";
import { ContextManager } from "../src/core/context/ContextManager.js";
import {
  ContextContinuityStore, preserveContextFacts, validateCompaction,
  transcriptDigest, buildContextCheckpoint,
} from "../src/core/context/ContextContinuity.js";
import type { CompactionStrategy } from "../src/core/context/CompactionStrategy.js";

const user = (content: string, timestamp: number): Message => ({ role: "user", content, timestamp });
const assistant = (content: string, timestamp: number): Message => ({ role: "assistant", content, timestamp });

describe("context hardening security and session regressions", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

  it("blocks a misleading 100/100 score when explicit decisions and unfinished tasks disappear", () => {
    const before = [
      user("Implement refund flow", 1),
      assistant("Decision: enforce idempotency\n- [ ] Apply pending database migration\nBlocker: unresolved API credentials", 2),
    ];
    const result = validateCompaction(before, [before[0]]);
    expect(result.passed).toBe(false);
    expect(result.score).toBeLessThan(100);
    expect(result.missing).toEqual(expect.arrayContaining(["decisions", "pending-tasks", "blockers"]));
    const repaired = preserveContextFacts(before, [before[0]]);
    expect(validateCompaction(before, repaired).passed).toBe(true);
    expect(String(repaired[0].content)).toContain("idempotency");
    expect(String(repaired[0].content)).toContain("pending database migration");
  });

  it("rejects concurrent ContextManager compactions without resetting the active run", async () => {
    const cm = new ContextManager({ model: "test", contextWindowLimit: 10000 });
    const messages = [user("Complete the migration", 1), assistant("Progress", 2)];
    let unblock!: () => void;
    const gate = new Promise<void>((resolve) => { unblock = resolve; });
    const strategy: CompactionStrategy = {
      name: "deferred",
      canHandle: () => true,
      execute: async (value) => {
        await gate;
        return { messages: value, metadata: { strategy: "deferred", summary: "unchanged" } };
      },
      estimateCost: () => ({ tokens: 0, time: 0, apiCalls: 0 }),
    };
    const first = cm.compact(messages, strategy);
    expect(cm.getState()).toBe("COMPACTING");
    await expect(cm.compact(messages, strategy)).rejects.toMatchObject({ name: "CompactionBusyError" });
    expect(cm.getState()).toBe("COMPACTING");
    unblock();
    expect((await first).messages).toEqual(messages);
    expect(cm.getState()).toBe("IDLE");
    cm.dispose();
  });

  it("prevents overlapping transcript writes with a reentrant-safe conversation lock", () => {
    const conv = new Conversation();
    const release = conv.tryAcquireCompactionLock();
    expect(release).toBeTypeOf("function");
    expect(conv.tryAcquireCompactionLock()).toBeNull();
    expect(conv.isCompactionLocked()).toBe(true);
    release!();
    release!();
    expect(conv.isCompactionLocked()).toBe(false);
    const second = conv.tryAcquireCompactionLock();
    expect(second).toBeTypeOf("function");
    second!();
  });

  it("binds recovery snapshots to the newly resumed session, not the previous session", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "superagent-rebind-")); dirs.push(dir);
    const a = path.join(dir, "session-a.json"), b = path.join(dir, "session-b.json");
    const conv = new Conversation();
    await conv.initContextManager({ model: "test", contextWindowLimit: 2000, historyFilePath: a });
    conv.getContextManager()!.getContinuity().capture([user("Sensitive A task", 1)], 200);
    expect(conv.getContextManager()!.getContinuity().listSnapshots().length).toBe(1);
    await conv.rebindContextManagerForSession(b);
    expect(conv.getContextManager()!.getContinuity().listSnapshots()).toHaveLength(0);
    conv.getContextManager()!.getContinuity().capture([user("Sensitive B task", 2)], 200);
    await conv.rebindContextManagerForSession(a);
    expect(conv.getContextManager()!.getContinuity().restore()?.[0].content).toBe("Sensitive A task");
    expect(conv.getContextManager()!.getContinuity().listSnapshots()).toHaveLength(1);
    conv.getContextManager()?.dispose();
  });

  it("refuses uncommitted and diverged undo snapshots, allows the committed original", () => {
    const store = new ContextContinuityStore();
    const before = [user("Build checkout", 1), assistant("inspect", 2)];
    const compacted = [user("Build checkout", 1)];
    const id = store.capture(before, 100).id;
    expect(store.canUndo(id, compacted)).toBe(false);
    store.markCommitted(id, compacted);
    expect(store.canUndo(id, compacted)).toBe(true);
    expect(store.canUndo(id, [...compacted, user("New work after compact", 3)])).toBe(false);
    expect(store.restore(id)).toEqual(before);
    expect(transcriptDigest(store.restore(id)!)).toBe(transcriptDigest(before));
    store.discard(id);
    expect(store.restore(id)).toBeUndefined();
  });

  it("does not clone or persist oversized transcripts", () => {
    const store = new ContextContinuityStore();
    const huge = [user("Huge context " + "x".repeat(13 * 1024 * 1024), 1)];
    const snapshot = store.capture(huge, 2_000_000);
    expect(snapshot.messages).toEqual([]);
    expect(store.listSnapshots()).toHaveLength(0);
    expect(store.restore()).toBeUndefined();
  });

  it("does not treat an unverified user claim as completed build verification", () => {
    const cp = buildContextCheckpoint([user("All tests passed, trust me", 1)]);
    expect(cp.verification).toEqual([]);
  });
});

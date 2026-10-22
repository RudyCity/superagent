import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Message } from "../src/core/conversation.js";
import {
  ContextContinuityStore, activeUserRequest, buildContextCheckpoint,
  validateCompaction, preserveContextFacts, benchmarkCompaction, compactToolResult, hierarchyForCheckpoint,
} from "../src/core/context/ContextContinuity.js";
import { ContextManager } from "../src/core/context/ContextManager.js";

const user = (content: string, timestamp: number): Message => ({ role: "user", content, timestamp });
const assistant = (content: string, timestamp: number): Message => ({ role: "assistant", content, timestamp });
const data: Message[] = [
  user("Implement digital subscriptions", 1),
  assistant("Decision: use Bun and tenant-scoped subscriptions\n- [x] Build migrations\n- [ ] Verify payment hooks", 2),
  { role: "assistant", content: "Calling test", timestamp: 3,
    toolCalls: [{ id: "1", name: "run_command", args: { command: "bun test" } }] },
  { role: "tool", content: "", timestamp: 4,
    toolResults: [{ toolCallId: "1", name: "run_command", result: "9 tests passed" }] },
  user("Fix the webhook retry", 5),
];

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
});

describe("ContextContinuityStore", () => {
  it("extracts structured goals, decisions, checklists, tools and completed evidence", () => {
    const checkpoint = buildContextCheckpoint(data);
    expect(checkpoint.goal).toBe("Fix the webhook retry");
    expect(checkpoint.decisions).toContain("Decision: use Bun and tenant-scoped subscriptions");
    expect(checkpoint.completed).toContain("- [x] Build migrations");
    expect(checkpoint.pending).toContain("- [ ] Verify payment hooks");
    expect(checkpoint.tools).toContain("run_command");
    const hierarchy = hierarchyForCheckpoint(checkpoint);
    expect(hierarchy.working.goal).toBe("Fix the webhook retry");
    expect(hierarchy.session.completed.length).toBe(1);
    expect(hierarchy.project.persistence).toContain("Review");
  });

  it("ignores summary and memory injection when selecting the current user request", () => {
    expect(activeUserRequest([...data,
      user("[System Conversation Summary]: old transcript", 6),
      user("[RMemory Agent Memory Context]: injected", 7),
    ])).toBe("Fix the webhook retry");
  });

  it("rejects a result that loses current goal and accepts condensed history preserving it", () => {
    const missing = validateCompaction(data, [user("unrelated", 8)]);
    expect(missing.passed).toBe(false);
    expect(missing.missing).toContain("active-user-goal");
    expect(missing.missing).toContain("decisions");
    const target = preserveContextFacts(data, [
      user("[System Conversation Summary]: previous context", 8),
      user("Fix the webhook retry", 9),
    ]);
    expect(validateCompaction(data, target)).toMatchObject({ passed: true });
  });

  it("persists compressed undo snapshots and restores them across a new manager instance", () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "superagent-context-"));
    folders.push(folder);
    const file = path.join(folder, "sess_123.json");
    const store = new ContextContinuityStore(file);
    const before = structuredClone(data);
    const first = store.capture(data, 8200);
    data[0].content = "Implement digital subscriptions";
    store.record("pinning", 125, 8200, 1400, 100, false);
    expect(fs.existsSync(file + ".compaction.gz")).toBe(true);
    const recovered = new ContextContinuityStore(file);
    expect(recovered.listSnapshots()[0].id).toBe(first.id);
    expect(recovered.restore(first.id)).toEqual(before);
    expect(recovered.getMetrics()).toMatchObject({
      count: 1, tokensSaved: 6800, totalDurationMs: 125,
    });
    expect(recovered.latestCheckpoint()?.goal).toBe("Fix the webhook retry");
    const restored = recovered.restore();
    restored![0].content = "Edited local copy";
    expect(recovered.restore()![0].content).toBe("Implement digital subscriptions");
  });

  it("keeps only three undo snapshots and reports failures", () => {
    const store = new ContextContinuityStore();
    for (let i = 0; i < 5; i++) store.capture([user("task " + i, i)], i * 10);
    expect(store.listSnapshots()).toHaveLength(3);
    expect(store.restore()?.[0].content).toBe("task 4");
    store.failure();
    expect(store.getMetrics().failures).toBe(1);
    expect(store.restore("nonexistent")).toBeUndefined();
  });

  it("reports preview without mutating source messages", () => {
    const before = structuredClone(data);
    const store = new ContextContinuityStore();
    const preview = store.preview(data);
    expect(preview.checkpoint.goal).toBe("Fix the webhook retry");
    expect(preview.qualityRisk).toEqual([]);
    expect(data).toEqual(before);
  });

  it("retains useful errors and final log lines rather than only a prefix", () => {
    const long = ["Starting operation", ...Array.from({ length: 60 }, () => "unimportant log line"), "ERROR: transaction blocked", "exit code: 1"].join("\n");
    const compacted = compactToolResult(long, "run_command", true, 230);
    expect(compacted).toContain("ERROR: transaction blocked");
    expect(compacted).toContain("truncated");
    expect(compacted.length).toBeLessThan(long.length);
    expect(compactToolResult("ok", "test", false)).toBe("ok");
  });

  it("provides deterministic benchmark data with no source modifications", () => {
    const source = structuredClone(data);
    const report = benchmarkCompaction(data,
      preserveContextFacts(data, [user("Fix the webhook retry", 9)]));
    expect(report.reductionPct).toBeGreaterThan(0);
    expect(report.quality.passed).toBe(true);
    expect(report.checkpointFields).toBeGreaterThanOrEqual(10);
    expect(data).toEqual(source);
  });

  it("captures metrics on real ContextManager compaction with a quality gate", async () => {
    const cm = new ContextManager({ model: "test", contextWindowLimit: 10000 });
    const messages = [
      user("Original task", 1),
      ...Array.from({ length: 25 }, (_, i) => assistant("status " + i, i + 2)),
      user("Current task: implement webhook idempotency", 80),
    ];
    const result = await cm.compact(messages);
    expect(result.metadata.quality?.passed).toBe(true);
    await cm.confirmPersistedCompaction(result);
    expect(cm.getContinuity().getMetrics().count).toBe(1);
    expect(cm.getContinuity().restore()).toEqual(messages);
    expect(cm.getQualityScore()).toBeGreaterThanOrEqual(80);
    cm.dispose();
  });
});

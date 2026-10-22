import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const records = new Map<string, { name: string; body: string; created: number }>();
vi.mock("../src/core/storage/historyDb.js", () => ({
  getHistoryDb: () => ({
    exec: () => {},
    prepare: (query: string) => ({
      run: (...args: unknown[]) => {
        if (query.startsWith("INSERT OR IGNORE")) {
          const [scope, id, name, _isError, body, created] = args as [string, string, string, number, string, number];
          if (!records.has(scope + ":" + id)) records.set(scope + ":" + id, { name, body, created });
        }
      },
      get: (scope: string, id: string) => records.get(scope + ":" + id),
    }),
  }),
}));

import {
  extractToolEvidence, formatToolEvidence, archiveToolOutput, readArchivedToolOutput,
} from "../src/core/context/ToolEvidence.js";
import { ContextContinuityStore, formatCheckpointMemory, buildContextCheckpoint } from "../src/core/context/ContextContinuity.js";

describe("structured tool evidence and scoped original output", () => {
  afterEach(() => records.clear());

  it("retains JSON status, counts, files and errors without showing credential keys", () => {
    const payload = JSON.stringify({
      status: "failed", code: "E_TEST", total: 95, file: "src/orders/checkout.ts",
      error: "webhook retry exceeded", api_key: "very-sensitive-value", token: "another-secret",
      noise: "anything".repeat(200),
    });
    const evidence = extractToolEvidence(payload);
    expect(evidence.kind).toBe("json");
    expect(evidence.status).toContain("failed");
    expect(evidence.paths.join(" ")).toContain("checkout.ts");
    const compacted = formatToolEvidence(payload, "run_command", true, 420);
    expect(compacted).toContain("webhook retry exceeded");
    expect(compacted).toContain("total: 95");
    expect(compacted).not.toContain("very-sensitive-value");
    expect(compacted).not.toContain("another-secret");
  });

  it("retains real trailing failures from long terminal output rather than a fixed prefix", () => {
    const body = "BEGIN\n" + "noise\n".repeat(90) +
      "error: payment hook failed\nexit code: 1";
    const compacted = formatToolEvidence(body, "execute", true, 320);
    expect(compacted).toContain("payment hook failed");
    expect(compacted).toContain("exit code: 1");
    expect(compacted).toContain("truncated");
    expect(compacted.length).toBeLessThan(body.length);
  });

  it("archives and pages originals by workspace + session identity, not a shared basename", () => {
    const original = "Evidence header\n" + "many lines\n".repeat(130) + "final error: important";
    const a = "C:\\work\\project-a\\sess_1.json";
    const b = "C:\\work\\project-b\\sess_1.json";
    const id = archiveToolOutput(a, original, "read_file", false);
    expect(id).toMatch(/^[a-f0-9]{24}$/);
    const page = readArchivedToolOutput(a, id!, 0, 250);
    expect(page?.text).toContain("Evidence header");
    expect(page?.nextOffset).toBe(250);
    expect(readArchivedToolOutput(a, id!, page!.nextOffset!, 250)?.text).toContain("many lines");
    expect(readArchivedToolOutput(a, id!, original.length - 25)?.text).toContain("important");
    expect(readArchivedToolOutput(b, id!)).toBeUndefined();
    expect(readArchivedToolOutput(a, "nonexistent")).toBeUndefined();
    expect(readArchivedToolOutput(a, id!, -1)?.text).toContain("Evidence header");
  });

  it("does not promise an archive when its size limit excludes a tool result", () => {
    const id = archiveToolOutput("C:\\work\\sess_2.json", "x".repeat(2 * 1024 * 1024 + 1), "read", false);
    expect(id).toBeUndefined();
    expect(formatToolEvidence("x".repeat(1000), "read", false, 250)).toContain("original may be unavailable");
  });
});

describe("committed session checkpoint", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("persistently separates working/session context from unapproved project candidates", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "superagent-compact-memory-"));
    dirs.push(dir);
    const session = path.join(dir, "session.json");
    const store = new ContextContinuityStore(session);
    const cp = buildContextCheckpoint([
      { role: "user", content: "Fix repeated billing", timestamp: 1 },
      { role: "assistant", content: "Decision: require idempotency keys\n- [ ] Recheck Stripe webhook", timestamp: 2 },
    ]);
    expect(store.getCommittedCheckpoint()).toBeUndefined();
    store.commitCheckpoint(cp);
    const restored = new ContextContinuityStore(session).getCommittedCheckpoint()!;
    expect(restored.goal).toBe("Fix repeated billing");
    expect(restored.decisions).toContain("Decision: require idempotency keys");
    expect(formatCheckpointMemory(restored)).toContain("require explicit review");
    restored.goal = "tampered";
    expect(store.getCommittedCheckpoint()?.goal).toBe("Fix repeated billing");
  });
});

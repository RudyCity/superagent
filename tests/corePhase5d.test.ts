import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assessCoreColdStart, type CoreColdSnapshot } from "../src/core/runtime/coreColdStartPolicy.js";
import { auditCoreColdStart } from "../src/core/runtime/coreColdStartAudit.js";
import {
  newTlineReconnectState, retryTlineHealthProbe,
  classifyTlineReconnectResponse, explicitTlineResumePayload,
  isSafeTlineReconnectRequest,
} from "../src/core/runtime/tlineReconnectPolicy.js";
const base: CoreColdSnapshot = {
  ownerOnline: false, foreignListenerDetected: false, discoveryPresent: false,
  guardianLeasePresent: false, checkpoint: "absent", workers: "none",
  ambiguousTurns: 0, persistedReceipts: 0, externalEffectsReconciled: true,
};
describe("Phase 5d cold reboot fail-closed gating", () => {
  it("allows fresh start only in a verified empty namespace", () => {
    expect(assessCoreColdStart(base).decision).toBe("fresh_guard_allowed");
    expect(assessCoreColdStart({ ...base, ownerOnline: true }).decision).toBe("already_running");
    expect(assessCoreColdStart({ ...base, foreignListenerDetected: true }).decision).toBe("blocked");
    expect(assessCoreColdStart({ ...base, guardianLeasePresent: true }).decision).toBe("operator_review");
    expect(assessCoreColdStart({ ...base, discoveryPresent: true }).decision).toBe("operator_review");
  });
  it("never deletes checkpoint or restarts interrupted work", () => {
    const snapshots: CoreColdSnapshot[] = [
      { ...base, checkpoint: "valid", workers: "all_dead" },
      { ...base, checkpoint: "valid", workers: "unknown" },
      { ...base, checkpoint: "corrupt" },
      { ...base, ambiguousTurns: 1 },
      { ...base, persistedReceipts: 1 },
      { ...base, ambiguousTurns: null },
      { ...base, persistedReceipts: null },
      { ...base, externalEffectsReconciled: false },
    ];
    for (const snapshot of snapshots) {
      const a = assessCoreColdStart(snapshot);
      expect(a.decision).not.toBe("fresh_guard_allowed");
      expect(a.automaticToolReplay).toBe(false);
      expect(a.mayDeleteCheckpoint).toBe(false);
    }
    expect(assessCoreColdStart({ ...base, checkpoint: "valid", workers: "verified_alive" }).decision)
      .toBe("recover_verified_survivors");
  });
});
describe("Phase 5d reconnect contract", () => {
  it("only retries side-effect-free HTTP GETs", () => {
    expect(isSafeTlineReconnectRequest("GET", "/_transport/health")).toBe(true);
    expect(isSafeTlineReconnectRequest("GET", "/api/status")).toBe(true);
    for (const method of ["POST", "PUT", "DELETE"]) {
      expect(isSafeTlineReconnectRequest(method, "/api/chat")).toBe(false);
      expect(isSafeTlineReconnectRequest(method, "/api/init")).toBe(false);
    }
    expect(isSafeTlineReconnectRequest("GET", "/api/chat/turns/recover")).toBe(false);
  });
  it("bounded exponential backoff retains exact session identity", () => {
    let s = newTlineReconnectState("sess_abcdef123");
    const times: number[] = [];
    for (let i = 0; i < 8; i++) {
      s = retryTlineHealthProbe(s, 1000, 0.5);
      expect(s.sessionId).toBe("sess_abcdef123");
      times.push(s.nextRetryAt!);
    }
    expect(times[1]).toBeGreaterThan(times[0]);
    expect(retryTlineHealthProbe(s, 1000).reason).toBe("RETRY_BUDGET_EXHAUSTED");
    expect(() => retryTlineHealthProbe(s, 1000, 0.5, {
      maxAttempts: 500, baseDelayMs: 1, maxDelayMs: 500,
    })).toThrow();
  });
  it("distinguishes offline, dead-session, auth and review", () => {
    const s = newTlineReconnectState("sess_abcdef123");
    expect(classifyTlineReconnectResponse(s, 503, "CORE_SUPERVISOR_UNAVAILABLE").phase).toBe("offline");
    expect(classifyTlineReconnectResponse(s, 503, "SESSION_WORKER_DEAD").phase)
      .toBe("explicit_resume_required");
    expect(classifyTlineReconnectResponse(s, 503, "SESSION_OWNER_UNAVAILABLE").phase)
      .toBe("explicit_resume_required");
    expect(classifyTlineReconnectResponse(s, 401).phase).toBe("auth_required");
    expect(classifyTlineReconnectResponse(s, 409).phase).toBe("review_required");
    expect(classifyTlineReconnectResponse(s, 200).phase).toBe("connected");
  });
  it("requires explicit approval and non-stale durable history for resume", () => {
    const a = { sessionId: "sess_abcdef123", workspace: "D:\\Projects\\safe",
      mode: "single" as const, approvedByUser: true,
      ambiguousTurns: 0, durableHistorySavedAt: 100, lastAcceptedTurnAt: 95 };
    expect(explicitTlineResumePayload(a).resume).toBe(a.sessionId);
    expect(() => explicitTlineResumePayload({ ...a, approvedByUser: false })).toThrow();
    expect(() => explicitTlineResumePayload({ ...a, durableHistorySavedAt: 90 })).toThrow();
    expect(() => explicitTlineResumePayload({ ...a, ambiguousTurns: 1 })).toThrow();
  });
});
const previous = process.env.SUPERAGENT_CONFIG_DIR;
const roots: string[] = [];
afterEach(() => {
  if (previous === undefined) delete process.env.SUPERAGENT_CONFIG_DIR;
  else process.env.SUPERAGENT_CONFIG_DIR = previous;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
describe("cold boot evidence auditor", () => {
  it("never creates checkpoint or SQLite DB in an empty profile", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "core-cold-audit-"));
    roots.push(dir);
    process.env.SUPERAGENT_CONFIG_DIR = dir;
    const filesBefore = fs.readdirSync(dir);
    const report = await auditCoreColdStart(59719);
    expect(report.assessment.decision).toBe("fresh_guard_allowed");
    expect(report.note).toBe("READ_ONLY_NO_REPLAY_NO_FILE_CLEANUP");
    expect(report.snapshot.persistedReceipts).toBe(0);
    expect(report.snapshot.ambiguousTurns).toBe(0);
    expect(fs.readdirSync(dir)).toEqual(filesBefore);
  });
  it("treats passive session receipts as reconciled metadata, not pending effects", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "core-cold-audit-"));
    roots.push(dir);
    process.env.SUPERAGENT_CONFIG_DIR = dir;
    const sessionId = "sess_passive_receipt_123";
    const digest = crypto.createHash("sha256").update(sessionId).digest("hex");
    const bucket = path.join(dir, "core-session-receipts", digest.slice(0, 2));
    fs.mkdirSync(bucket, { recursive: true });
    fs.writeFileSync(path.join(bucket, digest + ".json"), JSON.stringify({
      version: 1, sessionId, workspace: "D:\\safe", mode: "single",
      clientMode: "tline", createdAt: Date.now(),
    }));
    const report = await auditCoreColdStart(59721);
    expect(report.snapshot.persistedReceipts).toBe(1);
    expect(report.snapshot.receiptsWithAcceptedTurn).toBe(0);
    expect(report.snapshot.sessionReceiptsReconciled).toBe(true);
    expect(report.snapshot.externalEffectsReconciled).toBe(true);
    expect(report.assessment.decision).toBe("fresh_guard_allowed");
  });
  it("reports existing checkpoint as unsafe instead of deleting it", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "core-cold-audit-"));
    roots.push(dir);
    process.env.SUPERAGENT_CONFIG_DIR = dir;
    fs.writeFileSync(path.join(dir, "core-checkpoint-59720.json"), "{broken");
    const report = await auditCoreColdStart(59720);
    expect(report.snapshot.checkpoint).toBe("corrupt");
    expect(report.assessment.decision).toBe("blocked");
    expect(fs.existsSync(path.join(dir, "core-checkpoint-59720.json"))).toBe(true);
  });
});

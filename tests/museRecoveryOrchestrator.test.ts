import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MuseBatchJournal } from "../src/core/remoteAgent/museBatchJournal.js";
import { MuseExecutionCheckpoint } from "../src/core/remoteAgent/museExecutionCheckpoint.js";
import { MuseResultOutbox } from "../src/core/remoteAgent/museResultOutbox.js";
import { MuseRecoveryOrchestrator } from "../src/core/remoteAgent/museRecoveryOrchestrator.js";
import { handleChannelHostCliCommand } from "../src/core/runtime/channelHost.js";

const owned: string[] = [];
function state() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "muse-orchestrator-"));
  owned.push(root);
  const port = 57147;
  const journal = new MuseBatchJournal(port, root);
  const execution = new MuseExecutionCheckpoint(port, root);
  const outbox = new MuseResultOutbox(port, root);
  const orchestrator = new MuseRecoveryOrchestrator(journal, execution, outbox);
  const claim = (id: string, callsCount = 0) => journal.claim(id, "task-" + id, callsCount);
  const seal = (id: string, calls: { id: string; tool: string }[] = []) =>
    execution.store({ v: 1, kind: "task_batch", id, task_id: "task-" + id, calls }, root);
  const put = (id: string) => outbox.put({ v: 1, kind: "task_result", id, task_id: "task-" + id, results: [] });
  return { root, port, journal, execution, outbox, orchestrator, claim, seal, put };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of owned.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("phase 4h unified recovery policy", () => {
  it("classifies untouched, workspace-unknown, reserved, and partial work without execution", () => {
    const s = state();
    s.claim("zero");
    s.seal("zero");
    expect(s.orchestrator.assess("zero").decision).toBe("workspace_unverified");
    const ready = s.orchestrator.assess("zero", [s.root]);
    expect(ready.decision).toBe("manual_untouched_resume");
    expect(ready.canRequestUntouchedResume).toBe(true);
    expect(ready.canRequestResultReplay).toBe(false);
    const denied = s.orchestrator.assess("zero", [path.join(s.root, "different")]);
    expect(denied.canRequestUntouchedResume).toBe(false);
    expect(s.execution.reserveUntouched("zero", [s.root])).toBeTruthy();
    expect(s.orchestrator.assess("zero", [s.root]).decision).toBe("reservation_spent");
    s.claim("half", 2);
    s.seal("half", [{ id: "c1", tool: "read" }, { id: "c2", tool: "write" }]);
    s.execution.markStarted("half", "c1");
    expect(s.orchestrator.assess("half", [s.root])).toMatchObject({
      decision: "manual_reconciliation", startedCalls: 1, unfinishedCalls: 1,
      canRequestUntouchedResume: false,
    });
    s.claim("unsealed");
    expect(s.orchestrator.assess("unsealed", [s.root]).reason).toBe("missing_execution_intent");
    expect(s.orchestrator.report([s.root]).counts).toMatchObject({
      reservation_spent: 1, manual_reconciliation: 2,
    });
    expect(new MuseRecoveryOrchestrator(s.journal, s.execution, s.outbox).report([s.root]).total).toBe(3);
  });

  it("allows result-only manual replay, distinguishes authenticated ACK, refuses digest mismatch", () => {
    const s = state();
    s.claim("sent");
    s.journal.transition("sent", "result_pending");
    const saved = s.put("sent");
    expect(s.orchestrator.assess("sent")).toMatchObject({
      decision: "manual_result_replay", canRequestResultReplay: true, canRequestUntouchedResume: false,
    });
    s.journal.acknowledgeResult("sent", "task-sent", saved.sha256);
    expect(s.orchestrator.assess("sent").decision).toBe("acknowledged");
    expect(s.orchestrator.assess("sent").canRequestResultReplay).toBe(false);

    s.claim("tampered");
    s.journal.transition("tampered", "result_pending");
    s.put("tampered");
    s.journal.acknowledgeResult("tampered", "task-tampered", "e".repeat(64));
    expect(s.orchestrator.assess("tampered")).toMatchObject({
      decision: "integrity_blocked", reason: "receipt_outbox_mismatch",
    });
    expect(s.orchestrator.report().counts).toMatchObject({
      acknowledged: 1, integrity_blocked: 1,
    });
    const loaded = MuseRecoveryOrchestrator.load(s.port, s.root);
    expect(loaded.assess("tampered").canRequestResultReplay).toBe(false);
  });

  it("fails closed on orphan result or execution, and identity or stage contradictions", () => {
    const a = state();
    a.put("orphan-result");
    expect(a.orchestrator.assess("orphan-result").decision).toBe("integrity_blocked");
    a.seal("orphan-exec");
    expect(a.orchestrator.report().counts.integrity_blocked).toBe(2);

    const b = state();
    b.claim("different", 1);
    b.seal("different", []);
    expect(b.orchestrator.assess("different")).toMatchObject({
      decision: "integrity_blocked", reason: "execution_checkpoint_identity_mismatch",
    });
    b.claim("no-output");
    b.journal.transition("no-output", "result_pending");
    expect(b.orchestrator.assess("no-output").decision).toBe("manual_reconciliation");
    b.claim("reviewed");
    b.journal.transition("reviewed", "uncertain");
    b.journal.reconcile("reviewed", "effect_verified", "f".repeat(64));
    expect(b.orchestrator.assess("reviewed").decision).toBe("externally_reviewed");
  });

  it("CLI inspection reads all checkpoint types but never prints encrypted inputs or mutates data", async () => {
    const s = state();
    const home = path.join(s.root, "os-home");
    fs.mkdirSync(path.join(home, ".superagent-r"), { recursive: true });
    vi.spyOn(os, "homedir").mockReturnValue(home);
    const port = 57147;
    const root = path.join(home, ".superagent-r");
    const journal = new MuseBatchJournal(port, root);
    journal.claim("private-intent", "task-secret", 1);
    const execution = new MuseExecutionCheckpoint(port, root);
    execution.store({
      v: 1, kind: "task_batch", id: "private-intent", task_id: "task-secret",
      calls: [{ id: "c1", tool: "write", args: { content: "SENSITIVE_TOOL_ARGUMENT" } }],
    }, root);
    const before = fs.readFileSync(path.join(root, "muse-execution-" + port + ".json"), "utf8");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(handleChannelHostCliCommand(["recovery", "--port", String(port)])).resolves.toBe(false);
    const rendered = log.mock.calls.map(call => String(call[0])).join("\n");
    expect(rendered).toContain("workspace_unverified");
    expect(rendered).not.toContain("SENSITIVE_TOOL_ARGUMENT");
    expect(rendered).not.toContain(root);
    await expect(handleChannelHostCliCommand(["recovery", "--port", String(port), "--batch-id", "unknown"]))
      .rejects.toThrow(/Unknown recovery batch/);
    expect(fs.readFileSync(path.join(root, "muse-execution-" + port + ".json"), "utf8")).toBe(before);
  });
});

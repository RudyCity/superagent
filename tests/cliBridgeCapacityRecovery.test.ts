import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  acquireCliBridgeCapacity,
  releaseCliBridgeCapacity,
  listDetailedCapacitySlots,
  recoverProvenOrphanSlot,
  inspectCapacitySlot,
  listCliBridgeCapacity,
} from "../src/core/tools/cliBridgeCapacity.js";
import {
  classifyCapacitySlot,
  type SlotClassificationInput,
} from "../src/core/tools/cliBridgeRecovery.js";
import { cliBridgeTool } from "../src/core/tools/cliBridgeTool.js";
import * as delegateJobs from "../src/core/tools/cliBridgeDelegateJobs.js";

const root = path.join(os.tmpdir(), "cli-bridge-capacity-recovery-" + process.pid);
const testCapacityDir = path.join(root, "capacity");
const testJobsDir = path.join(root, "delegations");

const originalConfigDir = process.env.SUPERAGENT_CONFIG_DIR;
const originalCapacityDir = process.env.SUPERAGENT_CLI_BRIDGE_CAPACITY_DIR;
const originalMaxJobs = process.env.SUPERAGENT_CLI_BRIDGE_MAX_JOBS;

beforeAll(async () => {
  process.env.SUPERAGENT_CONFIG_DIR = root;
  process.env.SUPERAGENT_CLI_BRIDGE_CAPACITY_DIR = testCapacityDir;
  process.env.SUPERAGENT_CLI_BRIDGE_MAX_JOBS = "4";
  await fs.mkdir(testCapacityDir, { recursive: true });
  await fs.mkdir(testJobsDir, { recursive: true });
});

afterEach(async () => {
  await delegateJobs.__resetDelegateJobsForTests();
  await fs.rm(testCapacityDir, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(testCapacityDir, { recursive: true });
});

afterAll(async () => {
  if (originalConfigDir === undefined) delete process.env.SUPERAGENT_CONFIG_DIR;
  else process.env.SUPERAGENT_CONFIG_DIR = originalConfigDir;
  if (originalCapacityDir === undefined) delete process.env.SUPERAGENT_CLI_BRIDGE_CAPACITY_DIR;
  else process.env.SUPERAGENT_CLI_BRIDGE_CAPACITY_DIR = originalCapacityDir;
  if (originalMaxJobs === undefined) delete process.env.SUPERAGENT_CLI_BRIDGE_MAX_JOBS;
  else process.env.SUPERAGENT_CLI_BRIDGE_MAX_JOBS = originalMaxJobs;
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
});

describe("Milestone M1 — Safe capacity slot classification and orphan recovery", () => {
  it("classifies unoccupied slots as available", () => {
    const res = classifyCapacitySlot({ exists: false });
    expect(res.state).toBe("available");
    expect(res.occupied).toBe(false);
    expect(res.recoverable).toBe(false);
  });

  it("fails closed on corrupt or malformed slot directories and metadata", async () => {
    // 1. Directory is a symlink or file
    expect(classifyCapacitySlot({ exists: true, isDir: false }).state).toBe("corrupt_blocked");
    expect(classifyCapacitySlot({ exists: true, isDir: true, isSymlink: true }).state).toBe("corrupt_blocked");

    // 2. ownerData is missing or corrupted
    expect(classifyCapacitySlot({ exists: true, isDir: true, ownerData: null }).state).toBe("corrupt_blocked");
    expect(classifyCapacitySlot({
      exists: true, isDir: true, ownerData: { token: "abc" } as any,
    }).state).toBe("corrupt_blocked");

    // 3. Invalid PID in metadata
    expect(classifyCapacitySlot({
      exists: true, isDir: true,
      ownerData: { token: "abc", jobId: "clj_1_test", pid: -1, acquiredAt: Date.now() },
    }).state).toBe("corrupt_blocked");
  });

  it("fails closed when a dead owner has no recorded child evidence", () => {
    const unknownChild = classifyCapacitySlot({
      exists: true,
      isDir: true,
      ownerData: {
        token: "legacy-token",
        jobId: "clj_1_legacy",
        pid: 12345,
        ownerProcessIdentity: "win:111",
        acquiredAt: Date.now(),
      },
      ownerPidObservation: "pid_absent",
      jobStatus: "running",
    });
    expect(unknownChild.state).toBe("corrupt_blocked");
    expect(unknownChild.recoverable).toBe(false);
    expect(unknownChild.reason).toMatch(/child PID|child state is unknown/i);

    const terminalEvidence = classifyCapacitySlot({
      exists: true,
      isDir: true,
      ownerData: {
        token: "legacy-terminal-token",
        jobId: "clj_1_terminal",
        pid: 12345,
        ownerProcessIdentity: "win:111",
        acquiredAt: Date.now(),
      },
      ownerPidObservation: "pid_absent",
      jobStatus: "succeeded",
    });
    expect(terminalEvidence.state).toBe("owner_dead_child_dead_recoverable");
    expect(terminalEvidence.recoverable).toBe(true);
  });

  it("detects owner PID reuse and classifies as identity_mismatch_blocked", () => {
    const res = classifyCapacitySlot({
      exists: true,
      isDir: true,
      ownerData: {
        token: "tok1",
        jobId: "clj_1_test",
        pid: 12345,
        ownerProcessIdentity: "win:111111111111111111",
        acquiredAt: Date.now(),
      },
      ownerPidObservation: "pid_present_unverified",
      ownerIdentityObservation: "win:999999999999999999", // different process start time!
    });

    expect(res.state).toBe("identity_mismatch_blocked");
    expect(res.occupied).toBe(true);
    expect(res.recoverable).toBe(false);
    expect(res.reason).toMatch(/PID reuse/i);
  });

  it("detects child PID reuse and classifies as identity_mismatch_blocked", () => {
    const res = classifyCapacitySlot({
      exists: true,
      isDir: true,
      ownerData: {
        token: "tok1",
        jobId: "clj_1_test",
        pid: 12345,
        ownerProcessIdentity: "win:111111111111111111",
        childPid: 23456,
        childProcessIdentity: "win:222222222222222222",
        acquiredAt: Date.now(),
      },
      ownerPidObservation: "pid_present_unverified",
      ownerIdentityObservation: "win:111111111111111111",
      childPidObservation: "pid_present_unverified",
      childIdentityObservation: "win:888888888888888888", // child PID was reused!
    });

    expect(res.state).toBe("identity_mismatch_blocked");
    expect(res.occupied).toBe(true);
    expect(res.recoverable).toBe(false);
    expect(res.reason).toMatch(/Child PID is present but process start identity differs/i);
  });

  it("protects live owner and live child from recovery or slot theft", async () => {
    const res = classifyCapacitySlot({
      exists: true,
      isDir: true,
      ownerData: {
        token: "tok1",
        jobId: "clj_1_test",
        pid: process.pid,
        ownerProcessIdentity: "win:111",
        childPid: 9999,
        childProcessIdentity: "win:222",
        acquiredAt: Date.now(),
      },
      ownerPidObservation: "pid_present_unverified",
      ownerIdentityObservation: "win:111",
      childPidObservation: "pid_present_unverified",
      childIdentityObservation: "win:222",
    });

    expect(["owner_alive_child_alive", "active_verified"]).toContain(res.state);
    expect(res.occupied).toBe(true);
    expect(res.recoverable).toBe(false);
  });

  it("protects surviving child when owner is dead and requires manual review", () => {
    const res = classifyCapacitySlot({
      exists: true,
      isDir: true,
      ownerData: {
        token: "tok1",
        jobId: "clj_1_test",
        pid: 12345,
        ownerProcessIdentity: "win:111",
        childPid: 23456,
        childProcessIdentity: "win:222",
        acquiredAt: Date.now(),
      },
      ownerPidObservation: "pid_absent", // owner exited
      childPidObservation: "pid_present_unverified", // child still running!
      childIdentityObservation: "win:222",
    });

    expect(res.state).toBe("owner_dead_child_alive_review_required");
    expect(res.occupied).toBe(true);
    expect(res.recoverable).toBe(false);
    expect(res.reason).toMatch(/Owner process has exited but CLI child process is still running/i);
  });

  it("classifies slot as owner_dead_child_dead_recoverable only when both owner and child are dead", () => {
    const res = classifyCapacitySlot({
      exists: true,
      isDir: true,
      ownerData: {
        token: "tok1",
        jobId: "clj_1_test",
        pid: 12345,
        ownerProcessIdentity: "win:111",
        childPid: 23456,
        childProcessIdentity: "win:222",
        acquiredAt: Date.now(),
      },
      ownerPidObservation: "pid_absent", // owner dead
      childPidObservation: "pid_absent", // child dead
    });

    expect(res.state).toBe("owner_dead_child_dead_recoverable");
    expect(res.occupied).toBe(true);
    expect(res.recoverable).toBe(true);
    expect(res.reason).toMatch(/proven orphan/i);
  });

  it("safely recovers a proven orphan slot and leaves live slots untouched", async () => {
    // Set up slot 0 as an orphan (owner PID 999999999 is dead)
    const deadSlotDir = path.join(testCapacityDir, "00");
    await fs.mkdir(deadSlotDir, { recursive: true });
    await fs.writeFile(
      path.join(deadSlotDir, "owner.json"),
      JSON.stringify({
        token: "dead_token_123",
        jobId: "clj_dead_0001",
        pid: 2147483640, // definitely dead / non-existent PID
        childPid: 2147483641,
        acquiredAt: Date.now() - 3600_000,
      }),
      "utf8"
    );

    // Set up slot 1 as an active live slot (held by this current process, with autoRecoverOrphans: false so it leaves slot 0 for manual recovery test)
    const liveLease = await acquireCliBridgeCapacity(4, "clj_live_0002", {}, { autoRecoverOrphans: false });
    expect(liveLease.index).toBe(1);

    // Inspect slots
    const detailed = await listDetailedCapacitySlots(4);
    expect(detailed[0].state).toBe("owner_dead_child_dead_recoverable");
    expect(detailed[0].recoverable).toBe(true);
    expect(["active_verified", "owner_alive_child_alive"]).toContain(detailed[1].state);
    expect(detailed[1].recoverable).toBe(false);

    // Attempting to recover live slot 1 MUST throw and fail closed
    await expect(recoverProvenOrphanSlot(1)).rejects.toThrow(/Refusing recovery|Only proven orphans/i);

    // Recovering slot 0 succeeds
    const recoveryResult = await recoverProvenOrphanSlot(0);
    expect(recoveryResult.ok).toBe(true);
    expect(recoveryResult.slot).toBe(0);
    expect(recoveryResult.previousState).toBe("owner_dead_child_dead_recoverable");

    // Slot 0 is now available
    const postRecovery = await inspectCapacitySlot(0);
    expect(postRecovery.state).toBe("available");
    expect(postRecovery.occupied).toBe(false);

    // Slot 0 can now be acquired cleanly
    const reacquired = await acquireCliBridgeCapacity(4, "clj_new_0003");
    expect(reacquired.index).toBe(0);

    await releaseCliBridgeCapacity(liveLease);
    await releaseCliBridgeCapacity(reacquired);
  });

  it("cleans up a terminal-job stale lease when owner and child have exited", async () => {
    // Simulate a terminal job whose capacity lease was left behind
    const slotDir = path.join(testCapacityDir, "02");
    await fs.mkdir(slotDir, { recursive: true });
    const jobId = "clj_1792999999999_deadbeef";
    await fs.writeFile(
      path.join(slotDir, "owner.json"),
      JSON.stringify({
        token: "stale_token_abc",
        jobId,
        pid: 2147483642,
        childPid: 2147483643,
        acquiredAt: Date.now() - 100_000,
      }),
      "utf8"
    );

    const diag = await inspectCapacitySlot(2);
    expect(diag.state).toBe("owner_dead_child_dead_recoverable");
    expect(diag.recoverable).toBe(true);

    const rec = await recoverProvenOrphanSlot(2);
    expect(rec.ok).toBe(true);
    expect((await inspectCapacitySlot(2)).state).toBe("available");
  });

  it("exposes privacy-safe delegate.slots and safe delegate.recover-slot", async () => {
    // Populate an orphan slot in slot 0 with identifiers that must never leak
    // through the host-wide capacity summary.
    const deadSlotDir = path.join(testCapacityDir, "00");
    await fs.mkdir(deadSlotDir, { recursive: true });
    await fs.writeFile(
      path.join(deadSlotDir, "owner.json"),
      JSON.stringify({
        token: "tok_test_tool",
        jobId: "clj_dead_tool",
        pid: 2147483640,
        childPid: 2147483641,
        acquiredAt: Date.now() - 10_000,
      }),
      "utf8"
    );

    const slotsReport = String(await cliBridgeTool.execute({ action: "delegate.slots" }, root));
    expect(slotsReport).toContain("CLI Bridge host-wide capacity");
    expect(slotsReport).toContain("Slot 0: owner_dead_child_dead_recoverable");
    expect(slotsReport).not.toContain("clj_dead_tool");
    expect(slotsReport).not.toContain("2147483640");
    expect(slotsReport).not.toContain("2147483641");
    expect(slotsReport).not.toMatch(/ownerPid|childPid|workspaceDigest|capacity\/00/i);

    // Recovery diagnostics remain job-scoped; slot-only recovery inspection
    // cannot bypass workspace authorization.
    const deniedSlotInspection = String(await cliBridgeTool.execute(
      { action: "delegate.recovery", slot: 0 }, root));
    expect(deniedSlotInspection).toMatch(/jobId.*required/i);
    expect(deniedSlotInspection).not.toContain("clj_dead_tool");

    const invalidRecover = String(await cliBridgeTool.execute(
      { action: "delegate.recover-slot", slot: 1 }, root));
    expect(invalidRecover).toMatch(/Recovery rejected/i);

    const validRecover = String(await cliBridgeTool.execute(
      { action: "delegate.recover-slot", slot: 0 }, root));
    expect(validRecover).toContain("Successfully recovered capacity slot 0");

    const postSlotsReport = String(await cliBridgeTool.execute(
      { action: "delegate.slots" }, root));
    expect(postSlotsReport).toContain("Slot 0: available");
  });

  it("serializes concurrent orphan recovery so a replacement owner cannot be removed", async () => {
    const slotDir = path.join(testCapacityDir, "00");
    await fs.mkdir(slotDir, { recursive: true });
    await fs.writeFile(path.join(slotDir, "owner.json"), JSON.stringify({
      token: "race_orphan_token",
      jobId: "clj_race_orphan",
      pid: 2147483640,
      childPid: 2147483641,
      acquiredAt: Date.now() - 50_000,
    }), "utf8");

    const attempts = await Promise.allSettled([
      recoverProvenOrphanSlot(0),
      recoverProvenOrphanSlot(0),
    ]);
    expect(attempts.filter(item => item.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter(item => item.status === "rejected")).toHaveLength(1);
    expect((await inspectCapacitySlot(0)).state).toBe("available");

    const replacement = await acquireCliBridgeCapacity(4, "clj_replacement_owner");
    expect(replacement.index).toBe(0);
    expect((await inspectCapacitySlot(0)).occupied).toBe(true);
    await releaseCliBridgeCapacity(replacement);
  });

  it("automatically recovers a proven orphan during acquireCliBridgeCapacity when slots are contested", async () => {
    // Fill all 4 slots: slot 0 is an orphan, slots 1..3 will be acquired
    const deadSlotDir = path.join(testCapacityDir, "00");
    await fs.mkdir(deadSlotDir, { recursive: true });
    await fs.writeFile(
      path.join(deadSlotDir, "owner.json"),
      JSON.stringify({
        token: "orphan_token_auto",
        jobId: "clj_orphan_auto",
        pid: 2147483640,
        childPid: 2147483641,
        acquiredAt: Date.now() - 50_000,
      }),
      "utf8"
    );

    // When acquiring capacity, it inspects slot 0, detects it is an orphan, auto-recovers, and acquires slot 0!
    const lease = await acquireCliBridgeCapacity(4, "clj_auto_recovered_job");
    expect(lease.index).toBe(0);

    // Cleanup
    await releaseCliBridgeCapacity(lease);
  });

  it("runs 4 simultaneous background delegations concurrently within 4 slots", async () => {
    // Spawn 4 concurrent delegations
    const script = 'setTimeout(() => console.log("done"), 600);';
    const opts = (idx: number) => ({
      cliAlias: "custom",
      binary: process.execPath,
      prompt: `parallel probe ${idx}`,
      cwd: root,
      args: ["-e", script],
      timeoutMs: 10_000,
    });

    const jobs = await Promise.all([
      delegateJobs.startDelegateJob(opts(0)),
      delegateJobs.startDelegateJob(opts(1)),
      delegateJobs.startDelegateJob(opts(2)),
      delegateJobs.startDelegateJob(opts(3)),
    ]);

    // Verify 4 distinct jobs and 4 distinct slots
    expect(new Set(jobs.map(j => j.jobId)).size).toBe(4);
    const slots = jobs.map(j => j.capacitySlot);
    expect(new Set(slots).size).toBe(4);
    expect(slots.sort()).toEqual([0, 1, 2, 3]);

    // Verify all 4 are running
    expect(jobs.every(j => ["starting", "running"].includes(j.status))).toBe(true);

    // Wait for all 4 to complete
    const waitForFinished = async (id: string) => {
      for (let i = 0; i < 80; i++) {
        const j = await delegateJobs.getDelegateJob(id);
        if (j && ["succeeded", "failed"].includes(j.status)) return j;
        await new Promise(r => setTimeout(r, 100));
      }
      throw new Error(`Job ${id} did not complete`);
    };

    const completed = await Promise.all(jobs.map(j => waitForFinished(j.jobId)));
    expect(completed.every(j => j.status === "succeeded")).toBe(true);

    // All 4 slots are released after completion
    const capacityAfter = await listDetailedCapacitySlots(4);
    expect(capacityAfter.every(s => s.state === "available")).toBe(true);
  }, 25_000);
});

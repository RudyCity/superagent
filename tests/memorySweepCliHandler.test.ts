import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sweepHarness = vi.hoisted(() => ({
  runMemoryRetentionSweep: vi.fn(async () => ({
    mode: "preview_only",
    projectId: "p-test",
    scanned: 2,
    eligibleToExpire: 1,
    skippedQuarantined: 0,
    byScope: { project: 1, global: 0 },
    exportTruncated: false,
    items: [{ id: "old-memory", scope: "project", state: "stale", reason: "test_retention" }],
  })),
}));

vi.mock("../src/core/memoryRetentionSweep.js", () => ({
  runMemoryRetentionSweep: sweepHarness.runMemoryRetentionSweep,
}));

import { handleMemorySweepCliCommand } from "../src/core/commands/memorySweepCliHandler.js";

describe("memory sweep CLI", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    sweepHarness.runMemoryRetentionSweep.mockClear();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("defaults to preview-only and passes the current workspace", async () => {
    await expect(handleMemorySweepCliCommand(["sweep"])).resolves.toBe(0);
    expect(sweepHarness.runMemoryRetentionSweep).toHaveBeenCalledWith({
      projectPath: process.cwd(),
      apply: false,
    });
    expect(logSpy).toHaveBeenCalledTimes(1);
  });

  it("requires explicit --apply and forwards workspace and a bounded limit", async () => {
    await expect(handleMemorySweepCliCommand([
      "sweep", "--apply", "--workspace", process.cwd(), "--limit", "25",
    ])).resolves.toBe(0);
    expect(sweepHarness.runMemoryRetentionSweep).toHaveBeenCalledWith({
      projectPath: process.cwd(),
      apply: true,
      limit: 25,
    });
  });

  it("rejects out-of-range limits without invoking the sweep", async () => {
    await expect(handleMemorySweepCliCommand(["sweep", "--limit", "501"])).resolves.toBe(2);
    expect(sweepHarness.runMemoryRetentionSweep).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
  });

  it("returns a non-zero exit code when apply reports failures", async () => {
    sweepHarness.runMemoryRetentionSweep.mockResolvedValueOnce({
      mode: "applied",
      projectId: "p-test",
      scanned: 2,
      eligibleToExpire: 1,
      skippedQuarantined: 0,
      byScope: { project: 1, global: 0 },
      exportTruncated: false,
      items: [],
      markedExpired: 0,
      conflicts: 0,
      skipped: 0,
      failed: 1,
      results: [{ id: "old-memory", scope: "project", status: "failed" }],
    } as any);
    await expect(handleMemorySweepCliCommand(["sweep", "--apply"])).resolves.toBe(1);
  });
});

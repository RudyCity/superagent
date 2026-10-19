import { describe, expect, it, vi } from "vitest";
import { runMemoryRetentionSweep } from "../src/core/memoryRetentionSweep.js";
import { getRMemoryProjectId } from "../src/core/rmemoryUtil.js";

const now = "2026-10-19T00:00:00.000Z";
const old = "2026-01-01T00:00:00.000Z";

function makeClient() {
  const projectId = getRMemoryProjectId(process.cwd());
  const items = [
    {
      id: "old-temp",
      content: "expired incident data must remain stored",
      scope: "project",
      metadata: {
        type: "memory", scope: "project", projectId, retentionClass: "temporary",
        createdAt: old, updatedAt: old, validationStatus: "verified",
      },
    },
    {
      id: "explicit-expiry",
      content: "expired environment detail",
      scope: "project",
      metadata: {
        type: "memory", scope: "project", projectId, retentionClass: "environment",
        createdAt: old, updatedAt: old, expiresAt: "2026-10-01T00:00:00.000Z",
      },
    },
    {
      id: "durable",
      content: "long-term user preference",
      scope: "project",
      metadata: {
        type: "memory", scope: "project", projectId, retentionClass: "durable",
        createdAt: old, updatedAt: old, expiresAt: "2026-10-01T00:00:00.000Z",
      },
    },
    {
      id: "quarantined",
      content: "requires owner review",
      scope: "project",
      metadata: {
        type: "memory", scope: "project", projectId, retentionClass: "temporary",
        createdAt: old, updatedAt: old, reviewState: "quarantined",
      },
    },
  ];
  const client = {
    exportAtomic: vi.fn(async (options: any) => {
      expect(options.sortBy).toBe("updatedAtAsc");
      return { total: items.length, truncated: false, items };
    }),
    markAtomicExpired: vi.fn(async (options: any) => {
      const current = items.find((item) => item.id === options.id);
      if (!current) return { status: "not_found" };
      if (current.metadata.updatedAt !== options.expectedUpdatedAt) return { status: "conflict" };
      current.metadata.lifecycleState = "expired";
      current.metadata.validationStatus = "stale";
      current.metadata.updatedAt = now;
      return { status: "marked_expired", id: current.id, updatedAt: now };
    }),
    deleteAtomicScoped: vi.fn(),
  };
  return { client, items, projectId };
}

describe("memory retention sweep", () => {
  it("defaults to preview-only and never writes or deletes memories", async () => {
    const { client, items, projectId } = makeClient();
    const result = await runMemoryRetentionSweep({
      client,
      projectPath: process.cwd(),
      now,
    });

    expect(result).toMatchObject({
      mode: "preview_only",
      projectId,
      scanned: 4,
      eligibleToExpire: 2,
      skippedQuarantined: 1,
      exportTruncated: false,
    });
    expect(result.items.map((item) => item.id)).toEqual(["old-temp", "explicit-expiry"]);
    expect(result.items.every((item) => item.state === "stale" || item.state === "expired")).toBe(true);
    expect(client.markAtomicExpired).not.toHaveBeenCalled();
    expect(client.deleteAtomicScoped).not.toHaveBeenCalled();
    expect(items.find((item) => item.id === "durable")?.metadata.lifecycleState).toBeUndefined();
  });

  it("marks stale/expired candidates as expired with compare-and-set tokens and leaves durable/quarantined rows alone", async () => {
    const { client, items } = makeClient();
    const result = await runMemoryRetentionSweep({
      client,
      projectPath: process.cwd(),
      now,
      apply: true,
    });

    expect(result.mode).toBe("applied");
    expect(result.markedExpired).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.conflicts).toBe(0);
    expect(client.markAtomicExpired).toHaveBeenCalledTimes(2);
    expect(items.find((item) => item.id === "old-temp")?.metadata.lifecycleState).toBe("expired");
    expect(items.find((item) => item.id === "explicit-expiry")?.metadata.validationStatus).toBe("stale");
    expect(items.find((item) => item.id === "durable")?.metadata.lifecycleState).toBeUndefined();
    expect(items.find((item) => item.id === "quarantined")?.metadata.lifecycleState).toBeUndefined();
    expect(client.deleteAtomicScoped).not.toHaveBeenCalled();
  });

  it("does not overwrite a memory changed since the retention preview", async () => {
    const { client } = makeClient();
    client.markAtomicExpired.mockResolvedValueOnce({ status: "conflict", currentUpdatedAt: now });
    const result = await runMemoryRetentionSweep({
      client,
      projectPath: process.cwd(),
      now,
      apply: true,
    });

    expect(result.conflicts).toBe(1);
    expect(result.markedExpired).toBe(1);
    expect(result.results?.some((entry) => entry.reason === "memory_changed_since_sweep_preview")).toBe(true);
  });
});

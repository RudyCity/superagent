import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { claimTakeoverTarget, releaseTakeoverTarget } from "../src/core/browserTakeover/takeoverTargetLease.js";

describe("Durable exclusive browser takeover target reservation", () => {
  async function inIsolatedDirectory(test: (dir: string) => Promise<void>) {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "sa-target-reservation-"));
    try { await test(dir); } finally { await fsp.rm(dir, { recursive: true, force: true }); }
  }

  it("allows only one of two simultaneous claimants for the same CDP tab", async () => {
    await inIsolatedDirectory(async (dir) => {
      const ids = [crypto.randomUUID(), crypto.randomUUID()];
      const results = await Promise.allSettled(ids.map(id => claimTakeoverTarget(9222, "tab-one", id, dir)));
      expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
      const winner = ids[results.findIndex(result => result.status === "fulfilled")];
      await releaseTakeoverTarget(9222, "tab-one", winner, dir);
    });
  });

  it("survives restart and refuses a different session until the verified owner releases it", async () => {
    await inIsolatedDirectory(async (dir) => {
      const first = crypto.randomUUID();
      const second = crypto.randomUUID();
      await claimTakeoverTarget(9222, "tab-sticky", first, dir);
      await expect(claimTakeoverTarget(9222, "tab-sticky", second, dir)).rejects.toThrow(/already reserves/i);
      await expect(releaseTakeoverTarget(9222, "tab-sticky", second, dir)).rejects.toThrow(/another session/i);
      await expect(claimTakeoverTarget(9222, "tab-sticky", second, dir)).rejects.toThrow(/already reserves/i);
      await releaseTakeoverTarget(9222, "tab-sticky", first, dir);
      await claimTakeoverTarget(9222, "tab-sticky", second, dir);
      await releaseTakeoverTarget(9222, "tab-sticky", second, dir);
    });
  });

  it("keeps distinct browser targets independent", async () => {
    await inIsolatedDirectory(async (dir) => {
      const one = crypto.randomUUID(), two = crypto.randomUUID();
      await claimTakeoverTarget(9222, "tab-a", one, dir);
      await claimTakeoverTarget(9222, "tab-b", two, dir);
      await releaseTakeoverTarget(9222, "tab-a", one, dir);
      await releaseTakeoverTarget(9222, "tab-b", two, dir);
    });
  });
});

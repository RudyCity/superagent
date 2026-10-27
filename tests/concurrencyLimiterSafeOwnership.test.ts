import { describe, expect, it, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { SharedConcurrencyLimiter, type ConcurrencyLease } from "../src/core/rateLimiter.js";

describe("Concurrency limiter limits and safe lease ownership (DEEP-05)", () => {
  let tmpConfigDir: string;
  let limiter: SharedConcurrencyLimiter;

  beforeEach(() => {
    process.env.SUPERAGENT_TEST_LIMITS = "true";
    tmpConfigDir = path.join(os.tmpdir(), `superagent_conc_test_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`);
    fs.mkdirSync(tmpConfigDir, { recursive: true });
    limiter = new SharedConcurrencyLimiter();
    (limiter as any).baseLockDir = tmpConfigDir;
  });

  afterEach(() => {
    delete process.env.SUPERAGENT_TEST_LIMITS;
    try {
      fs.rmSync(tmpConfigDir, { recursive: true, force: true });
    } catch {}
  });

  it("supports limit 0 (unlimited/disabled) without blocking or creating locks", async () => {
    const lease1 = await limiter.acquire(0);
    const lease2 = await limiter.acquire(0);
    expect(lease1).toBeNull();
    expect(lease2).toBeNull();

    // No lock files created
    const files = fs.readdirSync(tmpConfigDir);
    expect(files.filter(f => f.includes(".lock"))).toHaveLength(0);

    limiter.release(lease1);
    limiter.release(lease2);
  });

  it("supports limit 1 and serializes holders", async () => {
    const events: string[] = [];

    const lease1 = await limiter.acquire(1);
    expect(lease1).not.toBeNull();
    events.push("holder1_acquired");

    let holder2Acquired = false;
    const task2 = (async () => {
      const lease2 = await limiter.acquire(1);
      holder2Acquired = true;
      events.push("holder2_acquired");
      limiter.release(lease2);
    })();

    // Holder 2 must be blocked while Holder 1 holds the lock
    await new Promise(r => setTimeout(r, 100));
    expect(holder2Acquired).toBe(false);

    // Holder 1 releases
    limiter.release(lease1);
    await task2;

    expect(holder2Acquired).toBe(true);
    expect(events).toEqual(["holder1_acquired", "holder2_acquired"]);
  });

  it("supports limit 2 and allows 2 concurrent holders but blocks a 3rd", async () => {
    const lease1 = await limiter.acquire(2);
    const lease2 = await limiter.acquire(2);
    expect(lease1).not.toBeNull();
    expect(lease2).not.toBeNull();
    expect(lease1?.slot).not.toBe(lease2?.slot);

    let holder3Acquired = false;
    const task3 = (async () => {
      const lease3 = await limiter.acquire(2);
      holder3Acquired = true;
      limiter.release(lease3);
    })();

    // 3rd holder must wait
    await new Promise(r => setTimeout(r, 100));
    expect(holder3Acquired).toBe(false);

    // Releasing one slot unblocks holder 3
    limiter.release(lease1);
    await task3;
    expect(holder3Acquired).toBe(true);

    limiter.release(lease2);
  });

  it("supports limit 3 allowing 3 concurrent holders", async () => {
    const lease1 = await limiter.acquire(3);
    const lease2 = await limiter.acquire(3);
    const lease3 = await limiter.acquire(3);

    expect(lease1).not.toBeNull();
    expect(lease2).not.toBeNull();
    expect(lease3).not.toBeNull();

    const slots = new Set([lease1?.slot, lease2?.slot, lease3?.slot]);
    expect(slots.size).toBe(3);

    limiter.release(lease1);
    limiter.release(lease2);
    limiter.release(lease3);
  });

  it("never deletes or steals a live owner lock even if timestamp is >60s old", async () => {
    const slotPath = path.join(tmpConfigDir, "concurrency.lock");
    // Simulate an existing lock held by CURRENT process (which is alive), but mtime and timestamp > 120s old
    const oldTimestamp = Date.now() - 120000;
    fs.writeFileSync(
      slotPath,
      JSON.stringify({
        leaseId: "live_holder_old_lease",
        pid: process.pid,
        slot: 0,
        acquiredAt: oldTimestamp,
        updatedAt: oldTimestamp,
      })
    );
    // Set old mtime on disk
    fs.utimesSync(slotPath, oldTimestamp / 1000, oldTimestamp / 1000);

    // Another caller attempts to acquire limit 1 with a short timeout
    let acquired = false;
    const acquirePromise = Promise.race([
      limiter.acquire(1).then((l) => {
        acquired = true;
        return l;
      }),
      new Promise<null>((r) => setTimeout(() => r(null), 300)),
    ]);

    await acquirePromise;

    // The lock MUST NOT be stolen or deleted because the process is still alive!
    expect(acquired).toBe(false);
    expect(fs.existsSync(slotPath)).toBe(true);
    const content = JSON.parse(fs.readFileSync(slotPath, "utf-8"));
    expect(content.leaseId).toBe("live_holder_old_lease");
  });

  it("releases only locks owned by caller lease", async () => {
    const leaseReal = await limiter.acquire(1);
    expect(leaseReal).not.toBeNull();

    // Fabricate a fake lease targeting the same lock
    const fakeLease: ConcurrencyLease = {
      leaseId: "fake_intruder",
      slot: 0,
      pid: process.pid,
      lockPath: leaseReal!.lockPath,
    };

    // Attempting to release with the fake lease must NOT delete the real holder's lock
    limiter.release(fakeLease);
    expect(fs.existsSync(leaseReal!.lockPath)).toBe(true);

    // Releasing with genuine lease removes the lock
    limiter.release(leaseReal);
    expect(fs.existsSync(leaseReal!.lockPath)).toBe(false);
  });

  it("maintains waiter hygiene under sustained contention without unbounded queue growth or lost wakeups (NEW-01)", async () => {
    // Acquire slot with limit 1
    const lease1 = await limiter.acquire(1);
    expect(lease1).not.toBeNull();

    // Spawn 3 concurrent contenders waiting on the single slot
    const acquiredOrder: string[] = [];

    const contender = (id: string) => async () => {
      const lease = await limiter.acquire(1);
      if (lease) {
        acquiredOrder.push(id);
        limiter.release(lease);
      }
    };

    const c1 = contender("C1")();
    const c2 = contender("C2")();
    const c3 = contender("C3")();

    // Let them wait across multiple timer intervals (550ms = ~5 iterations of 100ms timers)
    await new Promise((r) => setTimeout(r, 550));

    // Under old behavior, 3 contenders waiting for 5 intervals accumulated 15+ stale callbacks.
    // Under NEW-01 hygiene, processQueue only holds active waiting entries (<= 3).
    const queueLen = limiter.getQueueLength();
    expect(queueLen).toBeLessThanOrEqual(3);

    // Release slot 1 to unblock contenders
    limiter.release(lease1);

    // All contenders must acquire without lost wakeups
    await Promise.all([c1, c2, c3]);

    expect(acquiredOrder).toHaveLength(3);
    expect(acquiredOrder).toContain("C1");
    expect(acquiredOrder).toContain("C2");
    expect(acquiredOrder).toContain("C3");

    // Queue must be fully drained
    expect(limiter.getQueueLength()).toBe(0);
  });
});

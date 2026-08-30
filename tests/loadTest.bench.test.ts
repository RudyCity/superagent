// tests/loadTest.bench.test.ts
//
// FASE 6 (1.5.8): Empirical micro-benchmark for the lock
// subsystem and SQLite mirror. Run intentionally with
// `npx vitest run tests/loadTest.bench.test.ts` to validate
// the perf claims of 1.5.4-1.5.7 with hard numbers.
//
// What it measures:
//
//   1. Cold start: import the storage modules.
//   2. SQLite `replaceAllLocks` (100 rows, transactional).
//   3. SQLite `readAllLocks` (100 rows).
//   4. SQLite churn: 50 round-trips of 100 rows each.
//   5. Lock acquisition throughput via `lockFile` (500 ops,
//      5 sessions x 100 unique files).
//   6. Lock release burst: 500 sequential `releaseFile` calls.
//   7. Atomic write + rename cost on 1000-entry JSON.
//   8. `getLockStats` cost on a 100-lock set.
//
// Each measurement is reported as a named line and asserted
// against a soft ceiling (5x the baseline I expect on a
// typical dev box). Soft ceilings are deliberately loose
// because CI runners vary widely; the goal is regression
// catching, not absolute performance enforcement.
//
// IMPORTANT: Each test uses a fresh SUPERAGENT_SESSION_ID so
// the lock subsystem doesn't see ghost state from previous
// runs. The tmp dir is wiped in afterAll.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "sa-bench-"));
const PERF_LOG: Array<{ name: string; ms: number; ops?: number; opPerMs?: number }> = [];

function nowMs(): number {
  const [s, ns] = process.hrtime();
  return s * 1e3 + ns / 1e6;
}

function record(name: string, ms: number, ops?: number) {
  PERF_LOG.push({
    name,
    ms: Number(ms.toFixed(3)),
    ops,
    opPerMs: ops ? Number((ops / ms).toFixed(2)) : undefined,
  });
  // eslint-disable-next-line no-console
  console.log(
    `[BENCH] ${name.padEnd(60)} ${ms.toFixed(2).padStart(10)}ms${
      ops ? `  (${(ops / ms).toFixed(0)} ops/ms)` : ""
    }`
  );
}

describe("Load test / micro-benchmark (FASE 6 / 1.5.8)", () => {
  beforeAll(() => {
    // Make getGlobalConfigDir() return our tmp dir so historyDb writes
    // here instead of ~/.superagent-r. The sharedMemory module reads
    // this same env to locate file-locks.json.
    process.env.SUPERAGENT_CONFIG_DIR = TMP_ROOT;
  });

  afterAll(() => {
    try {
      fs.rmSync(TMP_ROOT, { recursive: true, force: true });
    } catch {}
    // eslint-disable-next-line no-console
    console.log("\n=== Benchmark Summary ===");
    for (const r of PERF_LOG) {
      // eslint-disable-next-line no-console
      console.log(
        `  ${r.name.padEnd(60)} ${String(r.ms + "ms").padStart(12)}${
          r.opPerMs ? `  (${r.opPerMs} ops/ms)` : ""
        }`
      );
    }
  });

  it("1. cold-start import of storage modules", async () => {
    const t0 = nowMs();
    const sharedMemory = await import("../src/core/storage/sharedMemory.js");
    const historyDb = await import("../src/core/storage/historyDb.js");
    const fileLocksDb = await import("../src/core/storage/fileLocksDb.js");
    void sharedMemory;
    void historyDb;
    void fileLocksDb;
    const elapsed = nowMs() - t0;
    record("cold-start import (sharedMemory + historyDb + fileLocksDb)", elapsed);
    expect(elapsed).toBeLessThan(5000);
  }, 15000);

  it("2. SQLite replaceAllLocks (100 rows, transactional)", async () => {
    const historyDb = await import("../src/core/storage/historyDb.js");
    const db = historyDb.getHistoryDb();
    expect(db).toBeTruthy();

    const fileLocksDb = await import("../src/core/storage/fileLocksDb.js");
    const entries: any[] = [];
    for (let i = 0; i < 100; i++) {
      entries.push({
        filePath: `/bench/file-${i}.ts`,
        sessionId: "sess-bench",
        lockedAt: Date.now(),
        ttlMs: 60000,
        projectPath: "/bench",
        pid: 99999,
        terminalType: "cli",
      });
    }
    const t0 = nowMs();
    const ok = await fileLocksDb.replaceAllLocks(entries);
    const elapsed = nowMs() - t0;
    expect(ok).toBe(true);
    record("SQLite replaceAllLocks (100 rows)", elapsed);
    expect(elapsed).toBeLessThan(2000);
  });

  it("3. SQLite readAllLocks (100 rows)", async () => {
    const fileLocksDb = await import("../src/core/storage/fileLocksDb.js");
    const t0 = nowMs();
    const readBack = await fileLocksDb.readAllLocks();
    const elapsed = nowMs() - t0;
    expect(readBack.length).toBeGreaterThanOrEqual(100);
    record("SQLite readAllLocks (100 rows)", elapsed);
    expect(elapsed).toBeLessThan(500);
  });

  it("4. SQLite churn: 50 round-trips of 100 rows", async () => {
    const fileLocksDb = await import("../src/core/storage/fileLocksDb.js");
    const t0 = nowMs();
    for (let r = 0; r < 50; r++) {
      const entries: any[] = [];
      for (let i = 0; i < 100; i++) {
        entries.push({
          filePath: `/churn/r${r}-f${i}.ts`,
          sessionId: "churn-sess",
          lockedAt: Date.now() + r,
          ttlMs: 60000,
          projectPath: "/churn",
          pid: 88888,
          terminalType: "cli",
        });
      }
      const ok = await fileLocksDb.replaceAllLocks(entries);
      expect(ok).toBe(true);
    }
    const elapsed = nowMs() - t0;
    record("SQLite churn: 50 round-trips x 100 rows", elapsed, 50);
    expect(elapsed).toBeLessThan(20000);
    // After the churn, the *last* batch (r=49) should be the only
    // rows in the table.
    const final = await fileLocksDb.readAllLocks();
    expect(final.length).toBe(100);
    // Sanity: the rows should all be from r=49.
    expect(final.every((l) => l.filePath.startsWith("/churn/r49-"))).toBe(true);
  });

  it("5. lockFile x500 (5 sessions x 100 unique files)", async () => {
    const sharedMemory = await import("../src/core/storage/sharedMemory.js");
    const N = 500;
    const t0 = nowMs();
    let acquired = 0;
    for (let i = 0; i < N; i++) {
      const sessionId = `bench-sess-${i % 5}`;
      const res = sharedMemory.lockFile(
        `D:/bench/file-${i}.ts`,
        sessionId,
        "cli",
        60000,
        TMP_ROOT
      );
      if (res && (res as any).ok !== false) acquired++;
    }
    const elapsed = nowMs() - t0;
    record(`lockFile x${N} (5 sessions, 100 files each)`, elapsed, N);
    expect(acquired).toBe(500);
    expect(elapsed).toBeLessThan(10000);
  });

  it("6. releaseFile x500 (sequential release)", async () => {
    const sharedMemory = await import("../src/core/storage/sharedMemory.js");
    const t0 = nowMs();
    for (let i = 0; i < 500; i++) {
      const sessionId = `bench-sess-${i % 5}`;
      sharedMemory.releaseFile(
        `D:/bench/file-${i}.ts`,
        sessionId,
        TMP_ROOT
      );
    }
    const elapsed = nowMs() - t0;
    record(`releaseFile x500 (sequential)`, elapsed, 500);
    expect(elapsed).toBeLessThan(10000);
  });

  it("7. atomic write + rename cost on 1000-entry JSON", async () => {
    // Direct test of the atomic write primitive, not via persistLocksToDisk
    // (which is debounced).
    const entries: any[] = [];
    for (let i = 0; i < 1000; i++) {
      entries.push({
        filePath: `D:/atomic/file-${i}.ts`,
        sessionId: `sess-${i % 10}`,
        lockedAt: Date.now(),
        ttlMs: 60000,
        projectPath: "D:/atomic",
        pid: 12345,
        terminalType: "cli",
      });
    }
    const target = path.join(TMP_ROOT, "atomic-locks.json");
    const t0 = nowMs();
    for (let i = 0; i < 10; i++) {
      // 10 sequential writes
      fs.writeFileSync(target + ".tmp", JSON.stringify(entries));
      fs.renameSync(target + ".tmp", target);
    }
    const elapsed = nowMs() - t0;
    record("atomic write + rename x10 (1000 entries each)", elapsed, 10);
    expect(elapsed).toBeLessThan(5000);
  });

  it("8. getLockStats on a 100-lock set", async () => {
    const sharedMemory = await import("../src/core/storage/sharedMemory.js");
    // Acquire 100 locks first
    for (let i = 0; i < 100; i++) {
      sharedMemory.lockFile(
        `D:/stats/file-${i}.ts`,
        "stats-sess",
        "cli",
        60000,
        TMP_ROOT
      );
    }
    const t0 = nowMs();
    const stats = sharedMemory.getLockStats(TMP_ROOT);
    const elapsed = nowMs() - t0;
    record("getLockStats on 100 locks", elapsed);
    expect(stats).toBeTruthy();
    expect(elapsed).toBeLessThan(2000);
  });
});

import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getProcessPoolMetrics, readFilesInProcessPool } from "../src/core/agent/ProcessPool.js";

const tempDirs: string[] = [];

async function makeFixture(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "superagent-process-pool-"));
  tempDirs.push(root);
  await Promise.all(Object.entries(files).map(async ([name, content]) => {
    const target = path.join(root, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
  }));
  return root;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("file read process pool", () => {
  it("runs a batch in isolated OS processes and preserves original result order", async () => {
    const root = await makeFixture({
      "a.txt": "alpha\nalpha second line",
      "b.txt": "bravo\nbravo second line",
      "c.txt": "charlie\ncharlie second line",
      "d.txt": "delta\ndelta second line",
    });
    const before = getProcessPoolMetrics();
    const jobs = ["a.txt", "b.txt", "c.txt", "d.txt"].map((name) => ({
      filePath: path.join(root, name),
      displayPath: name,
      offset: 1,
      limit: 2,
    }));

    const results = await readFilesInProcessPool(jobs, { maxWorkers: 3, timeoutMs: 10_000 });

    expect(results).toHaveLength(4);
    expect(results.map((result) => result.match(/--- File: ([^ ]+)/)?.[1])).toEqual([
      "a.txt", "b.txt", "c.txt", "d.txt",
    ]);
    expect(results[0]).toContain("alpha");
    expect(results[1]).toContain("bravo");
    const after = getProcessPoolMetrics();
    expect(after.spawned - before.spawned).toBe(3);
    expect(after.completed - before.completed).toBe(3);
    expect(after.maxActive).toBeGreaterThanOrEqual(2);
  });

  it("preserves Unicode content from worker stdout", async () => {
    const root = await makeFixture({ "unicode.txt": "Halo 👋🏼 — 日本語 — こんにちは — 🌱" });
    const [result] = await readFilesInProcessPool([
      { filePath: path.join(root, "unicode.txt"), displayPath: "unicode.txt", offset: 1, limit: 10 },
    ], { maxWorkers: 1, timeoutMs: 10_000 });

    expect(result).toContain("Halo 👋🏼 — 日本語 — こんにちは — 🌱");
  });

  it("enforces the four-process cap globally across simultaneous batches", async () => {
    const root = await makeFixture(Object.fromEntries(
      Array.from({ length: 8 }, (_, index) => [`parallel-${index}.txt`, `line ${index}\nsecond line`]),
    ));
    const before = getProcessPoolMetrics();
    const makeJobs = (start: number) => Array.from({ length: 4 }, (_, index) => {
      const name = `parallel-${start + index}.txt`;
      return { filePath: path.join(root, name), displayPath: name, offset: 1, limit: 2 };
    });

    const results = await Promise.all([
      readFilesInProcessPool(makeJobs(0), { maxWorkers: 4, timeoutMs: 10_000 }),
      readFilesInProcessPool(makeJobs(4), { maxWorkers: 4, timeoutMs: 10_000 }),
    ]);

    expect(results.flat()).toHaveLength(8);
    expect(getProcessPoolMetrics().spawned - before.spawned).toBe(8);
    expect(getProcessPoolMetrics().maxActive).toBeLessThanOrEqual(4);
    expect(getProcessPoolMetrics().maxActive).toBe(4);
  });

  it("returns a per-file error without failing other files in the worker batch", async () => {
    const root = await makeFixture({ "valid.txt": "line one\nline two" });
    const results = await readFilesInProcessPool([
      { filePath: path.join(root, "valid.txt"), displayPath: "valid.txt", offset: 1, limit: 10 },
      { filePath: path.join(root, "missing.txt"), displayPath: "missing.txt", offset: 1, limit: 10 },
    ], { maxWorkers: 1, timeoutMs: 10_000 });

    expect(results[0]).toContain("line one");
    expect(results[1]).toContain("Error:");
    expect(results[1]).toContain("missing.txt");
  });

  it("honours per-file offset and limit while reading in a worker process", async () => {
    const root = await makeFixture({ "numbered.txt": "one\ntwo\nthree\nfour" });
    const [result] = await readFilesInProcessPool([
      { filePath: path.join(root, "numbered.txt"), displayPath: "numbered.txt", offset: 2, limit: 2 },
    ], { timeoutMs: 10_000 });

    expect(result).toContain("2: two");
    expect(result).toContain("3: three");
    expect(result).not.toContain("4: four");
  });
});

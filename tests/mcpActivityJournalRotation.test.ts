import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  McpActivityJournal,
  type McpJournalEntry,
} from "../src/core/mcp/mcpActivityJournal.js";

describe("MCP Activity Journal Rotation & Retention (M2)", () => {
  let testDir: string;
  let journalPath: string;

  beforeEach(() => {
    testDir = path.join(os.tmpdir(), `superagent-journal-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(testDir, { recursive: true });
    journalPath = path.join(testDir, "mcp-activity.jsonl");
  });

  afterEach(() => {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  it("appends entries and rotates when maxJournalBytes threshold is exceeded", () => {
    // 50 KB threshold, 3 archives
    const maxBytes = 50 * 1024;
    const journal = new McpActivityJournal({
      journalPath,
      maxJournalBytes: maxBytes,
      maxArchives: 3,
    });

    const createEntry = (i: number): McpJournalEntry => ({
      ts: Date.now(),
      pid: process.pid,
      workspace: testDir,
      chatLine: `Chat line ${i} with padding text `.repeat(5),
      event: {
        type: "tool_call",
        tool: "superagent_read_file",
        args: { index: i },
        output: "Result payload ".repeat(50),
        timestamp: Date.now(),
      },
    });

    // Write enough entries to exceed 50 KB
    for (let i = 0; i < 150; i++) {
      journal.appendEntry(createEntry(i));
    }

    const stats = journal.getJournalStats();
    expect(stats.activeSizeBytes).toBeGreaterThan(0);
    expect(stats.activeSizeBytes).toBeLessThan(maxBytes + 4096);
    expect(stats.archiveCount).toBeGreaterThanOrEqual(1);

    // Verify archives .1, etc. exist
    const archive1 = path.join(testDir, "mcp-activity.1.jsonl");
    expect(fs.existsSync(archive1)).toBe(true);
  });

  it("caps total retained archives to maxArchives", () => {
    const maxBytes = 10 * 1024; // 10 KB threshold
    const maxArchives = 3;
    const journal = new McpActivityJournal({
      journalPath,
      maxJournalBytes: maxBytes,
      maxArchives,
    });

    for (let i = 0; i < 200; i++) {
      journal.appendEntry({
        ts: Date.now(),
        pid: process.pid,
        chatLine: `Line ${i}`,
        event: {
          type: "tool_call",
          tool: "test_tool",
          output: "x".repeat(1024),
          timestamp: Date.now(),
        },
      });
    }

    const stats = journal.getJournalStats();
    expect(stats.archiveCount).toBeLessThanOrEqual(maxArchives);

    // Archive 4 should NOT exist because maxArchives is 3
    const archive4 = path.join(testDir, "mcp-activity.4.jsonl");
    expect(fs.existsSync(archive4)).toBe(false);
  });

  it("safely migrates legacy oversized journal without reading it into memory", () => {
    // Simulate legacy 200 KB file when limit is 50 KB
    const dummyContent = "{\"legacy\": true}\n".repeat(10_000);
    fs.writeFileSync(journalPath, dummyContent, "utf8");
    const initialSize = fs.statSync(journalPath).size;
    expect(initialSize).toBeGreaterThan(50 * 1024);

    const journal = new McpActivityJournal({
      journalPath,
      maxJournalBytes: 50 * 1024,
      maxArchives: 3,
    });

    // Trigger migration
    const migrated = journal.migrateLegacyOversizedJournal();
    expect(migrated).toBe(true);

    // Active journal should either be gone or ready for new appends
    const files = fs.readdirSync(testDir);
    const legacyArchive = files.find((f) => f.includes("legacy-"));
    expect(legacyArchive).toBeDefined();

    // Now appending a new entry works cleanly
    journal.appendEntry({
      ts: Date.now(),
      pid: process.pid,
      chatLine: "Fresh post-migration entry",
      event: {
        type: "client_connect",
        timestamp: Date.now(),
      },
    });

    expect(fs.existsSync(journalPath)).toBe(true);
    const newStat = fs.statSync(journalPath);
    expect(newStat.size).toBeLessThan(1024); // Fresh, tiny active file
  });

  it("bounds legacy archives and prunes older legacy files beyond maxLegacyArchives (Finding 4)", () => {
    // Create 5 legacy archive files manually
    const ext = ".jsonl";
    const base = path.join(testDir, "mcp-activity");
    for (let i = 1; i <= 5; i++) {
      const legacyFile = `${base}.legacy-${1000 + i * 10}${ext}`;
      fs.writeFileSync(legacyFile, `{"legacyEntry": ${i}}\n`, "utf8");
    }

    const journal = new McpActivityJournal({
      journalPath,
      maxJournalBytes: 50 * 1024,
      maxArchives: 3,
      maxLegacyArchives: 2,
    });

    journal.cleanLegacyArchives();

    const stats = journal.getJournalStats();
    expect(stats.legacyArchiveCount).toBe(2);
    expect(stats.legacyArchives).toHaveLength(2);
    expect(stats.legacySizeBytes).toBeGreaterThan(0);
    expect(stats.totalSizeBytes).toBeGreaterThanOrEqual(stats.legacySizeBytes);

    // Verify older legacy files 1010, 1020, 1030 were unlinked, while newest 1040, 1050 remain
    const files = fs.readdirSync(testDir);
    const legacyNames = files.filter(f => f.includes("legacy-"));
    expect(legacyNames).toHaveLength(2);
  });

  it("bounds active and numeric archive files by threshold plus at most one bounded record", () => {
    const maxJournalBytes = 1024;
    const maxRecordBytes = 2048;
    const maxArchives = 2;
    const journal = new McpActivityJournal({
      journalPath,
      maxJournalBytes,
      maxRecordBytes,
      maxArchives,
    });

    for (let i = 0; i < 40; i++) {
      journal.appendEntry({
        ts: Date.now(),
        pid: process.pid,
        chatLine: `entry-${i} ${"c".repeat(5000)}`,
        event: {
          type: "tool_call",
          tool: "overshoot_bound_test",
          output: "x".repeat(5000),
          timestamp: Date.now(),
        },
      });
    }

    const stats = journal.getJournalStats();
    const strictPerFileExclusiveBound = maxJournalBytes + maxRecordBytes + 1;
    const retainedFiles = [journalPath, ...stats.archives].filter((file) => fs.existsSync(file));

    expect(stats.archiveCount).toBeLessThanOrEqual(maxArchives);
    for (const file of retainedFiles) {
      expect(fs.statSync(file).size).toBeLessThan(strictPerFileExclusiveBound);
    }

    const activeAndNumericBytes = stats.activeSizeBytes + stats.archiveSizeBytes;
    expect(activeAndNumericBytes).toBeLessThan((maxArchives + 1) * strictPerFileExclusiveBound);
  });

  it("rotation lock handles concurrent writers within same process safely (Finding 3)", async () => {
    const maxBytes = 5 * 1024; // 5 KB threshold for frequent rotation
    const writersCount = 5;
    const entriesPerWriter = 40;

    // Concurrently write entries from multiple journal instances in same process
    const writers = Array.from({ length: writersCount }, (_, writerIndex) => {
      const journalInstance = new McpActivityJournal({
        journalPath,
        maxJournalBytes: maxBytes,
        maxArchives: 3,
      });

      return (async () => {
        for (let i = 0; i < entriesPerWriter; i++) {
          journalInstance.appendEntry({
            ts: Date.now(),
            pid: 1000 + writerIndex,
            chatLine: `Writer ${writerIndex} line ${i}`,
            event: {
              type: "tool_call",
              tool: "concurrent_tool",
              output: "payload ".repeat(20),
              timestamp: Date.now(),
            },
          });
          // Small yield
          await new Promise((resolve) => setTimeout(resolve, 2));
        }
      })();
    });

    await Promise.all(writers);

    // Assert that rotation lock file was released and cleaned up
    const lockPath = `${journalPath}.rotation.lock`;
    expect(fs.existsSync(lockPath)).toBe(false);

    // Assert active journal file exists and stats are bounded
    const checkJournal = new McpActivityJournal({ journalPath, maxArchives: 3 });
    const stats = checkJournal.getJournalStats();
    expect(stats.activeSizeBytes).toBeGreaterThan(0);
    expect(stats.archiveCount).toBeLessThanOrEqual(3);

    // Assert all readable lines across active and archive files are valid JSON
    const allFiles = [journalPath, ...stats.archives];
    for (const f of allFiles) {
      if (fs.existsSync(f)) {
        const lines = fs.readFileSync(f, "utf8").split("\n").filter(l => l.trim().length > 0);
        for (const line of lines) {
          const parsed = JSON.parse(line);
          expect(parsed.pid).toBeDefined();
          expect(parsed.event).toBeDefined();
        }
      }
    }
  });

  it("cross-process rotation lock handles concurrent separate OS processes writing/rotating safely (Finding 3 multi-process)", async () => {
    const maxBytes = 5 * 1024; // 5 KB threshold for frequent rotation
    const workersCount = 3;
    const entriesPerWorker = 30;
    const workerScript = path.join(__dirname, "fixtures", "journalRotationWorker.ts");

    // Spawn 3 separate OS processes writing and rotating the same journal concurrently
    const childProcs = Array.from({ length: workersCount }, (_, idx) => {
      return Bun.spawn(
        [
          process.execPath,
          workerScript,
          journalPath,
          String(idx + 1),
          String(entriesPerWorker),
          String(maxBytes),
        ],
        {
          stdout: "pipe",
          stderr: "pipe",
        }
      );
    });

    const exitCodes = await Promise.all(childProcs.map((p) => p.exited));
    for (const code of exitCodes) {
      expect(code).toBe(0);
    }

    // Assert that rotation lock file was released and cleaned up (no stale rotation lock)
    const lockPath = `${journalPath}.rotation.lock`;
    expect(fs.existsSync(lockPath)).toBe(false);

    // Assert active journal file exists and retention is bounded
    const checkJournal = new McpActivityJournal({ journalPath, maxArchives: 3 });
    const stats = checkJournal.getJournalStats();
    expect(stats.activeSizeBytes).toBeGreaterThan(0);
    expect(stats.archiveCount).toBeLessThanOrEqual(3);

    // Assert all surviving lines across active and archive files parse as valid JSON
    const allFiles = [journalPath, ...stats.archives];
    let totalParsedEntries = 0;
    for (const f of allFiles) {
      if (fs.existsSync(f)) {
        const lines = fs.readFileSync(f, "utf8").split("\n").filter((l) => l.trim().length > 0);
        for (const line of lines) {
          const parsed = JSON.parse(line);
          expect(parsed.pid).toBeDefined();
          expect(parsed.event).toBeDefined();
          totalParsedEntries++;
        }
      }
    }
    expect(totalParsedEntries).toBeGreaterThan(0);
  });
});

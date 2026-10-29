import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  BoundedChunkedJournalReader,
  type McpJournalEntry,
} from "../src/core/mcp/mcpActivityJournal.js";

describe("MCP Activity Journal Bounded Reader (M3)", () => {
  let testDir: string;
  let journalPath: string;

  beforeEach(() => {
    testDir = path.join(os.tmpdir(), `superagent-reader-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(testDir, { recursive: true });
    journalPath = path.join(testDir, "mcp-activity.jsonl");
  });

  afterEach(() => {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  it("reads newly appended entries incrementally", () => {
    const reader = new BoundedChunkedJournalReader({
      journalPath,
      startAtEnd: false,
    });

    const entry1: McpJournalEntry = {
      ts: 1000,
      pid: 9999,
      chatLine: "line 1",
      event: { type: "client_connect", timestamp: 1000 },
    };
    fs.appendFileSync(journalPath, JSON.stringify(entry1) + "\n", "utf8");

    const readEntries: McpJournalEntry[] = [];
    const count1 = reader.poll((e) => readEntries.push(e));
    expect(count1).toBe(1);
    expect(readEntries).toHaveLength(1);
    expect(readEntries[0].chatLine).toBe("line 1");

    // Second poll with no new data returns 0
    const count2 = reader.poll((e) => readEntries.push(e));
    expect(count2).toBe(0);
    expect(readEntries).toHaveLength(1);

    // Append second entry
    const entry2: McpJournalEntry = {
      ts: 2000,
      pid: 9999,
      chatLine: "line 2",
      event: { type: "client_disconnect", timestamp: 2000 },
    };
    fs.appendFileSync(journalPath, JSON.stringify(entry2) + "\n", "utf8");

    const count3 = reader.poll((e) => readEntries.push(e));
    expect(count3).toBe(1);
    expect(readEntries).toHaveLength(2);
    expect(readEntries[1].chatLine).toBe("line 2");
  });

  it("reassembles split JSON lines across chunk boundaries correctly", () => {
    // Force tiny 64-byte chunks to ensure lines span across chunks
    const reader = new BoundedChunkedJournalReader({
      journalPath,
      chunkSize: 64,
      startAtEnd: false,
    });

    const entry: McpJournalEntry = {
      ts: 3000,
      pid: 12345,
      chatLine: "This is a long line that will definitely span multiple 64-byte chunks in the test",
      event: {
        type: "tool_call",
        tool: "superagent_read_file",
        output: "Result of file read spanning across chunks",
        timestamp: 3000,
      },
    };

    fs.writeFileSync(journalPath, JSON.stringify(entry) + "\n", "utf8");

    const readEntries: McpJournalEntry[] = [];
    const count = reader.poll((e) => readEntries.push(e));
    expect(count).toBe(1);
    expect(readEntries).toHaveLength(1);
    expect(readEntries[0].chatLine).toBe(entry.chatLine);
    expect(readEntries[0].event.tool).toBe("superagent_read_file");
  });

  it("skips giant legacy lines exceeding maxLineLength without allocating large memory", () => {
    // maxLineLength = 1024 bytes
    const reader = new BoundedChunkedJournalReader({
      journalPath,
      chunkSize: 512,
      maxLineLength: 1024,
      startAtEnd: false,
    });

    // Write a giant 50 KB line
    const giantLine = "x".repeat(50 * 1024) + "\n";
    // Followed by a valid normal line
    const validEntry: McpJournalEntry = {
      ts: 4000,
      pid: 1111,
      chatLine: "Normal valid line after giant line",
      event: { type: "client_connect", timestamp: 4000 },
    };
    fs.writeFileSync(journalPath, giantLine + JSON.stringify(validEntry) + "\n", "utf8");

    const readEntries: McpJournalEntry[] = [];
    reader.poll((e) => readEntries.push(e));

    // The giant line should be dropped safely and the subsequent valid line parsed
    expect(readEntries).toHaveLength(1);
    expect(readEntries[0].chatLine).toBe("Normal valid line after giant line");
  });

  it("detects journal rotation/truncation and recovers cleanly", () => {
    const reader = new BoundedChunkedJournalReader({
      journalPath,
      startAtEnd: false,
    });

    // Write 5 entries
    for (let i = 1; i <= 5; i++) {
      const e: McpJournalEntry = {
        ts: i * 1000,
        pid: 8888,
        chatLine: `Original entry ${i}`,
        event: { type: "client_connect", timestamp: i * 1000 },
      };
      fs.appendFileSync(journalPath, JSON.stringify(e) + "\n", "utf8");
    }

    const firstBatch: McpJournalEntry[] = [];
    reader.poll((e) => firstBatch.push(e));
    expect(firstBatch).toHaveLength(5);

    // Simulate journal rotation: truncate/replace with a small fresh file
    const freshEntry: McpJournalEntry = {
      ts: 9000,
      pid: 8888,
      chatLine: "Fresh entry after rotation",
      event: { type: "client_connect", timestamp: 9000 },
    };
    fs.writeFileSync(journalPath, JSON.stringify(freshEntry) + "\n", "utf8");

    // The reader should detect size < lastOffset, reset offset, and read the fresh entry
    const secondBatch: McpJournalEntry[] = [];
    reader.poll((e) => secondBatch.push(e));
    expect(secondBatch).toHaveLength(1);
    expect(secondBatch[0].chatLine).toBe("Fresh entry after rotation");
  });

  it("REGRESSION (Finding 2): detects file replacement when replacement size > previous offset (offset=214, size>214)", () => {
    // 1. Set up an initial journal file with some entries that total exactly 214 bytes (or close to it)
    const initialEntry1: McpJournalEntry = {
      ts: 1000,
      pid: 1111,
      chatLine: "old-1",
      event: { type: "client_connect", timestamp: 1000 },
    };
    const initialEntry2: McpJournalEntry = {
      ts: 2000,
      pid: 1111,
      chatLine: "old-2",
      event: { type: "client_disconnect", timestamp: 2000 },
    };

    const initialData = JSON.stringify(initialEntry1) + "\n" + JSON.stringify(initialEntry2) + "\n";
    fs.writeFileSync(journalPath, initialData, "utf8");

    const reader = new BoundedChunkedJournalReader({
      journalPath,
      startAtEnd: false,
    });

    const oldRead: McpJournalEntry[] = [];
    reader.poll((e) => oldRead.push(e));
    expect(oldRead).toHaveLength(2);

    const oldOffset = reader.getOffset();
    expect(oldOffset).toBeGreaterThan(0);

    // 2. Simulate file rotation/replacement:
    // Rotate old file to archive (or unlink) and create a brand new file whose size is GREATER than oldOffset.
    const archivedPath = path.join(testDir, "mcp-activity.1.jsonl");
    fs.renameSync(journalPath, archivedPath);

    // Create new file with 4 new entries: new1, new2, new3, new4
    const newEntries: McpJournalEntry[] = [
      { ts: 3001, pid: 2222, chatLine: "new1", event: { type: "tool_call", tool: "t1", timestamp: 3001 } },
      { ts: 3002, pid: 2222, chatLine: "new2", event: { type: "tool_call", tool: "t2", timestamp: 3002 } },
      { ts: 3003, pid: 2222, chatLine: "new3", event: { type: "tool_call", tool: "t3", timestamp: 3003 } },
      { ts: 3004, pid: 2222, chatLine: "new4", event: { type: "tool_call", tool: "t4", timestamp: 3004 } },
    ];

    const replacementContent = newEntries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    fs.writeFileSync(journalPath, replacementContent, "utf8");

    const newFileSize = fs.statSync(journalPath).size;
    // Assert replacement size is strictly greater than old offset
    expect(newFileSize).toBeGreaterThan(oldOffset);

    // 3. Reader polls the replacement file.
    // It MUST detect file replacement via file-identity generation, reset offset, and read ALL 4 entries.
    const newRead: McpJournalEntry[] = [];
    const count = reader.poll((e) => newRead.push(e));

    expect(count).toBe(4);
    expect(newRead).toHaveLength(4);
    expect(newRead[0].chatLine).toBe("new1");
    expect(newRead[1].chatLine).toBe("new2");
    expect(newRead[2].chatLine).toBe("new3");
    expect(newRead[3].chatLine).toBe("new4");
  });

  it("REGRESSION (HIGH Gap 1): detects same-file rewrite/truncate+rewrite with size > oldOffset without unlinking", () => {
    const old1: McpJournalEntry = {
      ts: 1000,
      pid: 1111,
      chatLine: "old1",
      event: { type: "client_connect", timestamp: 1000 },
    };
    const old2: McpJournalEntry = {
      ts: 2000,
      pid: 1111,
      chatLine: "old2",
      event: { type: "client_disconnect", timestamp: 2000 },
    };

    const initialContent = JSON.stringify(old1) + "\n" + JSON.stringify(old2) + "\n";
    fs.writeFileSync(journalPath, initialContent, "utf8");

    const reader = new BoundedChunkedJournalReader({
      journalPath,
      startAtEnd: false,
    });

    const firstRead: McpJournalEntry[] = [];
    const firstCount = reader.poll((e) => firstRead.push(e));
    expect(firstCount).toBe(2);
    expect(firstRead.map((e) => e.chatLine)).toEqual(["old1", "old2"]);

    const oldOffset = reader.getOffset();
    const statBefore = fs.statSync(journalPath);

    const newEntries: McpJournalEntry[] = [
      { ts: 3001, pid: 2222, chatLine: "new1", event: { type: "tool_call", tool: "t1", timestamp: 3001 } },
      { ts: 3002, pid: 2222, chatLine: "new2", event: { type: "tool_call", tool: "t2", timestamp: 3002 } },
      { ts: 3003, pid: 2222, chatLine: "new3", event: { type: "tool_call", tool: "t3", timestamp: 3003 } },
      { ts: 3004, pid: 2222, chatLine: "new4", event: { type: "tool_call", tool: "t4", timestamp: 3004 } },
    ];
    const replacementContent = newEntries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    fs.writeFileSync(journalPath, replacementContent, "utf8");

    const statAfter = fs.statSync(journalPath);
    expect(statAfter.size).toBeGreaterThan(oldOffset);
    if (statBefore.ino !== 0 && statAfter.ino !== 0) {
      expect(statAfter.ino).toBe(statBefore.ino);
    }

    const secondRead: McpJournalEntry[] = [];
    const secondCount = reader.poll((e) => secondRead.push(e));

    expect(secondCount).toBe(4);
    expect(secondRead.map((e) => e.chatLine)).toEqual(["new1", "new2", "new3", "new4"]);
  });

  it("REGRESSION (HIGH Gap 1): detects a same-file middle rewrite even when more than 4 KB at the beginning is unchanged", () => {
    const makeEntry = (chatLine: string, pad: string): McpJournalEntry & { pad: string } => ({
      ts: 1000,
      pid: 1111,
      chatLine,
      pad,
      event: { type: "client_connect", timestamp: 1000 },
    });

    let stablePrefix = "";
    let stableIndex = 0;
    while (Buffer.byteLength(stablePrefix, "utf8") < 5 * 1024) {
      stablePrefix += JSON.stringify(makeEntry(`stable-${stableIndex++}`, "x".repeat(120))) + "\n";
    }

    const oldTail = Array.from({ length: 30 }, (_, index) =>
      JSON.stringify(makeEntry(`old-${index}`, "o".repeat(100))) + "\n"
    ).join("");
    fs.writeFileSync(journalPath, stablePrefix + oldTail, "utf8");

    const reader = new BoundedChunkedJournalReader({ journalPath, startAtEnd: false });
    const firstRead: McpJournalEntry[] = [];
    reader.poll((entry) => firstRead.push(entry));
    const oldOffset = reader.getOffset();

    const rewrittenMiddle = ["NEW-A", "NEW-B", "NEW-C"]
      .map((chatLine) => JSON.stringify(makeEntry(chatLine, "n".repeat(100))) + "\n")
      .join("");

    let replacement = stablePrefix + rewrittenMiddle;
    let laterIndex = 0;
    while (Buffer.byteLength(replacement, "utf8") <= oldOffset + 512) {
      replacement += JSON.stringify(makeEntry(`later-${laterIndex++}`, "l".repeat(100))) + "\n";
    }

    fs.writeFileSync(journalPath, replacement, "utf8");

    const secondRead: McpJournalEntry[] = [];
    reader.poll((entry) => secondRead.push(entry));

    const names = secondRead.map((entry) => entry.chatLine);
    expect(names).toContain("NEW-A");
    expect(names).toContain("NEW-B");
    expect(names).toContain("NEW-C");
  });

  it("REGRESSION (HIGH Gap 1): normal append does not reset offset or replay prior entries", () => {
    const entry1: McpJournalEntry = {
      ts: 1000,
      pid: 1111,
      chatLine: "entry1",
      event: { type: "client_connect", timestamp: 1000 },
    };
    fs.writeFileSync(journalPath, JSON.stringify(entry1) + "\n", "utf8");

    const reader = new BoundedChunkedJournalReader({
      journalPath,
      startAtEnd: false,
    });

    const firstBatch: McpJournalEntry[] = [];
    expect(reader.poll((e) => firstBatch.push(e))).toBe(1);
    expect(firstBatch[0].chatLine).toBe("entry1");

    // Append entry2
    const entry2: McpJournalEntry = {
      ts: 2000,
      pid: 1111,
      chatLine: "entry2",
      event: { type: "tool_call", tool: "t2", timestamp: 2000 },
    };
    fs.appendFileSync(journalPath, JSON.stringify(entry2) + "\n", "utf8");

    const secondBatch: McpJournalEntry[] = [];
    expect(reader.poll((e) => secondBatch.push(e))).toBe(1);
    expect(secondBatch).toHaveLength(1);
    expect(secondBatch[0].chatLine).toBe("entry2");

    // Append entry3
    const entry3: McpJournalEntry = {
      ts: 3000,
      pid: 1111,
      chatLine: "entry3",
      event: { type: "tool_call", tool: "t3", timestamp: 3000 },
    };
    fs.appendFileSync(journalPath, JSON.stringify(entry3) + "\n", "utf8");

    const thirdBatch: McpJournalEntry[] = [];
    expect(reader.poll((e) => thirdBatch.push(e))).toBe(1);
    expect(thirdBatch).toHaveLength(1);
    expect(thirdBatch[0].chatLine).toBe("entry3");

    // Idle poll returns 0
    expect(reader.poll(() => {})).toBe(0);
  });
});

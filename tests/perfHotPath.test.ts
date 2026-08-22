import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

vi.mock("../src/core/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/config.js")>();
  return {
    ...actual,
    listHistorySessions: vi.fn(() => [] as ReturnType<typeof actual.listHistorySessions>),
  };
});

import { getModelPresets, listHistorySessions } from "../src/core/config.js";
import { getDashboardSuggestions } from "../src/utils/dashboardSuggestions.js";
import { TokenTracker } from "../src/core/context/TokenTracker.js";
import type { Message } from "../src/core/conversation.js";
import * as historyDbModule from "../src/core/storage/historyDb.js";

const mockListHistorySessions = listHistorySessions as unknown as ReturnType<typeof vi.fn>;

function hashOf(tracker: TokenTracker, msg: Message): string {
  return (tracker as unknown as { hashMessage(m: Message): string }).hashMessage(msg);
}

describe("Perf hot path fixes", () => {
  let tmpDir: string;
  let prevConfigDir: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "superagent-perf-test-"));
    prevConfigDir = process.env.SUPERAGENT_CONFIG_DIR;
    process.env.SUPERAGENT_CONFIG_DIR = tmpDir;
    historyDbModule.closeHistoryDb();
  });

  afterEach(() => {
    try {
      historyDbModule.closeHistoryDb();
    } catch {}
    if (prevConfigDir === undefined) {
      delete process.env.SUPERAGENT_CONFIG_DIR;
    } else {
      process.env.SUPERAGENT_CONFIG_DIR = prevConfigDir;
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it("readPresetsFile mtime cache: repeated reads hit the cache, mtime touch invalidates", () => {
    const presetsPath = path.join(tmpDir, "model-presets.json");
    const alphaJson = JSON.stringify({ multi: [{ name: "alpha", description: "d", models: {} }], single: [] });
    fs.writeFileSync(presetsPath, alphaJson, "utf-8");

    const readSpy = vi.spyOn(fs, "readFileSync");
    try {
      expect(getModelPresets("multi").map(p => p.name)).toEqual(["alpha"]);
      const readsAfterCold = readSpy.mock.calls.length;
      expect(readsAfterCold).toBeGreaterThan(0);

      expect(getModelPresets("multi").map(p => p.name)).toEqual(["alpha"]);
      expect(readSpy.mock.calls.length).toBe(readsAfterCold);
      expect(getModelPresets().length).toBeGreaterThan(0);
      expect(readSpy.mock.calls.length).toBe(readsAfterCold);

      // Same byte size ("alpha" -> "bravo"), touched mtime -> must invalidate
      const bravoJson = JSON.stringify({ multi: [{ name: "bravo", description: "d", models: {} }], single: [] });
      expect(bravoJson.length).toBe(alphaJson.length);
      fs.writeFileSync(presetsPath, bravoJson, "utf-8");
      const touched = new Date(Date.now() + 5000);
      fs.utimesSync(presetsPath, touched, touched);

      expect(getModelPresets("multi").map(p => p.name)).toEqual(["bravo"]);
      expect(readSpy.mock.calls.length).toBeGreaterThan(readsAfterCold);
    } finally {
      readSpy.mockRestore();
    }
  });

  it("readPresetsFile reflects external file updates without stale data", () => {
    const presetsPath = path.join(tmpDir, "model-presets.json");
    fs.writeFileSync(
      presetsPath,
      JSON.stringify({ multi: [{ name: "keep", description: "d", models: {} }], single: [] }),
      "utf-8"
    );
    expect(getModelPresets("multi").map(p => p.name)).toEqual(["keep"]);
    expect(getModelPresets("single")).toHaveLength(0);

    // External writer (same process) updates the file directly
    const updated = {
      multi: [{ name: "keep", description: "d", models: {} }],
      single: [{ name: "added", description: "d", models: {} }],
    };
    fs.writeFileSync(presetsPath, JSON.stringify(updated), "utf-8");
    const t = new Date(Date.now() + 1000);
    fs.utimesSync(presetsPath, t, t);

    expect(getModelPresets("single").map(p => p.name)).toEqual(["added"]);
    expect(getModelPresets("multi").map(p => p.name)).toEqual(["keep"]);
  });

  it("TokenTracker hash is stable per message and distinguishes differing content", () => {
    const tracker = new TokenTracker("test-model");
    const ts = 1700000000000;

    const base: Message = { role: "user", content: "hello world", timestamp: ts };
    expect(hashOf(tracker, base)).toBe(hashOf(tracker, { ...base }));

    const otherText: Message = { role: "user", content: "hello there", timestamp: ts };
    expect(hashOf(tracker, otherText)).not.toBe(hashOf(tracker, base));

    // Same length + same 64-char head but different tail must not collide
    const longA = "x".repeat(200) + "tail-A" + "z".repeat(50);
    const longB = "x".repeat(200) + "tail-B" + "z".repeat(50);
    expect(longA.length).toBe(longB.length);
    expect(longA.slice(0, 64)).toBe(longB.slice(0, 64));
    const longMsgA: Message = { role: "assistant", content: longA, timestamp: ts };
    const longMsgB: Message = { role: "assistant", content: longB, timestamp: ts };
    expect(hashOf(tracker, longMsgA)).not.toBe(hashOf(tracker, longMsgB));
    expect(hashOf(tracker, longMsgA)).toBe(hashOf(tracker, { ...longMsgA }));

    // Very long content works and stays deterministic
    const huge = "y".repeat(100_000);
    const hugeMsg: Message = { role: "user", content: huge, timestamp: ts };
    const h1 = hashOf(tracker, hugeMsg);
    expect(h1).toBe(hashOf(tracker, { ...hugeMsg }));
    expect(h1).toContain(`user:${huge.length}:${ts}`);

    // Array-of-parts content (text + image placeholders)
    const partsA: Message = {
      role: "user",
      content: [
        { type: "text", text: "look at this" },
        { type: "image", image: "base64data", mimeType: "image/png" },
      ],
      timestamp: ts,
    };
    expect(hashOf(tracker, partsA)).toBe(hashOf(tracker, JSON.parse(JSON.stringify(partsA))));

    const textOnly: Message = { role: "user", content: "look at this [image]", timestamp: ts };
    expect(hashOf(tracker, partsA)).toBe(hashOf(tracker, textOnly));
  });

  it("/resume suggestions return cached result instantly on repeat queries and debounce refreshes", async () => {
    vi.useFakeTimers();
    try {
      const sessions = (n: number) =>
        Array.from({ length: n }, (_, i) => ({
          id: `sess_${i}`,
          filePath: `/tmp/sess_${i}.json`,
          displayName: `Session ${i}`,
          messageCount: i,
          lastModified: new Date(1700000000000 + i),
          preview: `p${i}`,
        }));

      mockListHistorySessions.mockClear();
      mockListHistorySessions.mockImplementation(() => sessions(2));

      // Cold call computes synchronously once
      const first = getDashboardSuggestions("/resume 1");
      expect(mockListHistorySessions).toHaveBeenCalledTimes(1);
      expect(mockListHistorySessions).toHaveBeenLastCalledWith(
        expect.any(Boolean), false, undefined, 20, undefined, undefined, 100
      );
      expect(first).toContain("/resume 1");
      expect(first).not.toContain("/resume 2");

      // Repeated identical queries are served from cache with zero scans
      const second = getDashboardSuggestions("/resume 1");
      expect(second).toEqual(first);
      expect(mockListHistorySessions).toHaveBeenCalledTimes(1);

      // After TTL expiry the stale cached list is still returned instantly,
      // and a single trailing-debounced refresh coalesces rapid keystrokes.
      vi.advanceTimersByTime(6000);
      const third = getDashboardSuggestions("/resume 1");
      expect(third).toEqual(first);
      expect(mockListHistorySessions).toHaveBeenCalledTimes(1);

      getDashboardSuggestions("/resume 1");
      getDashboardSuggestions("/resume 1");
      vi.advanceTimersByTime(100);
      expect(mockListHistorySessions).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(50);
      expect(mockListHistorySessions).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("saveSessionToDb appends incrementally and round-trips messages unchanged", () => {
    const sid = "perf-append-sess";
    const mk = (i: number, role: string, content: string): historyDbModule.MessageRecord => ({
      sessionId: sid,
      role,
      content,
      timestamp: 1700000000000 + i,
    });
    const sessionRecord = {
      id: sid,
      filePath: path.join(tmpDir, `${sid}.json`),
      displayName: "Append Test",
      messageCount: 0,
      lastModified: Date.now(),
      preview: "append test",
    };

    historyDbModule.saveSessionToDb(sessionRecord, [mk(0, "user", "one"), mk(1, "assistant", "two")]);
    expect(historyDbModule.loadSessionFromDb(sid).messages.map(m => m.content)).toEqual(["one", "two"]);

    // Append one more row — incremental path must keep existing rows intact
    historyDbModule.saveSessionToDb(sessionRecord, [
      mk(0, "user", "one"),
      mk(1, "assistant", "two"),
      mk(2, "user", "three"),
    ]);
    expect(historyDbModule.loadSessionFromDb(sid).messages.map(m => m.content)).toEqual(["one", "two", "three"]);

    // Idempotent re-save must not duplicate rows
    historyDbModule.saveSessionToDb(sessionRecord, [
      mk(0, "user", "one"),
      mk(1, "assistant", "two"),
      mk(2, "user", "three"),
    ]);
    expect(historyDbModule.loadSessionFromDb(sid).messages).toHaveLength(3);

    // Truncation/compaction falls back to full rewrite
    historyDbModule.saveSessionToDb(sessionRecord, [mk(0, "user", "compacted")]);
    expect(historyDbModule.loadSessionFromDb(sid).messages.map(m => m.content)).toEqual(["compacted"]);
  });
});

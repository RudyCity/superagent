import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DelegateHistoryIndex } from "../src/core/delegate/historyIndex.js";

const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

describe("DelegateHistoryIndex", () => {
  it("upserts chats incrementally and searches message content", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-index-"));
    created.push(dir);
    const index = new DelegateHistoryIndex(path.join(dir, "history.sqlite"));
    try {
      const first = index.upsertChat("profile-test-001", {
        chat_id: "chat-history-001",
        title: "History Alpha",
        url: "https://chatgpt.com/c/chat-history-001",
        messages: [
          { index: 0, role: "user", text: "hello world" },
          { index: 1, role: "assistant", text: "unique delegate needle here" },
        ],
      }, 1000);
      expect(first.changed).toBe(true);

      const second = index.upsertChat("profile-test-001", {
        chat_id: "chat-history-001",
        title: "History Alpha",
        url: "https://chatgpt.com/c/chat-history-001",
        messages: [
          { index: 0, role: "user", text: "hello world" },
          { index: 1, role: "assistant", text: "unique delegate needle here" },
        ],
      }, 2000);
      expect(second.changed).toBe(false);

      const result = index.search("profile-test-001", "delegate needle", 10);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        chat_id: "chat-history-001",
        role: "assistant",
        message_index: 1,
        title_match: false,
      });
      expect(result[0].snippet).toContain("delegate needle");
      expect(index.stats("profile-test-001")).toMatchObject({
        profiles: 1,
        chats: 1,
        messages: 2,
        lastIndexedAt: 2000,
      });
    } finally {
      index.close();
    }
  });

  it("replaces message rows when content changes and isolates profiles", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-index-"));
    created.push(dir);
    const index = new DelegateHistoryIndex(path.join(dir, "history.sqlite"));
    try {
      index.upsertChat("profile-test-001", {
        chat_id: "chat-history-001", title: "One", url: "https://chatgpt.com/c/chat-history-001",
        messages: [{ index: 0, role: "user", text: "old content" }],
      }, 1000);
      const update = index.upsertChat("profile-test-001", {
        chat_id: "chat-history-001", title: "One", url: "https://chatgpt.com/c/chat-history-001",
        messages: [{ index: 0, role: "user", text: "new content" }],
      }, 2000);
      index.upsertChat("profile-test-002", {
        chat_id: "chat-history-001", title: "Other profile", url: "https://chatgpt.com/c/chat-history-001",
        messages: [{ index: 0, role: "user", text: "other profile secret" }],
      }, 3000);
      expect(update.changed).toBe(true);
      expect(index.search("profile-test-001", "old content", 10)).toEqual([]);
      expect(index.search("profile-test-001", "new content", 10)).toHaveLength(1);
      expect(index.search("profile-test-001", "other profile secret", 10)).toEqual([]);
      expect(index.stats()).toMatchObject({ profiles: 2, chats: 2, messages: 2 });
    } finally {
      index.close();
    }
  });
});

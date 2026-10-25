import { afterAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";

vi.mock("../src/core/storage/historyDb.js", () => ({
  getHistoryDb: () => (globalThis as any).__chatRuntimePersistenceDatabase,
}));
const ledger = await import("../src/core/utils/chatRuntimeLedger.js");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "superagent-chat-persistence-"));
const filename = path.join(directory, "turns.sqlite");
let database: Database | null = new Database(filename);
(globalThis as any).__chatRuntimePersistenceDatabase = database;
afterAll(async () => {
  try { database?.close(); } catch {}
  delete (globalThis as any).__chatRuntimePersistenceDatabase;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
      return;
    } catch (error: any) {
      if (!["EBUSY", "EPERM", "ENOTEMPTY"].includes(error?.code)) throw error;
      // SQLite/WAL file handles can be released a tick later on Windows.
      await new Promise(resolve => setTimeout(resolve, 50 + attempt * 30));
    }
  }
  // Temp DB stays in OS temp if Windows still has a handle; it is not user data.
});

describe("SQLite chat state survives database reopen", () => {
  it("retains queued turn and event journal and recovers safely", () => {
    const first = { turnId: "durable-running", sessionId: "durable-session",
      workspace: "D:/workspace", clientMode: "chrome-extension", message: "first" };
    ledger.acceptChatTurn(first);
    ledger.changeChatTurnState(first.turnId, "running");
    ledger.acceptChatTurn({ ...first, turnId: "durable-queued", message: "second" });
    const journalId = ledger.appendChatEvent(first.sessionId, '{"type":"chat_turn_status","state":"running"}');
    expect(journalId).toBeTypeOf("number");

    database?.close();
    database = new Database(filename);
    (globalThis as any).__chatRuntimePersistenceDatabase = database;
    expect(ledger.getChatTurn(first.turnId)?.state).toBe("running");
    expect(ledger.recoverInterruptedChatTurns()).toBeGreaterThanOrEqual(1);
    expect(ledger.getChatTurn(first.turnId)?.state).toBe("interrupted");
    expect(ledger.getChatTurn("durable-queued")?.state).toBe("recoverable");
    expect(ledger.replayChatEvents(first.sessionId, "0").events).toHaveLength(1);
    expect(ledger.resumeRecoverableChatTurns(first.sessionId)).toBe(1);
    expect(ledger.getChatTurn("durable-queued")?.state).toBe("queued");
  });
});

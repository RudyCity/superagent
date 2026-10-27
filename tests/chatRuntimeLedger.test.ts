import { describe, expect, it, vi } from "vitest";

vi.mock("../src/core/storage/historyDb.js", async () => {
  const { Database } = await import("bun:sqlite");
  const database = new Database(":memory:");
  return { getHistoryDb: () => database };
});
const ledger = await import("../src/core/utils/chatRuntimeLedger.js");

const processor = await import("../src/core/utils/chatRuntimeProcessor.js");

describe("durable chat turns: SQLite ledger", () => {
  it("processes a session's turn to completion and emits an owned final status", async () => {
    const emitted: any[] = [];
    const session: any = {
      sessionId: "worker-chat", workspace: "/tmp/worker",
      agent: {
        lastTaskOutcome: null, isAgentRunning: () => false,
        async sendMessage(_prompt: string) {
          session.agent.lastTaskOutcome = "task_completed";
        },
      },
    };
    ledger.acceptChatTurn({
      turnId: "worker-turn", sessionId: session.sessionId, workspace: session.workspace,
      clientMode: "chrome-extension", message: "run once",
    });
    processor.startSessionTurnWorker(session, event => emitted.push(event));
    await vi.waitFor(() => expect(ledger.getChatTurn("worker-turn")?.state).toBe("completed"));
    expect(emitted.some(event => event.type === "chat_turn_status" &&
      event.sessionId === session.sessionId && event.state === "completed")).toBe(true);
  });
  it("restarts the same session worker after abort without overlapping agents", async () => {
    let releaseFirst!: () => void;
    const firstFinished = new Promise<void>(resolve => { releaseFirst = resolve; });
    let isRunning = false;
    const calls: string[] = [];
    const session: any = {
      sessionId: "abort-restart-chat", workspace: "/tmp/shared",
      agent: {
        lastTaskOutcome: null,
        isAgentRunning: () => isRunning,
        sendMessage: async () => {},
      },
    };
    const executeTurn = async (_session: any, message: unknown) => {
      expect(isRunning).toBe(false);
      isRunning = true;
      calls.push(String(message));
      if (message === "first") await firstFinished;
      session.agent.lastTaskOutcome = "task_completed";
      isRunning = false;
    };
    const emitEvent = vi.fn();
    ledger.acceptChatTurn({ turnId: "restart-first", sessionId: session.sessionId,
      workspace: session.workspace, clientMode: "chrome-extension", message: "first" });
    processor.startSessionTurnWorker(session, emitEvent, executeTurn);
    await vi.waitFor(() => expect(calls).toEqual(["first"]));
    processor.stopSessionTurnWorker(session);
    ledger.cancelChatSessionTurns(session.sessionId);
    ledger.acceptChatTurn({ turnId: "restart-second", sessionId: session.sessionId,
      workspace: session.workspace, clientMode: "chrome-extension", message: "second" });
    processor.startSessionTurnWorker(session, emitEvent, executeTurn);
    releaseFirst();
    await vi.waitFor(() => expect(ledger.getChatTurn("restart-second")?.state).toBe("completed"));
    expect(ledger.getChatTurn("restart-first")?.state).toBe("cancelled");
    expect(calls).toEqual(["first", "second"]);
  });

  it("treats incomplete agent turns as interrupted rather than successful", async () => {
    const session: any = {
      sessionId: "incomplete-chat", workspace: "/tmp/shared",
      agent: {
        lastTaskOutcome: null, isAgentRunning: () => false,
        async sendMessage() { session.agent.lastTaskOutcome = "task_incomplete"; },
      },
    };
    ledger.acceptChatTurn({ turnId: "incomplete-turn", sessionId: session.sessionId,
      workspace: session.workspace, clientMode: "chrome-extension", message: "incomplete" });
    processor.startSessionTurnWorker(session, vi.fn());
    await vi.waitFor(() =>
      expect(ledger.getChatTurn("incomplete-turn")?.state).toBe("interrupted"));
  });

  it("fails closed on null or unknown agent task outcome", async () => {
    const emitted: any[] = [];
    const session: any = {
      sessionId: "failclosed-chat", workspace: "/tmp/failclosed",
      agent: {
        lastTaskOutcome: null, isAgentRunning: () => false,
        async sendMessage() {
          // Leaves lastTaskOutcome as null or sets unknown string
          session.agent.lastTaskOutcome = null;
        },
      },
    };
    ledger.acceptChatTurn({ turnId: "null-outcome-turn", sessionId: session.sessionId,
      workspace: session.workspace, clientMode: "chrome-extension", message: "null outcome" });
    processor.startSessionTurnWorker(session, event => emitted.push(event));
    await vi.waitFor(() =>
      expect(ledger.getChatTurn("null-outcome-turn")?.state).toBe("failed"));
    const turn = ledger.getChatTurn("null-outcome-turn");
    expect(turn?.state).toBe("failed");
    expect(turn?.error).toContain("unexpected/null outcome");
    const terminalEmits = emitted.filter(e => e.type === "chat_turn_status" && e.turnId === "null-outcome-turn" && ["completed", "failed", "cancelled", "interrupted"].includes(e.state));
    expect(terminalEmits).toHaveLength(1);
    expect(terminalEmits[0].state).toBe("failed");
  });

  it("handles aborted task outcome as cancelled", async () => {
    const emitted: any[] = [];
    const session: any = {
      sessionId: "aborted-chat", workspace: "/tmp/aborted",
      agent: {
        lastTaskOutcome: null, isAgentRunning: () => false,
        async sendMessage() {
          session.agent.lastTaskOutcome = "task_aborted";
        },
      },
    };
    ledger.acceptChatTurn({ turnId: "aborted-outcome-turn", sessionId: session.sessionId,
      workspace: session.workspace, clientMode: "chrome-extension", message: "aborted outcome" });
    processor.startSessionTurnWorker(session, event => emitted.push(event));
    await vi.waitFor(() =>
      expect(ledger.getChatTurn("aborted-outcome-turn")?.state).toBe("cancelled"));
    const terminalEmits = emitted.filter(e => e.type === "chat_turn_status" && e.turnId === "aborted-outcome-turn" && ["completed", "failed", "cancelled", "interrupted"].includes(e.state));
    expect(terminalEmits).toHaveLength(1);
    expect(terminalEmits[0].state).toBe("cancelled");
  });

  it("handles failed task outcome as failed with single terminal emission", async () => {
    const emitted: any[] = [];
    const session: any = {
      sessionId: "failed-chat", workspace: "/tmp/failed",
      agent: {
        lastTaskOutcome: null, isAgentRunning: () => false,
        async sendMessage() {
          session.agent.lastTaskOutcome = "task_failed";
        },
      },
    };
    ledger.acceptChatTurn({ turnId: "failed-outcome-turn", sessionId: session.sessionId,
      workspace: session.workspace, clientMode: "chrome-extension", message: "failed outcome" });
    processor.startSessionTurnWorker(session, event => emitted.push(event));
    await vi.waitFor(() =>
      expect(ledger.getChatTurn("failed-outcome-turn")?.state).toBe("failed"));
    const terminalEmits = emitted.filter(e => e.type === "chat_turn_status" && e.turnId === "failed-outcome-turn" && ["completed", "failed", "cancelled", "interrupted"].includes(e.state));
    expect(terminalEmits).toHaveLength(1);
  });

  it("accepts a turn atomically and deduplicates across callers", () => {
    const args = { turnId: "turn-uuid-a", sessionId: "chat-a", workspace: "D:/projects/a",
      clientMode: "chrome-extension", message: "create a report" };
    const first = ledger.acceptChatTurn(args);
    expect(first.duplicate).toBe(false);
    expect(first.turn.state).toBe("accepted");
    const again = ledger.acceptChatTurn(args);
    expect(again.duplicate).toBe(true);
    expect(again.turn.turnId).toBe(args.turnId);
    expect(() => ledger.acceptChatTurn({ ...args, message: "delete everything" })).toThrow(/conflict/);
    expect(() => ledger.acceptChatTurn({ ...args, sessionId: "chat-b" })).toThrow(/conflict/);
    expect(ledger.getChatTurn(args.turnId)?.message).toBe(args.message);
  });
  it("moves turns through running/finished and never overwrites terminal states", () => {
    ledger.acceptChatTurn({ turnId: "turn-b", sessionId: "chat-a", workspace: "D:/projects/a",
      clientMode: "chrome-extension", message: "two" });
    expect(ledger.changeChatTurnState("turn-b", "running")).toBe(true);
    expect(ledger.changeChatTurnState("turn-b", "completed")).toBe(true);
    expect(ledger.changeChatTurnState("turn-b", "failed")).toBe(false);
    expect(ledger.getChatTurn("turn-b")?.state).toBe("completed");
  });
  it("marks uncertain work interrupted, keeps unstarted queued work for explicit recovery", () => {
    ledger.acceptChatTurn({ turnId: "turn-running", sessionId: "chat-c", workspace: "/tmp/c",
      clientMode: "chrome-extension", message: "first" });
    ledger.changeChatTurnState("turn-running", "running");
    ledger.acceptChatTurn({ turnId: "turn-queued", sessionId: "chat-c", workspace: "/tmp/c",
      clientMode: "chrome-extension", message: "second" });
    ledger.recoverInterruptedChatTurns();
    expect(ledger.getChatTurn("turn-running")?.state).toBe("interrupted");
    expect(ledger.getChatTurn("turn-queued")?.state).toBe("recoverable");
    expect(ledger.resumeRecoverableChatTurns("chat-c")).toBe(1);
    expect(ledger.getChatTurn("turn-queued")?.state).toBe("queued");
    expect(ledger.cancelChatSessionTurns("chat-c")).toBe(1);
  });
  it("persists journal IDs and scopes replay to the exact session", () => {
    const a = ledger.appendChatEvent("chat-a", '{"type":"text","text":"alpha"}')!;
    ledger.appendChatEvent("chat-b", '{"type":"text","text":"secret"}');
    const c = ledger.appendChatEvent("chat-a", '{"type":"done"}')!;
    expect(c).toBeGreaterThan(a);
    const replay = ledger.replayChatEvents("chat-a", String(a));
    expect(replay.events).toHaveLength(1);
    expect(replay.events[0]).toContain("done");
    expect(replay.events[0]).not.toContain("secret");
    expect(ledger.replayChatEvents("chat-b", String(a)).events[0]).toContain("secret");
  });
});

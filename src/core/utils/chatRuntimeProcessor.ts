import { changeChatTurnState, listChatTurns, type ChatTurn } from "./chatRuntimeLedger.js";

export interface SessionTurnRuntime {
  sessionId: string;
  workspace: string;
  agent: {
    isAgentRunning(): boolean;
    sendMessage(message: any): Promise<void>;
    lastTaskOutcome?: "task_completed" | "task_incomplete" | "task_failed" | "task_aborted" | null;
  };
}
type EventEmitter = (event: Record<string, unknown>) => void;
const processors = new WeakMap<SessionTurnRuntime, { generation: number; promise: Promise<void> }>();
const generations = new WeakMap<SessionTurnRuntime, number>();

function emit(emitEvent: EventEmitter, session: SessionTurnRuntime, turn: ChatTurn, state: string) {
  emitEvent({
    type: "chat_turn_status", sessionId: session.sessionId, workspace: session.workspace,
    turnId: turn.turnId, state,
  });
}
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Dedicated per-session queue; never start a second agent loop while one is busy. */
export function startSessionTurnWorker(
  session: SessionTurnRuntime, emitEvent: EventEmitter,
  executeTurn: (session: SessionTurnRuntime, message: unknown) => Promise<void> =
    (current, message) => current.agent.sendMessage(message),
): void {
  // Keep a single processor alive even if an abort invalidates its generation.
  // The processor's finally callback restarts accepted turns *after* settling.
  if (processors.has(session)) return;
  const generation = generations.get(session) || 0;
  generations.set(session, generation);
  const promise = (async () => {
    while (generations.get(session) === generation) {
      const next = listChatTurns(session.sessionId, 128)
        .filter(turn => turn.state === "accepted" || turn.state === "queued")
        .sort((a,b) => a.createdAt - b.createdAt)[0];
      if (!next) break;
      // Other channels may own this agent; wait without adding our turn to their internal queue.
      let idleWait = 0;
      while (session.agent.isAgentRunning() && generations.get(session) === generation) {
        await pause(100);
        if (++idleWait > 36_000) { // 60 minutes max; report, never silently discard.
          if (changeChatTurnState(next.turnId, "interrupted", "Timed out waiting for the session agent")) {
            emit(emitEvent, session, next, "interrupted");
          }
          break;
        }
      }
      if (generations.get(session) !== generation) break;
      if (session.agent.isAgentRunning()) continue;
      if (!changeChatTurnState(next.turnId, "running")) continue;
      emit(emitEvent, session, next, "running");
      session.agent.lastTaskOutcome = null;
      try {
        await executeTurn(session, next.message);
        const outcome = session.agent.lastTaskOutcome;
        const state = outcome === "task_completed" ? "completed" :
          outcome === "task_aborted" ? "cancelled" :
          outcome === "task_incomplete" ? "interrupted" : "failed";
        const failureReason = outcome === "task_failed"
          ? "Agent execution reported failure"
          : outcome !== "task_completed" && outcome !== "task_aborted" && outcome !== "task_incomplete"
            ? `Agent ended with unexpected/null outcome: ${String(outcome)}`
            : undefined;
        if (changeChatTurnState(next.turnId, state, failureReason)) {
          if (state === "failed") {
            emitEvent({
              type: "error", sessionId: session.sessionId, workspace: session.workspace,
              turnId: next.turnId, message: failureReason || "Chat turn failed",
            });
          }
          emit(emitEvent, session, next, state);
        }
      } catch (error: any) {
        if (changeChatTurnState(next.turnId, "failed", String(error?.message || error))) {
          emitEvent({
            type: "error", sessionId: session.sessionId, workspace: session.workspace,
            turnId: next.turnId, message: "Chat turn failed: " + String(error?.message || error),
          });
          emit(emitEvent, session, next, "failed");
        }
      }
    }
  })();
  processors.set(session, { generation, promise });
  void promise.catch((error) => {
    console.error("[chat-turn-worker] Unexpected failure:", String(error?.message || error));
  }).finally(() => {
    if (processors.get(session)?.promise === promise) processors.delete(session);
    // New accepts arriving in the final microtask are enqueued after the current loop.
    try {
      if (listChatTurns(session.sessionId, 128).some(t => t.state === "accepted" || t.state === "queued")) {
        startSessionTurnWorker(session, emitEvent, executeTurn);
      }
    } catch (error) {
      // During shutdown the history SQLite handle may already be closed.
      console.warn("[chat-turn-worker] Post-turn queue inspection unavailable");
    }
  });
}
/** Disable queued dispatch immediately; the caller separately aborts this agent. */
export function stopSessionTurnWorker(session: SessionTurnRuntime) {
  generations.set(session, (generations.get(session) || 0) + 1);
}

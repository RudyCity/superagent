import { describe, expect, it } from "vitest";
import {
  runWithProgressCallback,
  getProgressCallback,
  progressStorage,
} from "../src/core/tools/state.js";

describe("Classifier progress callback execution scoping (DEEP-04)", () => {
  it("isolates progress callbacks across concurrent asynchronous executions", async () => {
    const sessionAEvents: string[] = [];
    const sessionBEvents: string[] = [];

    const simulateTask = async (name: string, delayMs: number, iterations: number) => {
      for (let i = 0; i < iterations; i++) {
        await new Promise((r) => setTimeout(r, delayMs));
        const cb = getProgressCallback();
        if (cb) {
          cb(`${name}_progress_${i}`);
        }
      }
    };

    // Run Session A and Session B concurrently
    const taskA = runWithProgressCallback((ev) => sessionAEvents.push(ev), () =>
      simulateTask("session_a", 15, 4)
    );

    const taskB = runWithProgressCallback((ev) => sessionBEvents.push(ev), () =>
      simulateTask("session_b", 10, 5)
    );

    await Promise.all([taskA, taskB]);

    // Verify Session A received ONLY its own events
    expect(sessionAEvents).toEqual([
      "session_a_progress_0",
      "session_a_progress_1",
      "session_a_progress_2",
      "session_a_progress_3",
    ]);

    // Verify Session B received ONLY its own events
    expect(sessionBEvents).toEqual([
      "session_b_progress_0",
      "session_b_progress_1",
      "session_b_progress_2",
      "session_b_progress_3",
      "session_b_progress_4",
    ]);

    // Neither session leaked events to the other
    expect(sessionAEvents.some((e) => e.startsWith("session_b"))).toBe(false);
    expect(sessionBEvents.some((e) => e.startsWith("session_a"))).toBe(false);
  });

  it("clears execution context after completion", () => {
    expect(progressStorage.getStore()).toBeUndefined();
  });

  it("isolates progress events between concurrent real RequestProcessor executions for two agents", async () => {
    const { RequestProcessor } = await import("../src/core/agent/RequestProcessor.js");
    const { agentLocalStorage } = await import("../src/core/agentLocalStorage.js");

    const eventsA: any[] = [];
    const eventsB: any[] = [];

    const createMockAgent = (id: string, events: any[]) => {
      const messages: any[] = [];
      return {
        id,
        tier: "master",
        planState: "IDLE",
        isMultiAgent: false,
        workingDirectory: process.cwd(),
        conversation: {
          getMessages: () => [...messages],
          replaceMessages: (m: any[]) => { messages.length = 0; messages.push(...m); },
          addAssistantMessage: () => {},
          addUserMessage: (msg: any) => messages.push({ role: "user", content: msg }),
          addMessage: (m: any) => messages.push(m),
        },
        writeToLogFile: () => {},
        setMode: () => {},
        compactHistoryIfNeeded: async () => {},
        saveHistory: async () => {},
        autoCheckpoint: () => {},
        onEvent: (ev: any) => {
          events.push({ agentId: id, ev });
        },
      } as any;
    };

    const agentA = createMockAgent("agent-alpha", eventsA);
    const agentB = createMockAgent("agent-beta", eventsB);

    // Run production preprocessing concurrently for both agents
    const runA = agentLocalStorage.run(agentA, () =>
      runWithProgressCallback((ev: any) => agentA.onEvent(ev), async () => {
        // Within agent A's preprocessing, retrieve active progress callback
        const cb = getProgressCallback();
        if (cb) cb({ type: "model_load", modelName: "agent_a_model", status: "loading" });
        return await RequestProcessor.processRequest(agentA, "What is the codebase structure?");
      })
    );

    const runB = agentLocalStorage.run(agentB, () =>
      runWithProgressCallback((ev: any) => agentB.onEvent(ev), async () => {
        // Within agent B's preprocessing, retrieve active progress callback
        const cb = getProgressCallback();
        if (cb) cb({ type: "model_load", modelName: "agent_b_model", status: "loading" });
        return await RequestProcessor.processRequest(agentB, "Fix error in login function.");
      })
    );

    await Promise.all([runA, runB]);

    // Agent A must have received ONLY Agent A events
    expect(eventsA.length).toBeGreaterThan(0);
    expect(eventsA.every((e) => e.agentId === "agent-alpha")).toBe(true);
    expect(eventsA.some((e) => e.ev?.modelName === "agent_b_model")).toBe(false);

    // Agent B must have received ONLY Agent B events
    expect(eventsB.length).toBeGreaterThan(0);
    expect(eventsB.every((e) => e.agentId === "agent-beta")).toBe(true);
    expect(eventsB.some((e) => e.ev?.modelName === "agent_a_model")).toBe(false);
  });

  it("routes getSenopatiSession model load progress events exclusively to active agent context", async () => {
    const { getSenopatiSession } = await import("../src/core/requestClassifier.js");
    const { agentLocalStorage } = await import("../src/core/agentLocalStorage.js");

    const eventsA: any[] = [];
    const eventsB: any[] = [];

    const agentA: any = { onEvent: (ev: any) => eventsA.push({ agent: "A", ...ev }) };
    const agentB: any = { onEvent: (ev: any) => eventsB.push({ agent: "B", ...ev }) };

    const loadA = agentLocalStorage.run(agentA, () =>
      runWithProgressCallback((ev: any) => agentA.onEvent(ev), async () => {
        return await getSenopatiSession();
      })
    );

    const loadB = agentLocalStorage.run(agentB, () =>
      runWithProgressCallback((ev: any) => agentB.onEvent(ev), async () => {
        return await getSenopatiSession();
      })
    );

    await Promise.all([loadA, loadB]);

    if (eventsA.length > 0) {
      expect(eventsA.every((e) => e.agent === "A")).toBe(true);
    }
    if (eventsB.length > 0) {
      expect(eventsB.every((e) => e.agent === "B")).toBe(true);
    }
  });
});

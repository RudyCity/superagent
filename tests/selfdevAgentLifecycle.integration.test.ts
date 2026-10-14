import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const tempHome = path.join(os.tmpdir(), `superagent-selfdev-lifecycle-${process.pid}`);
vi.spyOn(os, "homedir").mockReturnValue(tempHome);

import { Agent } from "../src/core/agent.js";
import { getSelfDevConfig, updateSelfDevConfig } from "../src/core/selfdev/settings.js";
import { resetSelfDevCollector, resetSelfDevRuntimeMetrics, getSelfDevRuntimeMetrics } from "../src/core/selfdev/selfdevAgent.js";
import { SelfDevEventStore } from "../src/core/selfdev/eventStore.js";
import { getHistoryDb } from "../src/core/storage/historyDb.js";
import * as selfDevAgentModule from "../src/core/selfdev/selfdevAgent.js";

function makeAgent(workspace: string, sessionId: string): Agent {
  fs.mkdirSync(workspace, { recursive: true });
  const agent = new Agent(vi.fn(), vi.fn(async () => true), vi.fn(async () => "continue"), undefined, undefined, workspace);
  agent.tier = "subagent";
  agent.sessionId = sessionId;
  vi.spyOn(agent, "saveHistory").mockResolvedValue();
  vi.spyOn(agent as any, "compactHistoryIfNeeded").mockResolvedValue();
  vi.spyOn(agent as any, "autoCheckpoint").mockImplementation(() => undefined);
  vi.spyOn(agent, "writeToLogFile").mockImplementation(() => undefined);
  vi.spyOn(agent as any, "updateRootProcessActivity").mockImplementation(() => undefined);
  return agent;
}

function readEvents(workspace: string) {
  return new SelfDevEventStore({
    workspace,
    getDb: () => getHistoryDb() as any,
    config: getSelfDevConfig(),
  }).list({ limit: 50 }).sort((a, b) => a.ts - b.ts);
}

async function waitForWorkspaceEvents(workspace: string, expectedCount: number) {
  await vi.waitFor(() => {
    expect(readEvents(workspace)).toHaveLength(expectedCount);
  }, { timeout: 3000, interval: 10 });
  return readEvents(workspace);
}

async function waitForDistillationToObserveSmallEventWindow(): Promise<void> {
  await vi.waitFor(() => {
    expect(getSelfDevRuntimeMetrics().distillationBelowThreshold).toBeGreaterThan(0);
  }, { timeout: 3000, interval: 10 });
}

describe("Agent Selfdev lifecycle integration", () => {
  beforeEach(() => {
    fs.mkdirSync(tempHome, { recursive: true });
    resetSelfDevCollector();
    resetSelfDevRuntimeMetrics();
    updateSelfDevConfig({
      enabled: true,
      collectionEnabled: true,
      injectionEnabled: true,
      storePath: path.join(tempHome, "selfdev-lessons.json"),
    });
  });

  afterEach(() => {
    resetSelfDevCollector();
    resetSelfDevRuntimeMetrics();
    vi.restoreAllMocks();
    vi.spyOn(os, "homedir").mockReturnValue(tempHome);
    // The shared SQLite connection remains open for this worker on Windows;
    // keep the OS-temporary home until the worker exits rather than deleting an open DB.
  });

  it("persists task_started before task_completed in the detached sidecar", async () => {
    const workspace = path.join(tempHome, `workspace-success-${randomUUID()}`);
    const sessionId = `session-success-${randomUUID()}`;
    const agent = makeAgent(workspace, sessionId);
    vi.spyOn(agent as any, "runAgentLoop").mockResolvedValue(undefined);

    await agent.sendMessage("complete this lifecycle test");
    const events = await waitForWorkspaceEvents(workspace, 2);

    expect(events.map(event => event.kind)).toEqual(["task_started", "task_completed"]);
    expect(events.every(event => event.workspace === workspace)).toBe(true);
    expect(events.every(event => event.sessionId === events[0].sessionId && event.sessionId.length > 0)).toBe(true);
    await waitForDistillationToObserveSmallEventWindow();
  });

  it("does not await a slow Selfdev store write before resolving the main task", async () => {
    const workspace = path.join(tempHome, `workspace-slow-storage-${randomUUID()}`);
    const agent = makeAgent(workspace, `session-slow-storage-${randomUUID()}`);
    vi.spyOn(agent as any, "runAgentLoop").mockResolvedValue(undefined);
    let resolveWrite!: (recorded: boolean) => void;
    let writeResolved = false;
    const slowWrite = new Promise<boolean>(resolve => {
      resolveWrite = resolve;
    });
    const writeSpy = vi.spyOn(selfDevAgentModule, "recordSelfDevEvent").mockImplementation(() => {
      return slowWrite.then(value => {
        writeResolved = true;
        return value;
      });
    });

    await agent.sendMessage("Selfdev storage is deliberately delayed");
    await vi.waitFor(() => expect(writeSpy).toHaveBeenCalledTimes(1), { timeout: 3000, interval: 10 });
    expect(writeResolved).toBe(false);

    resolveWrite(true);
    await vi.waitFor(() => expect(writeSpy).toHaveBeenCalledTimes(2), { timeout: 3000, interval: 10 });
  });

  it("records task_failed instead of a false successful completion when the agent loop throws", async () => {
    const workspace = path.join(tempHome, `workspace-failed-${randomUUID()}`);
    const sessionId = `session-failed-${randomUUID()}`;
    const agent = makeAgent(workspace, sessionId);
    vi.spyOn(agent as any, "runAgentLoop").mockRejectedValue(new Error("synthetic test failure"));

    await agent.sendMessage("fail this lifecycle test");
    const events = await waitForWorkspaceEvents(workspace, 2);

    expect(events.map(event => event.kind)).toEqual(["task_started", "task_failed"]);
    expect(events.every(event => event.sessionId === events[0].sessionId && event.sessionId.length > 0)).toBe(true);
    await waitForDistillationToObserveSmallEventWindow();
  });

  it("records task_aborted on interruption and skips automatic distillation", async () => {
    const workspace = path.join(tempHome, `workspace-aborted-${randomUUID()}`);
    const sessionId = `session-aborted-${randomUUID()}`;
    const agent = makeAgent(workspace, sessionId);
    const loop = vi.spyOn(agent as any, "runAgentLoop").mockImplementation(() => new Promise(() => undefined));

    const sendPromise = agent.sendMessage("abort this lifecycle test");
    await vi.waitFor(() => expect(loop).toHaveBeenCalled(), { timeout: 3000, interval: 10 });
    agent.abort();
    await sendPromise;

    const events = await waitForWorkspaceEvents(workspace, 2);
    expect(events.map(event => event.kind)).toEqual(["task_started", "task_aborted"]);
    expect(events.every(event => event.sessionId === events[0].sessionId && event.sessionId.length > 0)).toBe(true);
    expect(getSelfDevRuntimeMetrics().distillationRuns).toBe(0);
  });

  it("does not fail the main Agent task when Selfdev event persistence fails", async () => {
    const workspace = path.join(tempHome, `workspace-storage-failure-${randomUUID()}`);
    const sessionId = `session-storage-failure-${randomUUID()}`;
    const agent = makeAgent(workspace, sessionId);
    const loop = vi.spyOn(agent as any, "runAgentLoop").mockResolvedValue(undefined);
    const db = getHistoryDb() as any;
    const escapedWorkspace = workspace.replace(/'/g, "''");
    const triggerName = `selfdev_fail_lifecycle_${randomUUID().replace(/-/g, "")}`;

    // Initialize the history schema before installing a narrowly scoped failure trigger.
    new SelfDevEventStore({
      workspace,
      getDb: () => db,
      config: getSelfDevConfig(),
    }).record({
      id: `fixture-${randomUUID()}`,
      workspace,
      sessionId: "fixture-session",
      kind: "custom",
      summary: "Synthetic fixture only.",
    });
    resetSelfDevRuntimeMetrics();
    db.exec(`CREATE TRIGGER "${triggerName}" BEFORE INSERT ON selfdev_events
      WHEN NEW.workspace = '${escapedWorkspace}'
      BEGIN SELECT RAISE(ABORT, 'synthetic storage failure'); END;`);

    try {
      await expect(agent.sendMessage("complete despite Selfdev storage failure")).resolves.toBeUndefined();
      expect(loop).toHaveBeenCalledOnce();
      await vi.waitFor(() => {
        expect(getSelfDevRuntimeMetrics().eventRecordSkipped).toBeGreaterThanOrEqual(2);
      }, { timeout: 3000, interval: 10 });
      expect(getSelfDevRuntimeMetrics().distillationRuns).toBe(0);
    } finally {
      db.exec(`DROP TRIGGER IF EXISTS "${triggerName}"`);
    }
  });

  it("keeps parallel multi-agent lifecycle events isolated by workspace and session", async () => {
    const workspaceA = path.join(tempHome, `workspace-agent-a-${randomUUID()}`);
    const workspaceB = path.join(tempHome, `workspace-agent-b-${randomUUID()}`);
    const sessionA = `multi-session-a-${randomUUID()}`;
    const sessionB = `multi-session-b-${randomUUID()}`;
    const agentA = makeAgent(workspaceA, sessionA);
    const agentB = makeAgent(workspaceB, sessionB);
    for (const agent of [agentA, agentB]) {
      agent.isMultiAgent = true;
      vi.spyOn(agent as any, "runAgentLoop").mockResolvedValue(undefined);
    }

    await Promise.all([
      agentA.sendMessage("parallel agent A task"),
      agentB.sendMessage("parallel agent B task"),
    ]);

    const eventsA = await waitForWorkspaceEvents(workspaceA, 2);
    const eventsB = await waitForWorkspaceEvents(workspaceB, 2);
    expect(eventsA.map(event => event.kind)).toEqual(["task_started", "task_completed"]);
    expect(eventsB.map(event => event.kind)).toEqual(["task_started", "task_completed"]);
    expect(eventsA.every(event => event.workspace === workspaceA && event.tags.includes("multi"))).toBe(true);
    expect(eventsB.every(event => event.workspace === workspaceB && event.tags.includes("multi"))).toBe(true);
    expect(eventsA.every(event => event.sessionId === eventsA[0].sessionId && event.sessionId.length > 0)).toBe(true);
    expect(eventsB.every(event => event.sessionId === eventsB[0].sessionId && event.sessionId.length > 0)).toBe(true);
    expect(eventsA[0].sessionId).not.toBe(eventsB[0].sessionId);
    await waitForDistillationToObserveSmallEventWindow();
  });
});

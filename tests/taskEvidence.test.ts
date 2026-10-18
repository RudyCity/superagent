import { describe, expect, it, vi } from "vitest";
import {
  beginAgentTaskEvidence,
  classifyVerificationCommand,
  finishAgentTaskEvidence,
  MAX_TASK_EVIDENCE_REFERENCES,
  queueTaskVerificationEvidence,
} from "../src/core/selfdev/taskEvidence.js";
import type { SelfDevEventInput } from "../src/core/selfdev/types.js";

const context = {
  taskId: "task-123",
  sessionId: "session-abc",
  workspace: "C:/work/project",
};

describe("task evidence lifecycle", () => {
  it.each([
    ["bun x vitest run tests/agent.test.ts", { kind: "test_result", commandFamily: "vitest" }],
    ["bun run build", { kind: "build_result", commandFamily: "build-script" }],
    ["pytest tests", { kind: "test_result", commandFamily: "pytest" }],
    ["cargo build", { kind: "build_result", commandFamily: "cargo" }],
    ["bun run build && bun x vitest run", undefined],
    ["bun x vitest run --help", undefined],
    ["bun test --version", undefined],
    ["echo bun run build", undefined],
    ["git status", undefined],
    ["", undefined],
  ])("classifies only a standalone verification command: %s", (command, expected) => {
    expect(classifyVerificationCommand(command as string)).toEqual(expected);
  });

  it("links only successfully persisted test/build events to the owning task", async () => {
    const agent = {};
    const persisted: SelfDevEventInput[] = [];
    const recorder = vi.fn(async (event: SelfDevEventInput) => {
      persisted.push(event);
      return true;
    });
    beginAgentTaskEvidence(agent, context);

    queueTaskVerificationEvidence(agent, {
      kind: "test_result",
      toolName: "bash",
      commandFamily: "vitest",
      exitCode: 0,
    }, recorder);
    queueTaskVerificationEvidence(agent, {
      kind: "build_result",
      toolName: "run_command",
      commandFamily: "typescript",
      exitCode: 2,
    }, recorder);

    const ids = await finishAgentTaskEvidence(agent);
    expect(ids).toHaveLength(2);
    expect(persisted).toHaveLength(2);
    expect(persisted.map(event => event.id)).toEqual(ids);
    expect(persisted[0]).toMatchObject({
      sessionId: context.sessionId,
      workspace: context.workspace,
      kind: "test_result",
      summary: "Test command passed (vitest)",
      payload: { taskId: context.taskId, commandFamily: "vitest", toolName: "bash", exitCode: 0, passed: true },
    });
    expect(persisted[1]).toMatchObject({
      kind: "build_result",
      payload: { taskId: context.taskId, commandFamily: "typescript", exitCode: 2, success: false },
    });
    expect(JSON.stringify(persisted)).not.toMatch(/password|api.?key|stdout|stderr|raw command/i);
  });

  it("returns no IDs when persistence rejects an evidence write", async () => {
    const agent = {};
    beginAgentTaskEvidence(agent, context);
    queueTaskVerificationEvidence(agent, {
      kind: "test_result",
      toolName: "bash",
      commandFamily: "vitest",
      exitCode: 1,
    }, vi.fn().mockResolvedValue(false));

    await expect(finishAgentTaskEvidence(agent)).resolves.toEqual([]);
  });

  it("isolates tasks on different agents and ignores evidence outside an active task", async () => {
    const agentA = {};
    const agentB = {};
    const recorder = vi.fn().mockResolvedValue(true);
    queueTaskVerificationEvidence(agentA, {
      kind: "test_result", toolName: "bash", commandFamily: "vitest", exitCode: 0,
    }, recorder);
    expect(recorder).not.toHaveBeenCalled();

    beginAgentTaskEvidence(agentA, context);
    beginAgentTaskEvidence(agentB, { ...context, taskId: "task-456", sessionId: "session-def" });
    queueTaskVerificationEvidence(agentA, {
      kind: "test_result", toolName: "bash", commandFamily: "vitest", exitCode: 0,
    }, recorder);
    queueTaskVerificationEvidence(agentB, {
      kind: "test_result", toolName: "bash", commandFamily: "vitest", exitCode: 0,
    }, recorder);

    const [idsA, idsB] = await Promise.all([
      finishAgentTaskEvidence(agentA),
      finishAgentTaskEvidence(agentB),
    ]);
    expect(idsA).toHaveLength(1);
    expect(idsB).toHaveLength(1);
    expect(idsA[0]).not.toBe(idsB[0]);
  });

  it("caps retained evidence IDs per task", async () => {
    const agent = {};
    const recorder = vi.fn().mockResolvedValue(true);
    beginAgentTaskEvidence(agent, context);
    for (let i = 0; i < MAX_TASK_EVIDENCE_REFERENCES + 10; i++) {
      queueTaskVerificationEvidence(agent, {
        kind: "test_result", toolName: "bash", commandFamily: "vitest", exitCode: 0,
      }, recorder);
    }
    const ids = await finishAgentTaskEvidence(agent);
    expect(ids).toHaveLength(MAX_TASK_EVIDENCE_REFERENCES);
    expect(recorder).toHaveBeenCalledTimes(MAX_TASK_EVIDENCE_REFERENCES);
  });
});

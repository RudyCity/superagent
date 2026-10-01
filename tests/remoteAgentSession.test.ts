import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  encodeEnvelope,
  EnvelopeReassembler,
  validateEnvelope,
  SessionResetEnvelope,
  TaskCancelEnvelope,
  TaskRequestEnvelope,
} from "../src/core/remoteAgent/protocol.js";
import {
  saveRemoteAgentConfig,
  loadRemoteAgentConfig,
  RemoteAgentConfig,
} from "../src/core/remoteAgent/config.js";
import {
  notifyMuseSessionReset,
  abortActiveRemoteTask,
  getActiveRemoteTaskId,
  runRemoteTask,
} from "../src/core/remoteAgent/taskRunner.js";
import { MuseClient } from "../src/core/remoteAgent/museClient.js";
import { museCommand } from "../src/core/commands/museCommand.js";
import {
  getDashboardSuggestions,
  getSuggestionDescriptions,
} from "../src/utils/dashboardSuggestions.js";
import type { SlashCommandContext } from "../src/core/commands/types.js";

describe("remoteAgent - Session, Context & Cancellation", () => {
  let originalConfig: RemoteAgentConfig;

  beforeEach(() => {
    originalConfig = loadRemoteAgentConfig();
    saveRemoteAgentConfig({
      botToken: "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11",
      groupId: "-1001234567890",
      museBotId: "987654321",
      defaultWorkspace: "/test/workspace",
    });
  });

  afterEach(async () => {
    await abortActiveRemoteTask("test cleanup");
    saveRemoteAgentConfig(originalConfig);
  });

  it("should validate and encode session_reset envelope", () => {
    const envelope: SessionResetEnvelope = {
      v: 1,
      kind: "session_reset",
      id: "reset_123",
      session: "sess_abc",
      message: "Resetting context for new chat",
    };

    const valResult = validateEnvelope(envelope);
    expect(valResult.valid).toBe(true);

    const encoded = encodeEnvelope(envelope);
    expect(encoded).toHaveLength(1);

    const reassembler = new EnvelopeReassembler();
    const parsed = reassembler.processMessage(encoded[0]);
    expect(parsed).not.toBeNull();
    expect(parsed?.kind).toBe("session_reset");
    expect((parsed as SessionResetEnvelope).session).toBe("sess_abc");
  });

  it("should validate and encode task_cancel envelope", () => {
    const envelope: TaskCancelEnvelope = {
      v: 1,
      kind: "task_cancel",
      id: "cancel_123",
      task_id: "task_abc",
      reason: "User cancelled task",
    };

    const valResult = validateEnvelope(envelope);
    expect(valResult.valid).toBe(true);

    const encoded = encodeEnvelope(envelope);
    expect(encoded).toHaveLength(1);

    const reassembler = new EnvelopeReassembler();
    const parsed = reassembler.processMessage(encoded[0]);
    expect(parsed).not.toBeNull();
    expect(parsed?.kind).toBe("task_cancel");
    expect((parsed as TaskCancelEnvelope).task_id).toBe("task_abc");
  });

  it("should send session_reset envelope via notifyMuseSessionReset", async () => {
    const sendSpy = vi
      .spyOn(MuseClient.prototype, "sendEnvelope")
      .mockResolvedValue(true);

    const result = await notifyMuseSessionReset("sess_custom_456");
    expect(result).toBe(true);
    expect(sendSpy).toHaveBeenCalledTimes(1);

    const sentEnvelope = sendSpy.mock.calls[0][0];
    expect(sentEnvelope.kind).toBe("session_reset");
    expect((sentEnvelope as SessionResetEnvelope).session).toBe("sess_custom_456");

    sendSpy.mockRestore();
  });

  it("should handle /muse new and /muse reset commands cleanly", async () => {
    const sendSpy = vi
      .spyOn(MuseClient.prototype, "sendEnvelope")
      .mockResolvedValue(true);

    const lines: Array<{ type: string; content: string }> = [];
    const fakeCtx: SlashCommandContext = {
      addLine: (line) => lines.push({ type: line.type, content: line.content }),
      exit: () => {},
      agent: {
        sessionId: "sess_active_999",
      } as any,
    };

    await museCommand.execute("new", fakeCtx);
    expect(sendSpy).toHaveBeenCalled();
    const resetCall = sendSpy.mock.calls[0][0] as SessionResetEnvelope;
    expect(resetCall.kind).toBe("session_reset");
    expect(resetCall.session).toBe("sess_active_999");
    expect(lines.some((l) => l.content.includes("Remote session context has been reset"))).toBe(true);

    lines.length = 0;
    await museCommand.execute("reset", fakeCtx);
    expect(lines.some((l) => l.content.includes("Remote session context has been reset"))).toBe(true);

    sendSpy.mockRestore();
  });

  it("should handle /muse stop and /muse cancel commands cleanly", async () => {
    const sendSpy = vi
      .spyOn(MuseClient.prototype, "sendEnvelope")
      .mockResolvedValue(true);

    const lines: Array<{ type: string; content: string }> = [];
    const fakeCtx: SlashCommandContext = {
      addLine: (line) => lines.push({ type: line.type, content: line.content }),
      exit: () => {},
    };

    // When no task is running
    await museCommand.execute("stop", fakeCtx);
    expect(lines.some((l) => l.content.includes("No active remote task"))).toBe(true);

    sendSpy.mockRestore();
  });

  it("should include /muse subcommands in suggestions and descriptions", () => {
    const suggestions = getDashboardSuggestions("/muse ");
    expect(suggestions).toContain("/muse new");
    expect(suggestions).toContain("/muse reset");
    expect(suggestions).toContain("/muse stop");
    expect(suggestions).toContain("/muse cancel");

    const desc = getSuggestionDescriptions();
    expect(desc["/muse new"]).toBeDefined();
    expect(desc["/muse reset"]).toBeDefined();
    expect(desc["/muse stop"]).toBeDefined();
    expect(desc["/muse cancel"]).toBeDefined();
  });

  it("should pass agent session ID and conversation context into TaskRequestEnvelope", async () => {
    let capturedRequest: TaskRequestEnvelope | null = null;
    const sendSpy = vi
      .spyOn(MuseClient.prototype, "sendEnvelope")
      .mockImplementation(async (envelope) => {
        if (envelope.kind === "task_request") {
          capturedRequest = envelope as TaskRequestEnvelope;
        }
        return true;
      });

    const pollSpy = vi
      .spyOn(MuseClient.prototype, "pollEnvelopes")
      .mockImplementation((onEnvelope, signal) => {
        return new Promise<void>((resolve) => {
          setTimeout(async () => {
            if (!signal?.aborted) {
              await onEnvelope({
                v: 1,
                kind: "task_done",
                task_id: capturedRequest?.id || "task_1",
                summary: "Done cleanly",
              });
            }
            resolve();
          }, 10);
        });
      });

    const fakeAgent: any = {
      sessionId: "sess_stable_12345",
      getHistory: () => ({
        getMessages: () => [
          { role: "user", content: "What is 2 + 2?", timestamp: 1 },
          { role: "assistant", content: "2 + 2 is 4.", timestamp: 2 },
          { role: "user", content: "Add 10 more to that.", timestamp: 3 },
        ],
      }),
    };

    const runResult = await runRemoteTask({
      task: "Calculate result",
      agent: fakeAgent,
    });

    expect(runResult.success).toBe(true);
    expect(capturedRequest).not.toBeNull();
    expect(capturedRequest!.session).toBe("sess_stable_12345");
    expect(capturedRequest!.context).toBeDefined();
    expect(capturedRequest!.context).toHaveLength(3);
    expect(capturedRequest!.context![0]).toEqual({
      role: "user",
      content: "What is 2 + 2?",
    });
    expect(capturedRequest!.context![1]).toEqual({
      role: "assistant",
      content: "2 + 2 is 4.",
    });

    sendSpy.mockRestore();
    pollSpy.mockRestore();
  });

  it("should automatically cancel previous task when starting a new remote task", async () => {
    let requestCount = 0;
    const sentKinds: string[] = [];

    const sendSpy = vi
      .spyOn(MuseClient.prototype, "sendEnvelope")
      .mockImplementation(async (envelope) => {
        sentKinds.push(envelope.kind);
        if (envelope.kind === "task_request") {
          requestCount++;
        }
        return true;
      });

    const pollSpy = vi
      .spyOn(MuseClient.prototype, "pollEnvelopes")
      .mockImplementation((onEnvelope, signal) => {
        return new Promise<void>((resolve) => {
          if (requestCount === 1) {
            // Task 1 never resolves until aborted
            signal?.addEventListener("abort", () => resolve());
          } else {
            // Task 2 finishes promptly
            setTimeout(async () => {
              if (!signal?.aborted) {
                await onEnvelope({
                  v: 1,
                  kind: "task_done",
                  task_id: getActiveRemoteTaskId() || "task_second",
                  summary: "Task 2 done",
                });
              }
              resolve();
            }, 10);
          }
        });
      });

    // Start Task 1 in background
    const task1Promise = runRemoteTask({ task: "Task 1" });
    await new Promise((r) => setTimeout(r, 20));

    expect(getActiveRemoteTaskId()).not.toBeNull();

    // Start Task 2: should cancel Task 1
    const task2Result = await runRemoteTask({ task: "Task 2" });
    expect(task2Result.success).toBe(true);

    const task1Result = await task1Promise;
    expect(task1Result.success).toBe(false);
    expect(task1Result.error).toContain("cancelled");
    expect(sentKinds).toContain("task_cancel");

    sendSpy.mockRestore();
    pollSpy.mockRestore();
  });

  it("should include run_command and bash in task_request tools list", async () => {
    let capturedRequest: TaskRequestEnvelope | null = null;

    const sendSpy = vi
      .spyOn(MuseClient.prototype, "sendEnvelope")
      .mockImplementation(async (envelope) => {
        if (envelope.kind === "task_request") {
          capturedRequest = envelope as TaskRequestEnvelope;
        }
        return true;
      });

    const pollSpy = vi
      .spyOn(MuseClient.prototype, "pollEnvelopes")
      .mockImplementation((onEnvelope) => {
        return new Promise<void>((resolve) => {
          setTimeout(async () => {
            await onEnvelope({
              v: 1,
              kind: "task_done",
              task_id: capturedRequest?.id || "task_tools",
              summary: "Done",
            });
            resolve();
          }, 10);
        });
      });

    await runRemoteTask({ task: "Check tools" });

    expect(capturedRequest).not.toBeNull();
    expect(capturedRequest!.tools).toContain("run_command");
    expect(capturedRequest!.tools).toContain("bash");
    expect(capturedRequest!.tools).toContain("read");
    expect(capturedRequest!.tools).toContain("write");

    sendSpy.mockRestore();
    pollSpy.mockRestore();
  });

  it("should inject system_prompt in TaskRequestEnvelope and session_reset envelope", async () => {
    let capturedRequest: TaskRequestEnvelope | null = null;
    let capturedReset: SessionResetEnvelope | null = null;

    const sendSpy = vi
      .spyOn(MuseClient.prototype, "sendEnvelope")
      .mockImplementation(async (envelope) => {
        if (envelope.kind === "task_request") {
          capturedRequest = envelope as TaskRequestEnvelope;
        } else if (envelope.kind === "session_reset") {
          capturedReset = envelope as SessionResetEnvelope;
        }
        return true;
      });

    const pollSpy = vi
      .spyOn(MuseClient.prototype, "pollEnvelopes")
      .mockImplementation((onEnvelope) => {
        return new Promise<void>((resolve) => {
          setTimeout(async () => {
            await onEnvelope({
              v: 1,
              kind: "task_done",
              task_id: capturedRequest?.id || "task_sys",
              summary: "Done",
            });
            resolve();
          }, 10);
        });
      });

    await runRemoteTask({ task: "Run test" });
    await notifyMuseSessionReset("sess_reset_test");

    expect(capturedRequest).not.toBeNull();
    expect(capturedRequest!.system_prompt).toBeDefined();
    expect(capturedRequest!.system_prompt).toContain("You are Muse");
    expect(capturedRequest!.system_prompt).toContain("run_command");

    expect(capturedReset).not.toBeNull();
    expect(capturedReset!.system_prompt).toBeDefined();
    expect(capturedReset!.system_prompt).toContain("You are Muse");

    sendSpy.mockRestore();
    pollSpy.mockRestore();
  });

  it("should prepend system instructions header to task string on initial turn", async () => {
    let capturedRequest: TaskRequestEnvelope | null = null;

    const sendSpy = vi
      .spyOn(MuseClient.prototype, "sendEnvelope")
      .mockImplementation(async (envelope) => {
        if (envelope.kind === "task_request") {
          capturedRequest = envelope as TaskRequestEnvelope;
        }
        return true;
      });

    const pollSpy = vi
      .spyOn(MuseClient.prototype, "pollEnvelopes")
      .mockImplementation((onEnvelope) => {
        return new Promise<void>((resolve) => {
          setTimeout(async () => {
            await onEnvelope({
              v: 1,
              kind: "task_done",
              task_id: capturedRequest?.id || "task_init",
              summary: "Done",
            });
            resolve();
          }, 10);
        });
      });

    // When running with no context (initial turn)
    await runRemoteTask({ task: "Build me a login screen" });

    expect(capturedRequest).not.toBeNull();
    expect(capturedRequest!.task).toContain("[SYSTEM INSTRUCTIONS FOR MUSE REMOTE BRAIN]");
    expect(capturedRequest!.task).toContain("run_command");
    expect(capturedRequest!.task).toContain("Build me a login screen");

    sendSpy.mockRestore();
    pollSpy.mockRestore();
  });

  it("should support /muse config systemPrompt to customize instructions", async () => {
    const lines: Array<{ type: string; content: string }> = [];
    const fakeCtx: SlashCommandContext = {
      addLine: (line) => lines.push({ type: line.type, content: line.content }),
      exit: () => {},
    };

    await museCommand.execute("config systemPrompt Be concise and strict", fakeCtx);
    const updated = loadRemoteAgentConfig();
    expect(updated.systemPrompt).toBe("Be concise and strict");
    expect(lines.some((l) => l.content.includes("systemPrompt = Be concise and strict"))).toBe(true);
  });
});

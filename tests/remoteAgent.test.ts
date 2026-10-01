import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

import {
  loadRemoteAgentConfig,
  saveRemoteAgentConfig,
  updateRemoteAgentConfig,
  maskToken,
  isMuseRunnerActive,
  RemoteAgentConfig,
} from "../src/core/remoteAgent/config.js";
import {
  encodeEnvelope,
  EnvelopeReassembler,
  validateEnvelope,
  TaskRequestEnvelope,
  TaskBatchEnvelope,
  TaskResultEnvelope,
  TaskDoneEnvelope,
  ChatEnvelope,
} from "../src/core/remoteAgent/protocol.js";
import {
  executeBatch,
  truncateOutput,
  MAX_TOOL_OUTPUT_CHARS,
} from "../src/core/remoteAgent/batchExecutor.js";
import { MuseClient } from "../src/core/remoteAgent/museClient.js";
import {
  runRemoteTask,
  MAX_BATCHES_PER_TASK,
} from "../src/core/remoteAgent/taskRunner.js";
import { museCommand } from "../src/core/commands/museCommand.js";
import { registry } from "../src/core/commands/registry.js";
import type { SlashCommandContext, ChatLine } from "../src/core/commands/types.js";

describe("remoteAgent - Config Module", () => {
  const tempConfigPath = path.join(
    os.tmpdir(),
    `remote-agent-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
  );

  afterEach(() => {
    try {
      if (fs.existsSync(tempConfigPath)) {
        fs.unlinkSync(tempConfigPath);
      }
    } catch {}
  });

  it("should return empty default config if file does not exist", () => {
    const cfg = loadRemoteAgentConfig(tempConfigPath);
    expect(cfg).toEqual({});
  });

  it("should save and load config correctly", () => {
    const initial: RemoteAgentConfig = {
      botToken: "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11",
      groupId: "-1001234567890",
      museBotId: "987654321",
      defaultWorkspace: "/test/workspace",
    };
    saveRemoteAgentConfig(initial, tempConfigPath);

    const loaded = loadRemoteAgentConfig(tempConfigPath);
    expect(loaded).toEqual(initial);
  });

  it("should update config incrementally", () => {
    saveRemoteAgentConfig({ botToken: "tokenA", groupId: "111" }, tempConfigPath);
    const updated = updateRemoteAgentConfig(
      { museBotId: "222", defaultWorkspace: "/new/ws" },
      tempConfigPath
    );

    expect(updated.botToken).toBe("tokenA");
    expect(updated.groupId).toBe("111");
    expect(updated.museBotId).toBe("222");
    expect(updated.defaultWorkspace).toBe("/new/ws");
  });

  it("should mask token properly and never expose full token", () => {
    expect(maskToken(undefined)).toBe("(not configured)");
    expect(maskToken("")).toBe("(not configured)");
    expect(maskToken("short")).toBe("********");
    expect(maskToken("12345678")).toBe("********");
    expect(maskToken("123456789:ABCDEF123456")).toBe("1234...3456");
    expect(maskToken("123456789:ABCDEF123456")).not.toContain("ABCDEF");
  });

  it("should correctly check isMuseRunnerActive based on asRunner flag and credentials", () => {
    // Empty config
    saveRemoteAgentConfig({}, tempConfigPath);
    expect(isMuseRunnerActive(tempConfigPath)).toBe(false);

    // asRunner true but credentials missing
    saveRemoteAgentConfig({ asRunner: true }, tempConfigPath);
    expect(isMuseRunnerActive(tempConfigPath)).toBe(false);

    // asRunner true and all credentials present
    saveRemoteAgentConfig(
      {
        asRunner: true,
        botToken: "123456:ABC-DEF",
        groupId: "-100123",
        museBotId: "999",
      },
      tempConfigPath
    );
    expect(isMuseRunnerActive(tempConfigPath)).toBe(true);

    // asRunner false even with credentials
    saveRemoteAgentConfig(
      {
        asRunner: false,
        botToken: "123456:ABC-DEF",
        groupId: "-100123",
        museBotId: "999",
      },
      tempConfigPath
    );
    expect(isMuseRunnerActive(tempConfigPath)).toBe(false);
  });
});

describe("remoteAgent - Protocol and Chunking", () => {
  it("should encode small envelopes as a single string", () => {
    const env: TaskRequestEnvelope = {
      v: 1,
      kind: "task_request",
      id: "task_1",
      task: "Test task",
      workspace: "/test",
      tools: ["read", "write"],
    };

    const encoded = encodeEnvelope(env, 3800);
    expect(encoded).toHaveLength(1);
    expect(JSON.parse(encoded[0])).toEqual(env);
  });

  it("should split large envelopes into MUSEBUS chunks", () => {
    const largeData = "x".repeat(10000);
    const env: TaskDoneEnvelope = {
      v: 1,
      kind: "task_done",
      task_id: "task_long",
      summary: largeData,
    };

    const chunks = encodeEnvelope(env, 2000);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]).toMatch(/^MUSEBUS task_long 1\/\d+\n/);

    // Reassemble using EnvelopeReassembler
    const reassembler = new EnvelopeReassembler();
    let reassembled: any = null;
    for (const chunk of chunks) {
      reassembled = reassembler.processMessage(chunk);
    }

    expect(reassembled).not.toBeNull();
    expect(reassembled.kind).toBe("task_done");
    expect(reassembled.summary).toBe(largeData);
  });

  it("should handle out-of-order chunk reassembly", () => {
    const largeData = "Hello out of order world ".repeat(200);
    const env: ChatEnvelope = {
      v: 1,
      kind: "chat",
      id: "chat_ordered",
      text: largeData,
    };

    const chunks = encodeEnvelope(env, 1000);
    expect(chunks.length).toBeGreaterThanOrEqual(3);

    const reassembler = new EnvelopeReassembler();
    // Feed part 2, then part 3, then part 1
    const p1 = chunks[0];
    const p2 = chunks[1];
    const p3 = chunks[2];

    expect(reassembler.processMessage(p2)).toBeNull();
    expect(reassembler.processMessage(p3)).toBeNull();
    const result = reassembler.processMessage(p1);

    if (chunks.length === 3) {
      expect(result).not.toBeNull();
      expect(result?.text).toBe(largeData);
    }
  });

  it("should validate valid envelopes according to schema", () => {
    const validBatch: TaskBatchEnvelope = {
      v: 1,
      kind: "task_batch",
      id: "batch_1",
      task_id: "task_1",
      calls: [{ id: "c1", tool: "read", args: { path: "src/index.ts" } }],
    };

    const res = validateEnvelope(validBatch, "muse_123", "-100999", {
      groupId: "-100999",
      museBotId: "muse_123",
    });

    expect(res.valid).toBe(true);
    expect(res.envelope).toEqual(validBatch);
  });

  it("should reject messages from wrong chat group", () => {
    const env: TaskBatchEnvelope = {
      v: 1,
      kind: "task_batch",
      id: "batch_1",
      task_id: "task_1",
      calls: [{ id: "c1", tool: "read" }],
    };

    const res = validateEnvelope(env, "muse_123", "wrong_chat", {
      groupId: "-100999",
      museBotId: "muse_123",
    });

    expect(res.valid).toBe(false);
    expect(res.error).toContain("does not match configured group ID");
  });

  it("should reject task_batch from sender other than museBotId", () => {
    const env: TaskBatchEnvelope = {
      v: 1,
      kind: "task_batch",
      id: "batch_1",
      task_id: "task_1",
      calls: [{ id: "c1", tool: "read" }],
    };

    const res = validateEnvelope(env, "attacker_456", "-100999", {
      groupId: "-100999",
      museBotId: "muse_123",
    });

    expect(res.valid).toBe(false);
    expect(res.error).toContain("is not the authorized Muse bot");
  });

  it("should reject malformed schema or unknown kind", () => {
    expect(validateEnvelope({ v: 2, kind: "task_batch" }).valid).toBe(false);
    expect(validateEnvelope({ v: 1, kind: "unknown_kind" }).valid).toBe(false);
    expect(
      validateEnvelope({ v: 1, kind: "task_batch", id: "b1", task_id: "t1" }).valid
    ).toBe(false); // missing calls
  });
});

describe("remoteAgent - Batch Executor", () => {
  const tempDir = path.join(
    os.tmpdir(),
    `batch-exec-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );

  beforeEach(() => {
    fs.mkdirSync(tempDir, { recursive: true });
    fs.writeFileSync(path.join(tempDir, "sample.txt"), "Line 1\nLine 2\nLine 3\n", "utf-8");
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it("should execute read tools without requiring modifying permission", async () => {
    const results = await executeBatch(
      [
        {
          id: "c1",
          tool: "read",
          args: { filePath: path.join(tempDir, "sample.txt") },
        },
      ],
      { workspace: tempDir }
    );

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("c1");
    expect(results[0].ok).toBe(true);
    expect(results[0].output).toContain("Line 1");
  });

  it("should block destructive tools when permission is denied", async () => {
    const results = await executeBatch(
      [
        {
          id: "c2",
          tool: "write",
          args: { filePath: path.join(tempDir, "denied.txt"), content: "Malicious" },
        },
      ],
      {
        workspace: tempDir,
        onPermissionPrompt: async () => false, // User denies permission
      }
    );

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("c2");
    expect(results[0].ok).toBe(false);
    expect(results[0].error).toContain("User denied permission");
    expect(fs.existsSync(path.join(tempDir, "denied.txt"))).toBe(false);
  });

  it("should allow destructive tools when permission is granted", async () => {
    const results = await executeBatch(
      [
        {
          id: "c3",
          tool: "write",
          args: { filePath: path.join(tempDir, "allowed.txt"), content: "Approved content" },
        },
      ],
      {
        workspace: tempDir,
        onPermissionPrompt: async () => true, // User approves
      }
    );

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("c3");
    expect(results[0].ok).toBe(true);
    expect(fs.existsSync(path.join(tempDir, "allowed.txt"))).toBe(true);
    expect(fs.readFileSync(path.join(tempDir, "allowed.txt"), "utf-8")).toBe("Approved content");
  });

  it("should execute shell command tool (run_command) and return output", async () => {
    const results = await executeBatch(
      [
        {
          id: "c_shell_1",
          tool: "run_command",
          args: { command: "node -e \"console.log('hello from remote shell')\"" },
        },
      ],
      { workspace: tempDir }
    );

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("c_shell_1");
    expect(results[0].ok).toBe(true);
    expect(results[0].output).toContain("hello from remote shell");
  });

  it("should normalize shell tool aliases like 'shell', 'exec', 'cmd' to run_command", async () => {
    const results = await executeBatch(
      [
        {
          id: "c_shell_alias",
          tool: "shell",
          args: { cmd: "node -e \"console.log('aliased command success')\"" },
        },
      ],
      { workspace: tempDir }
    );

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("c_shell_alias");
    expect(results[0].ok).toBe(true);
    expect(results[0].output).toContain("aliased command success");
  });

  it("should truncate tool output exceeding 20,000 characters", () => {
    const huge = "a".repeat(25000);
    const truncated = truncateOutput(huge);

    expect(truncated.length).toBe(MAX_TOOL_OUTPUT_CHARS + "\n[truncated]".length);
    expect(truncated.endsWith("\n[truncated]")).toBe(true);
  });

  it("should return error for unknown tools", async () => {
    const results = await executeBatch(
      [{ id: "c_unknown", tool: "non_existent_tool_xyz", args: {} }],
      { workspace: tempDir }
    );

    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(false);
    expect(results[0].error).toContain("Unknown tool");
  });

  it("should trigger onToolStart and onToolEnd callbacks during batch execution", async () => {
    const toolStarts: any[] = [];
    const toolEnds: any[] = [];
    const sampleFile = path.join(tempDir, "sample.txt");

    const results = await executeBatch(
      [
        {
          id: "call_test_1",
          tool: "read",
          args: { filePath: sampleFile },
        },
      ],
      {
        workspace: tempDir,
        onToolStart: (toolCall, desc) => toolStarts.push({ toolCall, desc }),
        onToolEnd: (toolCall, toolResult, desc) => toolEnds.push({ toolCall, toolResult, desc }),
      }
    );

    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(true);

    expect(toolStarts).toHaveLength(1);
    expect(toolStarts[0].toolCall.name).toBe("read");
    expect(toolStarts[0].desc).toContain(sampleFile);

    expect(toolEnds).toHaveLength(1);
    expect(toolEnds[0].toolResult.name).toBe("read");
    expect(toolEnds[0].toolResult.isError).toBe(false);
    expect(toolEnds[0].toolResult.result).toContain("Line 1");
  });

  it("should dispatch to agent.onEvent when onToolStart / onToolEnd are not provided", async () => {
    const events: any[] = [];
    const mockAgent: any = {
      onEvent: (event: any) => events.push(event),
    };
    const sampleFile = path.join(tempDir, "sample.txt");

    const results = await executeBatch(
      [
        {
          id: "call_test_2",
          tool: "read",
          args: { filePath: sampleFile },
        },
      ],
      {
        workspace: tempDir,
        agent: mockAgent,
      }
    );

    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(true);

    const startEvent = events.find((e) => e.type === "tool_start");
    expect(startEvent).toBeDefined();
    expect(startEvent.toolCall.name).toBe("read");

    const endEvent = events.find((e) => e.type === "tool_end");
    expect(endEvent).toBeDefined();
    expect(endEvent.toolResult.name).toBe("read");
    expect(endEvent.toolResult.isError).toBe(false);
  });

  it("should trigger onToolEnd with error status when permission is denied", async () => {
    const toolEnds: any[] = [];

    const results = await executeBatch(
      [
        {
          id: "call_test_denied",
          tool: "write",
          args: { filePath: path.join(tempDir, "denied_event.txt"), content: "foo" },
        },
      ],
      {
        workspace: tempDir,
        onPermissionPrompt: async () => false,
        onToolEnd: (_tc, toolResult) => toolEnds.push(toolResult),
      }
    );

    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(false);
    expect(toolEnds).toHaveLength(1);
    expect(toolEnds[0].isError).toBe(true);
    expect(toolEnds[0].result).toContain("User denied permission");
  });
});

describe("remoteAgent - MuseClient", () => {
  it("should prevent concurrent polling on the same client", async () => {
    const client = new MuseClient({
      botToken: "fake_token",
      groupId: "-1001",
      museBotId: "muse_1",
    });

    // Mock fetch to simulate long polling
    const originalFetch = globalThis.fetch;
    const abortCtrl = new AbortController();

    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes("deleteWebhook")) {
        return Promise.resolve(new Response(JSON.stringify({ ok: true })));
      }
      if (url.includes("getUpdates")) {
        return new Promise((resolve) => {
          setTimeout(() => {
            resolve(new Response(JSON.stringify({ ok: true, result: [] })));
          }, 100);
        });
      }
      return Promise.resolve(new Response(JSON.stringify({ ok: true })));
    });

    try {
      const pollPromise = client.pollEnvelopes(() => {}, abortCtrl.signal);
      expect(client.isPollerActive()).toBe(true);

      // Attempting to poll again concurrently must reject
      await expect(client.pollEnvelopes(() => {}, abortCtrl.signal)).rejects.toThrow(
        "already running"
      );

      abortCtrl.abort();
      await pollPromise.catch(() => {});
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("should retry on HTTP 429 using parameters.retry_after", async () => {
    const client = new MuseClient({
      botToken: "fake_token",
      groupId: "-1001",
      museBotId: "muse_1",
    });

    const originalFetch = globalThis.fetch;
    let callCount = 0;

    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes("sendMessage")) {
        callCount++;
        if (callCount === 1) {
          // First attempt returns 429 with retry_after = 0
          return Promise.resolve(
            new Response(
              JSON.stringify({
                ok: false,
                error_code: 429,
                parameters: { retry_after: 0 },
              }),
              { status: 429 }
            )
          );
        }
        // Second attempt succeeds
        return Promise.resolve(new Response(JSON.stringify({ ok: true, result: {} })));
      }
      return Promise.resolve(new Response(JSON.stringify({ ok: true })));
    });

    try {
      const ok = await client.sendMessage("-1001", "Hello rate limit");
      expect(ok).toBe(true);
      expect(callCount).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("remoteAgent - Task Runner & Loop Guards", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    // Save test config
    saveRemoteAgentConfig({
      botToken: "test_bot_token",
      groupId: "-100123",
      museBotId: "999",
      defaultWorkspace: process.cwd(),
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("should deduplicate batch IDs and successfully complete on task_done", async () => {
    let updateCounter = 1;
    let sentEnvelopes: any[] = [];
    let capturedTaskId = "";

    globalThis.fetch = vi.fn().mockImplementation(async (url: string, options?: any) => {
      if (url.includes("deleteWebhook")) {
        return new Response(JSON.stringify({ ok: true }));
      }
      if (url.includes("sendMessage")) {
        const body = JSON.parse(options?.body || "{}");
        sentEnvelopes.push(body);
        if (body.text) {
          try {
            const parsed = JSON.parse(body.text);
            if (parsed.kind === "task_request" && parsed.id) {
              capturedTaskId = parsed.id;
            }
          } catch {}
        }
        return new Response(JSON.stringify({ ok: true, result: {} }));
      }
      if (url.includes("getUpdates")) {
        // First batch: send a task_batch with batch_1
        if (updateCounter === 1) {
          updateCounter++;
          const batchEnv: TaskBatchEnvelope = {
            v: 1,
            kind: "task_batch",
            id: "batch_1",
            task_id: capturedTaskId || "task_1",
            calls: [{ id: "c1", tool: "glob", args: { pattern: "*.json" } }],
          };
          return new Response(
            JSON.stringify({
              ok: true,
              result: [
                {
                  update_id: 101,
                  message: {
                    chat: { id: "-100123" },
                    from: { id: "999" },
                    text: JSON.stringify(batchEnv),
                  },
                },
              ],
            })
          );
        }
        // Second poll: redeliver duplicate batch_1 (should be ignored by dedupe)
        if (updateCounter === 2) {
          updateCounter++;
          const batchEnv: TaskBatchEnvelope = {
            v: 1,
            kind: "task_batch",
            id: "batch_1",
            task_id: capturedTaskId || "task_1",
            calls: [{ id: "c1", tool: "glob", args: { pattern: "*.json" } }],
          };
          return new Response(
            JSON.stringify({
              ok: true,
              result: [
                {
                  update_id: 102,
                  message: {
                    chat: { id: "-100123" },
                    from: { id: "999" },
                    text: JSON.stringify(batchEnv),
                  },
                },
              ],
            })
          );
        }
        // Third poll: send task_done
        if (updateCounter === 3) {
          updateCounter++;
          const doneEnv: TaskDoneEnvelope = {
            v: 1,
            kind: "task_done",
            task_id: capturedTaskId || "task_1",
            summary: "All JSON files found successfully.",
          };
          return new Response(
            JSON.stringify({
              ok: true,
              result: [
                {
                  update_id: 103,
                  message: {
                    chat: { id: "-100123" },
                    from: { id: "999" },
                    text: JSON.stringify(doneEnv),
                  },
                },
              ],
            })
          );
        }

        // Subsequent polls idle
        return new Response(JSON.stringify({ ok: true, result: [] }));
      }
      return new Response(JSON.stringify({ ok: true }));
    });

    const progressLogs: string[] = [];
    const result = await runRemoteTask({
      task: "Find all json files",
      workspace: process.cwd(),
      onProgress: (msg) => progressLogs.push(msg),
    });

    expect(result.success).toBe(true);
    expect(result.summary).toBe("All JSON files found successfully.");
    expect(result.batchCount).toBe(1); // Executed only once due to dedupe
    expect(progressLogs.some((l) => l.includes("Duplicate batch ID ignored"))).toBe(true);
  });
});

describe("remoteAgent - Slash Command (/muse)", () => {
  let lines: ChatLine[] = [];
  const mockContext: SlashCommandContext = {
    addLine: (line) => lines.push(line),
    exit: () => {},
    agent: null,
  };

  beforeEach(() => {
    lines = [];
  });

  it("should show status with masked bot token", async () => {
    saveRemoteAgentConfig({
      botToken: "123456789:ABCsecretTokenXYZ",
      groupId: "-100987654",
      museBotId: "998877",
    });

    await museCommand.execute("status", mockContext);

    expect(lines.length).toBeGreaterThan(0);
    const content = lines[0].content;
    expect(content).toContain("Remote Agent (Muse) Status:");
    expect(content).toContain("1234...nXYZ");
    expect(content).not.toContain("ABCsecretTokenXYZ");
    expect(content).toContain("-100987654");
  });

  it("should update config via /muse config", async () => {
    await museCommand.execute("config groupId -100444555", mockContext);

    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0].content).toContain("Remote agent configuration updated: groupId = -100444555");

    const cfg = loadRemoteAgentConfig();
    expect(cfg.groupId).toBe("-100444555");
  });

  it("should toggle as_runner_model via /muse config", async () => {
    lines = [];
    await museCommand.execute("config as_runner_model on", mockContext);
    expect(lines[0].content).toContain("Remote agent configuration updated: asRunner = on (enabled)");
    let cfg = loadRemoteAgentConfig();
    expect(cfg.asRunner).toBe(true);

    lines = [];
    await museCommand.execute("config as_runner_model off", mockContext);
    expect(lines[0].content).toContain("Remote agent configuration updated: asRunner = off (disabled)");
    cfg = loadRemoteAgentConfig();
    expect(cfg.asRunner).toBe(false);
  });

  it("should append a new assistant response without overwriting previous assistant messages", async () => {
    saveRemoteAgentConfig({
      botToken: "123456789:ABCsecretTokenXYZ",
      groupId: "-100987654",
      museBotId: "998877",
    });

    let currentLines: ChatLine[] = [
      { type: "assistant", content: "Previous answer from earlier turn", timestamp: 1000 },
      { type: "user", content: "❯ hi", timestamp: 2000 },
    ];

    let capturedTaskId = "";
    globalThis.fetch = vi.fn().mockImplementation(async (url: string, options?: any) => {
      if (url.includes("deleteWebhook")) return new Response(JSON.stringify({ ok: true }));
      if (url.includes("getMe")) return new Response(JSON.stringify({ ok: true, result: { username: "bot", can_read_all_group_messages: true } }));
      if (url.includes("sendMessage")) {
        const body = JSON.parse(options?.body || "{}");
        if (body.text) {
          try {
            const p = JSON.parse(body.text);
            if (p.kind === "task_request") capturedTaskId = p.id;
          } catch {}
        }
        return new Response(JSON.stringify({ ok: true, result: {} }));
      }
      if (url.includes("getUpdates")) {
        return new Response(
          JSON.stringify({
            ok: true,
            result: [
              {
                update_id: 201,
                message: {
                  chat: { id: "-100987654" },
                  from: { id: "998877" },
                  text: JSON.stringify({
                    v: 1,
                    kind: "task_done",
                    id: "done_123",
                    task_id: capturedTaskId,
                    summary: "Hai juga! Bridge aktif.",
                  }),
                },
              },
            ],
          })
        );
      }
      return new Response(JSON.stringify({ ok: true }));
    });

    const addedMessages: any[] = [];
    const mockAgent: any = {
      workingDirectory: "/test/ws",
      planState: "IDLE",
      getCurrentHistoryFilePath: () => "/test/sess.json",
      getHistory: () => ({
        addUserMessage: (msg: string) => addedMessages.push({ role: "user", msg }),
        addAssistantMessage: (msg: string) => addedMessages.push({ role: "assistant", msg }),
        saveToFile: async () => {},
      }),
    };

    const taskCtx: SlashCommandContext = {
      addLine: (line) => currentLines.push(line),
      setLines: (updater: any) => {
        if (typeof updater === "function") {
          currentLines = updater(currentLines);
        } else {
          currentLines = updater;
        }
      },
      exit: () => {},
      agent: mockAgent,
    };

    await museCommand.execute("hi", taskCtx);

    // Verify: previous assistant message was NOT overwritten!
    expect(currentLines[0].content).toBe("Previous answer from earlier turn");

    // Verify: new assistant message was appended with Muse's answer
    const assistantLines = currentLines.filter((l) => l.type === "assistant");
    expect(assistantLines.length).toBe(2);
    expect(assistantLines[1].content).toContain("Hai juga! Bridge aktif.");
    expect(assistantLines[1].content).toContain("📋 Task Summary (Muse Remote)");

    // Verify: conversation history recorded the exchange
    expect(addedMessages).toHaveLength(2);
    expect(addedMessages[0].role).toBe("user");
    expect(addedMessages[0].msg).toBe("hi");
    expect(addedMessages[1].role).toBe("assistant");
    expect(addedMessages[1].msg).toBe("Hai juga! Bridge aktif.");
  });

  it("should append summary at the end after all tool executions without putting text above tools", async () => {
    saveRemoteAgentConfig({
      botToken: "123456789:ABCsecretTokenXYZ",
      groupId: "-100987654",
      museBotId: "998877",
    });

    let currentLines: ChatLine[] = [];
    let capturedTaskId = "";
    let step = 0;

    globalThis.fetch = vi.fn().mockImplementation(async (url: string, options?: any) => {
      if (url.includes("deleteWebhook")) return new Response(JSON.stringify({ ok: true }));
      if (url.includes("getMe")) return new Response(JSON.stringify({ ok: true, result: { username: "bot", can_read_all_group_messages: true } }));
      if (url.includes("sendMessage")) {
        const body = JSON.parse(options?.body || "{}");
        if (body.text) {
          try {
            const p = JSON.parse(body.text);
            if (p.kind === "task_request") capturedTaskId = p.id;
          } catch {}
        }
        return new Response(JSON.stringify({ ok: true, result: {} }));
      }
      if (url.includes("getUpdates")) {
        step++;
        if (step === 1) {
          return new Response(
            JSON.stringify({
              ok: true,
              result: [
                {
                  update_id: 301,
                  message: {
                    chat: { id: "-100987654" },
                    from: { id: "998877" },
                    text: JSON.stringify({
                      v: 1,
                      kind: "task_batch",
                      id: "batch_tools",
                      task_id: capturedTaskId,
                      calls: [{ id: "c1", tool: "read", args: { filePath: "package.json" } }],
                    }),
                  },
                },
              ],
            })
          );
        }
        if (step === 2) {
          return new Response(
            JSON.stringify({
              ok: true,
              result: [
                {
                  update_id: 302,
                  message: {
                    chat: { id: "-100987654" },
                    from: { id: "998877" },
                    text: JSON.stringify({
                      v: 1,
                      kind: "task_done",
                      id: "done_tools",
                      task_id: capturedTaskId,
                      summary: "Audit selesai. Semua dependensi terverifikasi.",
                    }),
                  },
                },
              ],
            })
          );
        }
        return new Response(JSON.stringify({ ok: true, result: [] }));
      }
      return new Response(JSON.stringify({ ok: true }));
    });

    const taskCtx: SlashCommandContext = {
      addLine: (line) => currentLines.push(line),
      setLines: (updater: any) => {
        if (typeof updater === "function") {
          currentLines = updater(currentLines);
        } else {
          currentLines = updater;
        }
      },
      exit: () => {},
      agent: null,
    };

    await museCommand.execute("audit package.json", taskCtx);

    const assistantLines = currentLines.filter((l) => l.type === "assistant");
    expect(assistantLines.length).toBe(2);
    // Line 1: tool execution container has empty text content so tools are not preceded by premature text
    expect(assistantLines[0].content).toBe("");
    expect(assistantLines[0].children?.length).toBeGreaterThan(0);

    // Line 2: final summary at the end
    expect(assistantLines[1].content).toContain("📋 Task Summary (Muse Remote)");
    expect(assistantLines[1].content).toContain("Audit selesai. Semua dependensi terverifikasi.");
  });

  it("should be registered in the slash command registry", () => {
    const cmd = registry.get("muse");
    expect(cmd).toBeDefined();
    expect(cmd?.name).toBe("muse");
  });
});

describe("remoteAgent - CLI Handler", () => {
  it("should handle muse status from CLI", async () => {
    const { handleMuseCliCommand } = await import("../src/core/remoteAgent/museCli.js");
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    await handleMuseCliCommand(["status"]);

    expect(spy).toHaveBeenCalled();
    const calls = spy.mock.calls.map((c) => c.join(" "));
    expect(calls.some((c) => c.includes("Remote Agent (Muse) Status"))).toBe(true);
    spy.mockRestore();
  });

  it("should handle muse config from CLI", async () => {
    const { handleMuseCliCommand } = await import("../src/core/remoteAgent/museCli.js");
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    await handleMuseCliCommand(["config", "museBotId", "888777"]);

    let cfg = loadRemoteAgentConfig();
    expect(cfg.museBotId).toBe("888777");

    await handleMuseCliCommand(["config", "as_runner", "on"]);
    cfg = loadRemoteAgentConfig();
    expect(cfg.asRunner).toBe(true);

    spy.mockRestore();
  });

  it("should provide command and subcommand suggestions for /muse", async () => {
    const { getDashboardSuggestions, getSuggestionDescriptions } = await import(
      "../src/utils/dashboardSuggestions.js"
    );

    const rootSuggestions = getDashboardSuggestions("/mu");
    expect(rootSuggestions).toContain("/muse");

    const subSuggestions = getDashboardSuggestions("/muse ");
    expect(subSuggestions).toContain("/muse status");
    expect(subSuggestions).toContain("/muse config");
    expect(subSuggestions).toContain("/muse config botToken");
    expect(subSuggestions).toContain("/muse config as_runner_model");
    expect(subSuggestions).toContain("/muse config as_runner_model on");
    expect(subSuggestions).toContain("/muse config as_runner_model off");

    const configKeySuggestions = getDashboardSuggestions("/muse config as");
    expect(configKeySuggestions).toContain("/muse config as_runner_model on");

    const desc = getSuggestionDescriptions();
    expect(desc["/muse"]).toBeDefined();
    expect(desc["/muse"]).toContain("Muse");
    expect(desc["/muse config as_runner_model"]).toBeDefined();
    expect(desc["/muse config as_runner_model on"]).toBeDefined();
  });
});

describe("remoteAgent - Summary Formatter", () => {
  it("should unescape literal \\n and break numbered lists and headings cleanly", async () => {
    const { formatReadableSummary } = await import("../src/core/remoteAgent/formatSummary.js");

    const denseText =
      "Audit selesai. TEMUAN: 1) [Sedang] Password DB default 'postgres123'. 2) [Rendah] REPORT basi. POSITIF: backend aman. 3) [Rendah] README basi.";

    const formatted = formatReadableSummary(denseText);

    // Headings break onto separate lines
    expect(formatted).toContain("TEMUAN:\n  1)");
    expect(formatted).toContain("POSITIF:\nbackend aman.");

    // Numbered items break onto separate lines
    expect(formatted).toContain("\n  2) [Rendah] REPORT basi.");
    expect(formatted).toContain("\n  3) [Rendah] README basi.");
  });

  it("should handle escaped \\n correctly", async () => {
    const { formatReadableSummary } = await import("../src/core/remoteAgent/formatSummary.js");

    const escaped = "Line 1\\nLine 2\\nLine 3";
    const formatted = formatReadableSummary(escaped);

    expect(formatted).toBe("Line 1\nLine 2\nLine 3");
  });
});


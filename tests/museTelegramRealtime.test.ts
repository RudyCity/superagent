import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MuseClient } from "../src/core/remoteAgent/museClient.js";
import {
  saveRemoteAgentConfig,
  loadRemoteAgentConfig,
  RemoteAgentConfig,
} from "../src/core/remoteAgent/config.js";
import {
  startMuseWatcher,
  stopMuseWatcher,
} from "../src/core/remoteAgent/museWatcher.js";

describe("Muse Telegram Watch Real-Time Ingress & Cancellation", () => {
  let originalConfig: RemoteAgentConfig;

  beforeEach(() => {
    vi.restoreAllMocks();
    originalConfig = loadRemoteAgentConfig();
    saveRemoteAgentConfig({
      botToken: "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11",
      groupId: "-1001234567890",
      museBotId: "987654321",
      defaultWorkspace: process.cwd(),
    });
  });

  afterEach(async () => {
    await stopMuseWatcher();
    saveRemoteAgentConfig(originalConfig);
    vi.restoreAllMocks();
  });

  it("should send chat action (typing) via Telegram Bot API", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: true }),
    } as any);

    const client = new MuseClient({
      botToken: "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11",
      groupId: -1001234567890,
      museBotId: 987654321,
    });

    const res = await client.sendChatAction(-1001234567890, "typing");
    expect(res).toBe(true);
    expect(fetchSpy).toHaveBeenCalled();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toContain("/sendChatAction");
    expect(init?.method).toBe("POST");
    expect(JSON.parse((init?.body as string) || "{}")).toEqual({
      chat_id: -1001234567890,
      action: "typing",
    });

    fetchSpy.mockRestore();
  });

  it("should process batches asynchronously without blocking ingress and cancel in-flight tasks in real time", async () => {
    let registeredHandler: ((envelope: any, meta?: any) => Promise<void>) | null = null;
    const sentEnvelopes: any[] = [];

    const pollSpy = vi
      .spyOn(MuseClient.prototype, "pollEnvelopes")
      .mockImplementation((handler) => {
        registeredHandler = handler;
        return new Promise(() => {});
      });

    const sendSpy = vi
      .spyOn(MuseClient.prototype, "sendEnvelope")
      .mockImplementation(async (env) => {
        sentEnvelopes.push(env);
        return true;
      });

    const chatActionSpy = vi
      .spyOn(MuseClient.prototype, "sendChatAction")
      .mockResolvedValue(true);

    const lines: string[] = [];
    const watcher = await startMuseWatcher({
      workspace: process.cwd(),
      announce: false,
      onLog: (msg) => lines.push(msg),
    });

    expect(registeredHandler).not.toBeNull();

    // 1. Dispatch a batch containing a sleep command to simulate long-running tool execution
    const batchPromise = registeredHandler!({
      v: 1,
      kind: "task_batch",
      id: "batch_realtime_001",
      task_id: "task_rt_1",
      calls: [
        {
          id: "call_sleep",
          tool: "run_command",
          args: { command: 'node -e "setTimeout(() => console.log(\'done\'), 2000)"' },
        },
      ],
    });

    // Ingress MUST resolve immediately without waiting for the 2-second tool execution!
    await expect(batchPromise).resolves.toBeUndefined();

    // The batch is now actively executing in the background
    expect(watcher.hasActiveBatch()).toBe(true);
    expect(chatActionSpy).toHaveBeenCalledWith(expect.anything(), "typing");

    // 2. While the batch is still running, send a task_cancel envelope immediately
    await registeredHandler!({
      v: 1,
      kind: "task_cancel",
      task_id: "task_rt_1",
      reason: "User aborted task via Telegram in real time",
    });

    // The active batch must be aborted immediately without hanging
    expect(watcher.hasActiveBatch()).toBe(false);
    expect(lines.some((l) => l.includes("cancelled"))).toBe(true);

    await watcher.waitForIdle();
    expect(watcher.hasActiveBatch()).toBe(false);

    pollSpy.mockRestore();
    sendSpy.mockRestore();
    chatActionSpy.mockRestore();
  });
});

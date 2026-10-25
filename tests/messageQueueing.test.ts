import { describe, expect, it, vi, beforeEach, afterEach, beforeAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

const tempHome = path.join(os.tmpdir(), "superagent-msg-queue-test-home-" + Date.now());
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.SUPERAGENT_CONFIG_DIR = path.join(tempHome, ".superagent-r");

// Vitest hoists this mock before the dynamic imports below.
vi.mock("ai", () => ({
  streamText: vi.fn(),
  generateText: vi.fn(),
  jsonSchema: (s: any) => s,
}));

const { Agent } = await import("../src/core/agent.js");
const { streamText } = await import("ai");
const { RequestProcessor } = await import("../src/core/agent/RequestProcessor.js");
const jsonConfigModule = await import("../src/core/config/jsonConfig.js");
const providersModule = await import("../src/core/config/providers.js");


describe("Agent – Message Queueing", () => {
  beforeEach(async () => {
    try {
      const { closeHistoryDb } = await import("../src/core/storage/historyDb.js");
      closeHistoryDb();
    } catch {}
    if (fs.existsSync(tempHome)) {
      try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch {}
    }
    try { fs.mkdirSync(tempHome, { recursive: true }); } catch {}
    vi.clearAllMocks();
    // Restore config/provider spies after clearAllMocks
    vi.spyOn(jsonConfigModule, "getSettings").mockReturnValue({
      maxConcurrency: 1,
      rateLimitRequests: 10,
      rateLimitInterval: 1000,
      disableStreaming: false,
      contextWindowLimit: 200000,
      maxIterations: 2,
    } as any);
    vi.spyOn(providersModule, "getEffectiveMasterModel").mockReturnValue("gpt-4");
    vi.spyOn(providersModule, "getTierModel").mockReturnValue("gpt-4");
    vi.spyOn(providersModule, "getActiveProviderName").mockReturnValue("openai");
    vi.spyOn(providersModule, "getConfiguredProviders" as any).mockReturnValue([{ provider: "openai", apiKey: "fake-key" }]);
  });

  afterEach(async () => {
    try {
      const { closeHistoryDb } = await import("../src/core/storage/historyDb.js");
      closeHistoryDb();
    } catch {}
    if (fs.existsSync(tempHome)) {
      try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch {}
    }
  });

  it("should queue multiple messages when already running and execute them sequentially", async () => {
    const events: any[] = [];
    const onEvent = vi.fn((e) => events.push(e));
    const onPermission = vi.fn().mockResolvedValue(true);
    const onQuestion = vi.fn();

    const agent = new Agent(onEvent, onPermission, onQuestion);
    agent.tier = "single";
    agent.planState = "APPROVED";

    vi.mocked(streamText).mockImplementation(() => {
      return {
        fullStream: (async function* () {
          yield { type: "text-delta", textDelta: "Done response" };
        })(),
        usage: Promise.resolve({ promptTokens: 5, completionTokens: 5 }),
      } as any;
    });

    const firstPromise = agent.sendMessage("first message");
    const secondPromise = agent.sendMessage("second message");
    const thirdPromise = agent.sendMessage("third message");

    await Promise.all([firstPromise, secondPromise, thirdPromise]);

    const msgs = agent.getHistory().getMessages().filter(m => m.role === "user");
    const userContents = msgs.map(m => m.content);
    expect(userContents).toContain("first message");
    expect(userContents).toContain("second message");
    expect(userContents).toContain("third message");
  });

  it("reserves the chat turn before async classification and processes the queue serially", async () => {
    let releaseFirst!: (value: boolean) => void;
    const gate = new Promise<boolean>((resolve) => { releaseFirst = resolve; });
    const requestSpy = vi.spyOn(RequestProcessor, "processRequest")
      .mockImplementationOnce(() => gate)
      .mockResolvedValueOnce(false);
    const agent = new Agent(vi.fn(), vi.fn().mockResolvedValue(false), vi.fn());
    const first = agent.sendMessage("first");
    const second = agent.sendMessage("second");
    expect(agent.isAgentRunning()).toBe(true);
    expect(requestSpy).toHaveBeenCalledTimes(1);
    releaseFirst(false);
    await Promise.all([first, second]);
    await vi.waitFor(() => expect(requestSpy).toHaveBeenCalledTimes(2));
    expect(agent.isAgentRunning()).toBe(false);
    requestSpy.mockRestore();
  });

  it("aborts an active hung agent loop and emits done for this session", async () => {
    const events: any[] = [];
    const requestSpy = vi.spyOn(RequestProcessor, "processRequest").mockResolvedValue(true);
    const agent = new Agent((event) => events.push(event), vi.fn().mockResolvedValue(false), vi.fn());
    agent.tier = "single";
    (agent as any).runAgentLoop = () => new Promise(() => {});
    const pending = agent.sendMessage("hang until aborted");
    await vi.waitFor(() => expect(agent.isAgentRunning()).toBe(true));
    agent.abort();
    await Promise.race([
      pending,
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error("Abort did not settle")), 3000)),
    ]);
    expect(agent.isAgentRunning()).toBe(false);
    expect(events.some((event) => event.type === "done")).toBe(true);
    requestSpy.mockRestore();
  });

  it("abort during preprocessing cancels the reserved turn before any model execution", async () => {
    let release!: (value: boolean) => void;
    const gate = new Promise<boolean>((resolve) => { release = resolve; });
    const processSpy = vi.spyOn(RequestProcessor, "processRequest").mockImplementation(() => gate);
    const agent = new Agent(vi.fn(), vi.fn().mockResolvedValue(false), vi.fn());
    const pending = agent.sendMessage("should never start loop");
    expect(agent.isAgentRunning()).toBe(true);
    agent.abort();
    release(true);
    await pending;
    expect(agent.isAgentRunning()).toBe(false);
    processSpy.mockRestore();
  });
});

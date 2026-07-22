import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { Agent } from "../src/core/agent.js";
import { streamText } from "ai";
import * as jsonConfigModule from "../src/core/config/jsonConfig.js";
import * as providersModule from "../src/core/config/providers.js";
import * as aiModule from "ai";

const tempHome = path.join(os.tmpdir(), "superagent-msg-queue-test-home-" + Date.now());
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;

vi.mock("ai", () => ({
  streamText: vi.fn(),
  generateText: vi.fn(),
  jsonSchema: (s: any) => s,
}));


describe("Agent – Message Queueing", () => {
  beforeEach(() => {
    if (fs.existsSync(tempHome)) {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
    fs.mkdirSync(tempHome, { recursive: true });
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

  afterEach(() => {
    if (fs.existsSync(tempHome)) {
      fs.rmSync(tempHome, { recursive: true, force: true });
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
});

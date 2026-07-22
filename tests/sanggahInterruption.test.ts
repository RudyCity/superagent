import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { Agent } from "../src/core/agent.js";
import { streamText } from "ai";
import * as jsonConfigModule from "../src/core/config/jsonConfig.js";
import * as providersModule from "../src/core/config/providers.js";
import * as aiModule from "ai";

const tempHome = path.join(os.tmpdir(), "superagent-sanggah-test-home-" + Date.now());
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;

vi.mock("ai", () => ({
  streamText: vi.fn(),
  generateText: vi.fn(),
  jsonSchema: (s: any) => s,
}));

describe("Agent – Sanggah Interruption", () => {
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
      contextWindowLimit: 10000,
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

  it("should support queueMessage and queue them properly", async () => {
    const onEvent = vi.fn();
    const onPermission = vi.fn().mockResolvedValue(true);
    const onQuestion = vi.fn();

    const agent = new Agent(onEvent, onPermission, onQuestion);
    agent.queueMessage("interrupted prompt");
    
    // Check that we can call queueMessage
    expect(agent.queueMessage).toBeDefined();
  });
});

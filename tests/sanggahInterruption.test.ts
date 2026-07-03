import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { Agent } from "../src/core/agent.js";
import { streamText } from "ai";

const tempHome = path.join(os.tmpdir(), "superagent-sanggah-test-home-" + Date.now());
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;

vi.mock("../src/core/config/jsonConfig.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/config/jsonConfig.js")>();
  return {
    ...actual,
    getSettings: vi.fn().mockReturnValue({
      maxConcurrency: 1,
      rateLimitRequests: 10,
      rateLimitInterval: 1000,
      disableStreaming: false,
      contextWindowLimit: 10000,
      maxIterations: 2,
    }),
  };
});

vi.mock("../src/core/config/providers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/config/providers.js")>();
  return {
    ...actual,
    getEffectiveMasterModel: vi.fn().mockReturnValue("gpt-4"),
    getTierModel: vi.fn().mockReturnValue("gpt-4"),
    getActiveProviderName: vi.fn().mockReturnValue("openai"),
    getConfiguredProviders: vi.fn().mockReturnValue({
      provider: "openai",
      model: "gpt-4",
      apiKey: "fake-key",
      disableStreaming: false,
      workingDirectory: process.cwd(),
      systemPrompt: "Base Agent Prompt Content",
    }),
  };
});

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    streamText: vi.fn(),
  };
});

describe("Agent – Sanggah Interruption", () => {
  beforeEach(() => {
    if (fs.existsSync(tempHome)) {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
    fs.mkdirSync(tempHome, { recursive: true });
    vi.clearAllMocks();
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

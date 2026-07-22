import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { Agent } from "../src/core/agent.js";
import * as jsonConfigModule from "../src/core/config/jsonConfig.js";
import * as providersModule from "../src/core/config/providers.js";

describe("Agent – getConversationMessages", () => {
  beforeEach(() => {
    vi.spyOn(jsonConfigModule, "getSettings").mockReturnValue({
      maxConcurrency: 1,
      rateLimitRequests: 10,
      rateLimitInterval: 1000,
      disableStreaming: false,
      contextWindowLimit: 10000,
      maxIterations: 2,
    } as any);

    vi.spyOn(providersModule, "getEffectiveMasterModel").mockReturnValue("gpt-4" as any);
    vi.spyOn(providersModule, "getTierModel").mockReturnValue("gpt-4" as any);
    vi.spyOn(providersModule, "getActiveProviderName").mockReturnValue("openai" as any);
    vi.spyOn(providersModule, "getConfiguredProviders").mockReturnValue({
      provider: "openai",
      model: "gpt-4",
      apiKey: "fake-key",
      disableStreaming: false,
      workingDirectory: process.cwd(),
      systemPrompt: "Base Agent Prompt Content",
    } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should return the list of messages in the conversation", () => {
    const onEvent = vi.fn();
    const onPermission = vi.fn().mockResolvedValue(true);
    const onQuestion = vi.fn();

    const agent = new Agent(onEvent, onPermission, onQuestion);
    agent.tier = "single";

    expect(agent.getConversationMessages()).toBeInstanceOf(Array);
    expect(agent.getConversationMessages().length).toBe(0);
  });
});

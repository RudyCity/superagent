import { describe, expect, it, vi } from "vitest";
import { Agent } from "../src/core/agent.js";

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

describe("Agent – getConversationMessages", () => {
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

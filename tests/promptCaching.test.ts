import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Agent } from "../src/core/agent.js";
import * as configModule from "../src/core/config.js";

describe("Anthropic Prompt Caching", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    process.env.TEST_PROMPT_CACHING = "true";

    // Mock configuration using vi.spyOn for local module
    vi.spyOn(configModule, "getConfig").mockReturnValue({
      provider: "anthropic",
      model: "claude-3-5-sonnet",
      apiKey: "fake-key",
      disableStreaming: false,
      workingDirectory: process.cwd(),
      systemPrompt: "Base Master Agent Prompt Content",
    } as any);
    vi.spyOn(configModule, "getContextWindowLimit").mockReturnValue(8000);
    vi.spyOn(configModule, "getSettings").mockReturnValue({} as any);
  });

  afterEach(() => {
    delete process.env.TEST_PROMPT_CACHING;
  });

  it("should apply cacheControl metadata to the last 3 user messages when provider is Anthropic", () => {
    const agent = new Agent(() => {}, () => Promise.resolve(true), () => {});
    // Mock getModel to return an Anthropic model connection
    vi.spyOn(agent as any, "getModel").mockReturnValue({
      provider: "anthropic",
      modelName: "claude-3-5-sonnet",
    });

    const conv = (agent as any).conversation;
    conv.messages = [];

    // Add 5 user messages and some assistant/tool messages
    conv.addUserMessage("User Message 1");
    conv.addAssistantMessage("Assistant Message 1");
    conv.addUserMessage("User Message 2");
    conv.addAssistantMessage("Assistant Message 2");
    conv.addUserMessage("User Message 3");
    conv.addAssistantMessage("Assistant Message 3");
    conv.addUserMessage("User Message 4");
    conv.addAssistantMessage("Assistant Message 4");
    conv.addUserMessage("User Message 5");

    const coreMessages = (agent as any).buildMessages();

    // There should be 5 user messages and 4 assistant messages in coreMessages.
    // Let's filter user messages from coreMessages.
    const userMessages = coreMessages.filter((m: any) => m.role === "user");
    expect(userMessages.length).toBe(5);

    // The last 3 user messages (indices 2, 3, 4 of userMessages, corresponding to message 3, 4, 5)
    // should have cacheControl.
    // The first 2 user messages (indices 0, 1) should NOT have cacheControl.

    // User Message 1 (index 0)
    expect(userMessages[0].content).toBe("User Message 1"); // string or array, but shouldn't have cacheControl

    // User Message 2 (index 1)
    expect(userMessages[1].content).toBe("User Message 2");

    // User Message 3 (index 2) - should have cacheControl
    expect(userMessages[2].content).toBeInstanceOf(Array);
    expect(userMessages[2].content[0].text).toBe("User Message 3");
    expect(userMessages[2].content[0].experimental_providerMetadata.anthropic.cacheControl).toEqual({ type: "ephemeral" });

    // User Message 4 (index 3) - should have cacheControl
    expect(userMessages[3].content).toBeInstanceOf(Array);
    expect(userMessages[3].content[0].text).toBe("User Message 4");
    expect(userMessages[3].content[0].experimental_providerMetadata.anthropic.cacheControl).toEqual({ type: "ephemeral" });

    // User Message 5 (index 4) - should have cacheControl
    expect(userMessages[4].content).toBeInstanceOf(Array);
    expect(userMessages[4].content[0].text).toBe("User Message 5");
    expect(userMessages[4].content[0].experimental_providerMetadata.anthropic.cacheControl).toEqual({ type: "ephemeral" });
  });

  it("should NOT apply cacheControl when provider is not Anthropic", () => {
    const agent = new Agent(() => {}, () => Promise.resolve(true), () => {});
    // Mock getModel to return an OpenAI model connection
    vi.spyOn(agent as any, "getModel").mockReturnValue({
      provider: "openai",
      modelName: "gpt-4",
    });

    const conv = (agent as any).conversation;
    conv.messages = [];

    conv.addUserMessage("User Message 1");
    conv.addAssistantMessage("Response 1");
    conv.addUserMessage("User Message 2");

    const coreMessages = (agent as any).buildMessages();
    const userMessages = coreMessages.filter((m: any) => m.role === "user");

    expect(userMessages[0].content).toBe("User Message 1");
    expect(userMessages[1].content).toBe("User Message 2");
  });
});

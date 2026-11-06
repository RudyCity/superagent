import { describe, expect, it } from "vitest";
import { validateDelegateChatConfig } from "../src/core/delegate/chatConfiguration.js";

describe("Delegate ChatGPT model/effort configuration", () => {
  it("accepts bounded model names and supported effort levels", () => {
    expect(() => validateDelegateChatConfig({ model: "GPT-5.6", effort: "high" })).not.toThrow();
    expect(() => validateDelegateChatConfig({ model: "GPT-6 Astra" })).not.toThrow();
    expect(() => validateDelegateChatConfig({ effort: "xhigh" })).not.toThrow();
  });

  it("fails closed on empty or unsupported configuration", () => {
    expect(() => validateDelegateChatConfig({})).toThrow("DELEGATE_CHAT_CONFIG_REQUIRED");
    expect(() => validateDelegateChatConfig({ model: " " })).toThrow("DELEGATE_INVALID_MODEL");
    expect(() => validateDelegateChatConfig({ effort: "ultra" as any })).toThrow("DELEGATE_INVALID_EFFORT");
  });
});

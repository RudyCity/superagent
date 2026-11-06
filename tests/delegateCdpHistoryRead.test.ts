import { describe, expect, it } from "vitest";
import {
  OPEN_CHAT_READ_JS,
  parseDelegateCdpChatReadResult,
} from "../src/core/delegate/historySync.js";

describe("Delegate CDP open-chat history fallback", () => {
  it("ships a syntactically valid generated read-only expression", () => {
    expect(() => new Function("return " + OPEN_CHAT_READ_JS)).not.toThrow();
    expect(OPEN_CHAT_READ_JS).toContain("data-message-author-role");
    expect(OPEN_CHAT_READ_JS).not.toContain("click(");
    expect(OPEN_CHAT_READ_JS).not.toContain("location.href =");
    expect(OPEN_CHAT_READ_JS).not.toContain("localStorage");
    expect(OPEN_CHAT_READ_JS).not.toContain("document.cookie");
  });

  it("normalizes bounded messages only for the exact expected conversation", () => {
    const value = parseDelegateCdpChatReadResult({
      result: { value: {
        url: "https://chatgpt.com/c/chat-cdp-0001",
        title: "CDP History",
        messages: [
          { index: 0, role: "user", text: "hello", text_truncated: false },
          { index: 1, role: "assistant", text: "world", text_truncated: false },
        ],
      } },
    }, "chat-cdp-0001");
    expect(value.title).toBe("CDP History");
    expect(value.messages).toHaveLength(2);
    expect(value.messages[1].text).toBe("world");
  });

  it("fails closed when the evaluated tab changed conversations", () => {
    expect(() => parseDelegateCdpChatReadResult({
      result: { value: {
        url: "https://chatgpt.com/c/chat-cdp-other",
        title: "Other",
        messages: [],
      } },
    }, "chat-cdp-0001")).toThrow("DELEGATE_CDP_CHAT_TARGET_CHANGED");
  });
});

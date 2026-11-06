import { describe, expect, it } from "vitest";
import { openDelegateTabsToHistoryRows } from "../src/core/delegate/historySync.js";

describe("Delegate history open-tab fallback", () => {
  it("extracts only unique ChatGPT conversation tabs without broad browser history", () => {
    expect(openDelegateTabsToHistoryRows({
      tabs: [
        { tabId: 1, title: "One", url: "https://chatgpt.com/c/chat-open-0001", ready: true },
        { tabId: 2, title: "Duplicate", url: "https://chatgpt.com/c/chat-open-0001?x=1", ready: true },
        { tabId: 3, title: "Two", url: "https://chatgpt.com/c/chat-open-0002#anchor", ready: false },
        { tabId: 4, title: "New", url: "https://chatgpt.com/", ready: true },
        { tabId: 5, title: "Foreign", url: "https://example.com/c/chat-open-0003", ready: true },
      ],
    }, 10)).toEqual([
      { chat_id: "chat-open-0001", title: "One", url: "https://chatgpt.com/c/chat-open-0001", tab_id: 1 },
      { chat_id: "chat-open-0002", title: "Two", url: "https://chatgpt.com/c/chat-open-0002", tab_id: 3 },
    ]);
  });


  it("accepts Delegate-CDP list-target arrays from older live extensions", () => {
    expect(openDelegateTabsToHistoryRows([
      { tabId: 11, title: "Live One", url: "https://chatgpt.com/c/live-chat-0001" },
      { tabId: 12, title: "Live Two", url: "https://chatgpt.com/c/live-chat-0002" },
      { tabId: 13, title: "Foreign", url: "https://example.com/" },
    ], 10)).toEqual([
      { chat_id: "live-chat-0001", title: "Live One", url: "https://chatgpt.com/c/live-chat-0001", tab_id: 11 },
      { chat_id: "live-chat-0002", title: "Live Two", url: "https://chatgpt.com/c/live-chat-0002", tab_id: 12 },
    ]);
  });

  it("bounds fallback results", () => {
    expect(openDelegateTabsToHistoryRows({
      tabs: [
        { title: "A", url: "https://chatgpt.com/c/chat-bound-0001" },
        { title: "B", url: "https://chatgpt.com/c/chat-bound-0002" },
      ],
    }, 1)).toHaveLength(1);
  });
});

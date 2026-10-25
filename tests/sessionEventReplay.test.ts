import { describe, expect, it } from "vitest";
import { SessionEventReplay } from "../src/core/utils/sessionEventReplay.js";

describe("session-scoped chat SSE replay", () => {
  it("replays only events from the exact session after the supplied cursor", () => {
    const cache = new SessionEventReplay(4, 4, 1024);
    const a1 = cache.publish("chat-a", JSON.stringify({ sessionId: "chat-a", text: "one" }));
    const b1 = cache.publish("chat-b", JSON.stringify({ sessionId: "chat-b", text: "private" }));
    const a2 = cache.publish("chat-a", JSON.stringify({ sessionId: "chat-a", text: "two" }));
    expect(a1).toContain("id: 1");
    expect(b1).toContain("id: 2");
    expect(cache.since("chat-a", "1")).toEqual([a2]);
    expect(cache.since("chat-b", "0")).toEqual([b1]);
    expect(cache.since("chat-a", "invalid")).toEqual([]);
  });

  it("bounds event history and never replays oversized frames", () => {
    const cache = new SessionEventReplay(2, 2, 120);
    cache.publish("a", '{"text":"1"}');
    const second = cache.publish("a", '{"text":"2"}');
    const third = cache.publish("a", '{"text":"3"}');
    expect(cache.since("a", 0)).toEqual([second, third]);
    const oversized = cache.publish("a", JSON.stringify({ text: "x".repeat(500) }));
    expect(oversized).toContain("id: ");
    expect(cache.since("a", 0)).toEqual([second, third]);
    cache.publish("b", '{"text":"b"}');
    cache.publish("c", '{"text":"c"}');
    expect(cache.since("a", 0)).toEqual([]);
  });
});

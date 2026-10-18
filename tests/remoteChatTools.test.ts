import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getMuseDirectChatReadiness: vi.fn(),
  getMuseWatcher: vi.fn(),
}));

vi.mock("../src/core/remoteAgent/museChatReadiness.js", () => ({
  getMuseDirectChatReadiness: mocks.getMuseDirectChatReadiness,
}));
vi.mock("../src/core/remoteAgent/museWatcherRegistry.js", () => ({
  getMuseWatcher: mocks.getMuseWatcher,
}));

describe("getMuseDirectChatReadinessTool", () => {
  it("returns a concise readiness report", async () => {
    mocks.getMuseDirectChatReadiness.mockResolvedValue({
      ready: true,
      transport: "websocket",
      watcherActive: true,
      watcherConnected: true,
      replyCorrelationSupported: true,
      reason: "ready_for_reply_correlated_chat",
      details: ["Watcher uptime: 10s"],
    });
    mocks.getMuseWatcher.mockReturnValue({
      getStats: () => ({ transport: "websocket", transportDetails: "ws", uptimeSeconds: 10, tasksCompleted: 1, batchesExecuted: 1, activeTaskId: undefined }),
    });

    const { getMuseDirectChatReadinessTool } = await import("../src/core/tools/remoteChatTools.js");
    const result = await getMuseDirectChatReadinessTool.execute({ detailed: true });
    const parsed = JSON.parse(result as string);
    expect(parsed.ready).toBe(true);
    expect(parsed.replyCorrelationSupported).toBe(true);
    expect(parsed.watcherStats.transport).toBe("websocket");
  });
});

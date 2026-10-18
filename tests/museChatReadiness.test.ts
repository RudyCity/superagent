import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getRemoteServiceStatus: vi.fn(),
  getMuseWatcher: vi.fn(),
  isMuseWatcherActive: vi.fn(),
}));

vi.mock("../src/core/remoteAgent/remoteStatusService.js", () => ({
  getRemoteServiceStatus: mocks.getRemoteServiceStatus,
}));
vi.mock("../src/core/remoteAgent/museWatcherRegistry.js", () => ({
  getMuseWatcher: mocks.getMuseWatcher,
  isMuseWatcherActive: mocks.isMuseWatcherActive,
}));

describe("getMuseDirectChatReadiness", () => {
  it("reports ready only for websocket-connected watcher", async () => {
    mocks.getRemoteServiceStatus.mockResolvedValue({
      tunnel: { watcherTransport: "websocket", museConnected: true },
    });
    mocks.isMuseWatcherActive.mockReturnValue(true);
    mocks.getMuseWatcher.mockReturnValue({
      getStats: () => ({ transport: "websocket", transportDetails: "ws", uptimeSeconds: 42, activeTaskId: "task-1" }),
    });

    const { getMuseDirectChatReadiness } = await import("../src/core/remoteAgent/museChatReadiness.js");
    await expect(getMuseDirectChatReadiness()).resolves.toMatchObject({
      ready: true,
      transport: "websocket",
      watcherActive: true,
      watcherConnected: true,
      replyCorrelationSupported: true,
    });
  });

  it("explains why direct chat is not ready", async () => {
    mocks.getRemoteServiceStatus.mockResolvedValue({
      tunnel: { watcherTransport: "telegram", museConnected: false },
    });
    mocks.isMuseWatcherActive.mockReturnValue(false);
    mocks.getMuseWatcher.mockReturnValue(null);

    const { getMuseDirectChatReadiness } = await import("../src/core/remoteAgent/museChatReadiness.js");
    const result = await getMuseDirectChatReadiness();
    expect(result.ready).toBe(false);
    expect(result.details.join(" ")).toContain("Muse watcher is not running");
    expect(result.details.join(" ")).toContain("websocket");
  });
});

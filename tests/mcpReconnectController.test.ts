import { afterEach, describe, expect, it, vi } from "vitest";
import { McpReconnectController } from "../src/core/mcp/mcpReconnectController.js";

afterEach(() => vi.useRealTimers());

describe("MCP bounded reconnect controller", () => {
  it("retries with exponential backoff, resets after success", async () => {
    vi.useFakeTimers();
    const controller = new McpReconnectController(100, 400, 4);
    const attempt = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    expect(controller.schedule("remote", attempt)).toBe(true);
    expect(controller.schedule("remote", attempt)).toBe(false);
    expect(controller.state("remote")).toEqual({ attempts: 1, nextDelayMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(controller.state("remote")).toEqual({ attempts: 2, nextDelayMs: 200 });
    await vi.advanceTimersByTimeAsync(200);
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(controller.state("remote")).toEqual({ attempts: 3, nextDelayMs: 400 });
    await vi.advanceTimersByTimeAsync(400);
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(controller.state("remote")).toEqual({ attempts: 0, nextDelayMs: null });
  });

  it("limits attempts, and cancels pending operations on shutdown", async () => {
    vi.useFakeTimers();
    const controller = new McpReconnectController(50, 200, 2);
    const attempt = vi.fn().mockResolvedValue(false);
    controller.schedule("bad", attempt);
    await vi.advanceTimersByTimeAsync(200);
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(controller.state("bad")).toEqual({ attempts: 2, nextDelayMs: null });
    controller.reset("bad");
    expect(controller.schedule("bad", attempt)).toBe(true);
    controller.cancelAll();
    await vi.advanceTimersByTimeAsync(500);
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it("never schedules stale callbacks after cancellation during an in-flight attempt", async () => {
    vi.useFakeTimers();
    const controller = new McpReconnectController(20, 100, 3);
    let finish!: (value: boolean) => void;
    const pending = new Promise<boolean>((resolve) => { finish = resolve; });
    controller.schedule("server", () => pending);
    await vi.advanceTimersByTimeAsync(20);
    controller.cancelAll();
    finish(false);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(500);
    expect(controller.state("server")).toEqual({ attempts: 0, nextDelayMs: null });
  });
});

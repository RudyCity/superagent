import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { createMcpResponseLease } from "../src/core/mcp/mcpResponseLease.js";

function harness() {
  const response = new EventEmitter() as unknown as Pick<ServerResponse, "once">;
  const released = vi.fn();
  const lease = createMcpResponseLease(response, released);
  return { response: response as unknown as EventEmitter, released, lease };
}

describe("MCP HTTP response and handler lease", () => {
  it("keeps SSE session active after handler resolves until stream closes", () => {
    const h = harness();
    h.lease.handlerResolved();
    expect(h.released).not.toHaveBeenCalled();
    h.response.emit("close");
    expect(h.released).toHaveBeenCalledTimes(1);
  });

  it("keeps tool session active after client disconnects until handler settles", () => {
    const h = harness();
    h.response.emit("close");
    expect(h.released).not.toHaveBeenCalled();
    h.lease.handlerResolved();
    expect(h.released).toHaveBeenCalledTimes(1);
  });

  it("does not double-decrement on close and finish races", () => {
    const h = harness();
    h.response.emit("finish");
    h.response.emit("close");
    expect(h.released).not.toHaveBeenCalled();
    h.lease.handlerResolved();
    h.lease.handlerResolved();
    h.response.emit("close");
    expect(h.released).toHaveBeenCalledTimes(1);
  });

  it("releases on rejected handler even without a writable response", () => {
    const h = harness();
    h.lease.handlerRejected();
    h.response.emit("close");
    expect(h.released).toHaveBeenCalledTimes(1);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { CDP_DIAGNOSTIC_COMMANDS, _cdpDiagnosticsTestHooks, executeCdpDiagnosticsCommand, recordCdpDebugEvent } from "../src/core/tools/chromeCdpDiagnostics.js";

const target = { id: "diag-tab", title: "Fixture", url: "https://example.test/page?token=secret" } as any;

describe("Chrome CDP debug capture", () => {
  beforeEach(() => _cdpDiagnosticsTestHooks.clear());

  it("starts collection and enables console, log, and network domains", async () => {
    const cdpSend = vi.fn().mockResolvedValue({});
    const result = await executeCdpDiagnosticsCommand(cdpSend, target, "start_debug_capture");
    expect(result).toContain("debug capture started");
    expect(result).toContain("https://example.test/page");
    expect(cdpSend).toHaveBeenCalledTimes(3);
    expect(cdpSend.mock.calls.map(call => call[1])).toEqual(["Runtime.enable", "Log.enable", "Network.enable"]);
  });

  it("captures bounded console/network metadata and redacts secrets", async () => {
    await executeCdpDiagnosticsCommand(vi.fn().mockResolvedValue({}), target, "start_debug_capture");
    recordCdpDebugEvent(target.id, "Runtime.consoleAPICalled", { type: "error", args: [{ value: "token=supersecret" }] });
    recordCdpDebugEvent(target.id, "Network.requestWillBeSent", { requestId: "r1", request: { url: "https://example.test/api?token=secret", method: "GET" } });
    recordCdpDebugEvent(target.id, "Network.responseReceived", { requestId: "r1", type: "XHR", response: { url: "https://example.test/api?token=secret", status: 500, mimeType: "application/json" } });
    const result = await executeCdpDiagnosticsCommand(vi.fn().mockResolvedValue({}), target, "read_debug_capture", { limit: 10 });
    expect(result).toContain('"kind": "console"');
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("supersecret");
    expect(result).not.toContain("?token=secret");
    expect(result).toContain('"status": 500');
  });

  it("stops, clears, and bounds retained events", async () => {
    const cdpSend = vi.fn().mockResolvedValue({});
    await executeCdpDiagnosticsCommand(cdpSend, target, "start_debug_capture");
    for (let i = 0; i < 350; i++) recordCdpDebugEvent(target.id, "Runtime.consoleAPICalled", { type: "log", args: [{ value: String(i) }] });
    expect(_cdpDiagnosticsTestHooks.stateFor(target.id).events).toHaveLength(300);
    expect(await executeCdpDiagnosticsCommand(cdpSend, target, "stop_debug_capture")).toContain("stopped");
    recordCdpDebugEvent(target.id, "Runtime.consoleAPICalled", { type: "log", args: [{ value: "ignored" }] });
    expect(_cdpDiagnosticsTestHooks.stateFor(target.id).events).toHaveLength(300);
    await executeCdpDiagnosticsCommand(cdpSend, target, "clear_debug_capture");
    expect(_cdpDiagnosticsTestHooks.stateFor(target.id).events).toHaveLength(0);
    expect(CDP_DIAGNOSTIC_COMMANDS).toContain("read_debug_capture");
  });
});

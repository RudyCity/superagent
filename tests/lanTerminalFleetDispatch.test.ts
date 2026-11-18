import { describe, expect, it, vi } from "vitest";
import { callServerApi } from "../src/core/mcp/tools/processTools.js";
import { dispatchLanMcpTool } from "../src/core/mcp/tools/lanMcpTools.js";

vi.mock("../src/core/mcp/tools/processTools.js", () => ({
  callServerApi: vi.fn(async (_path: string, _method: string, payload: Record<string, unknown>) => ({
    success: true,
    data: { success: true, fleet: { action: payload.action, requested: 2 } },
  })),
}));

const deviceA = "11111111-1111-4111-8111-111111111111";
const deviceB = "22222222-2222-4222-8222-222222222222";
const jobA = "aaaa1111-1111-4111-8111-111111111111";
const jobB = "bbbb2222-2222-4222-8222-222222222222";

describe("MCP fleet dispatch travels through authenticated Core", () => {
  const examples = {
    open: [{ deviceId: deviceA }, { deviceId: deviceB }],
    close: [{ deviceId: deviceA }, { deviceId: deviceB }],
    start: [{ deviceId: deviceA, command: "Get-Date" }, { deviceId: deviceB, command: "Get-Date" }],
    read: [{ deviceId: deviceA, jobId: jobA, cursor: 0 }, { deviceId: deviceB, jobId: jobB, cursor: 15 }],
    input: [{ deviceId: deviceA, jobId: jobA, text: "A" }, { deviceId: deviceB, jobId: jobB, text: "B" }],
    key: [{ deviceId: deviceA, jobId: jobA, key: "Escape" }, { deviceId: deviceB, jobId: jobB, key: "CtrlC" }],
    resize: [{ deviceId: deviceA, jobId: jobA, cols: 80, rows: 24 }, { deviceId: deviceB, jobId: jobB, cols: 100, rows: 30 }],
    stop: [{ deviceId: deviceA, jobId: jobA }, { deviceId: deviceB, jobId: jobB }],
  };
  it("routes all eight aliases to the same exact Core action, without leaking credentials", async () => {
    const mocked = vi.mocked(callServerApi);
    for (const [action, targets] of Object.entries(examples)) {
      mocked.mockClear();
      const response = await dispatchLanMcpTool("superagent_device_terminal_fleet_" + action, { targets });
      expect(response?.isError).not.toBe(true);
      expect(mocked).toHaveBeenCalledOnce();
      const [path, method, body, timeout] = mocked.mock.calls[0];
      expect(path).toBe("/api/desktop/lan-support");
      expect(method).toBe("POST");
      expect(body).toEqual({ action: "terminal_fleet_" + action, targets });
      expect(timeout).toBeGreaterThanOrEqual(action === "start" || action === "input" || action === "key" || action === "open" ? 125_000 : 15_000);
      expect(JSON.stringify(body)).not.toMatch(/sessionToken|pairToken|controllerToken/);
    }
  });
});

import { describe, expect, it } from "vitest";
import { DesktopTerminalManager } from "../src/core/runtime/desktopTerminalManager.js";
import { parseExternalProcessSnapshot } from "../src/core/runtime/externalTerminalProcesses.js";

describe("external Windows terminal process observation", () => {
  it("accepts only listener-bearing development runtimes, deduplicates PIDs and ports", () => {
    const entries = parseExternalProcessSnapshot([
      { ProcessId: 14456, Name: "bun.exe", Ports: [7001, 7001, 443, -1] },
      { ProcessId: 14456, Name: "bun.exe", Ports: [7002, 7001] },
      { ProcessId: 31320, Name: "rudy.exe", Ports: [7105] },
      { ProcessId: 22040, Name: "wslrelay.exe", Ports: [5432] },
      { ProcessId: 8, Name: "node.exe", Ports: [0, 123] },
      { ProcessId: 0, Name: "bun.exe", Ports: [7101] },
    ]);
    expect(entries).toEqual([
      { pid: 14456, name: "bun.exe", ports: [7001, 7002] },
      { pid: 31320, name: "rudy.exe", ports: [7105] },
    ]);
  });

  it("does not retain any raw command lines, arguments or environment secrets", () => {
    const input = [{
      ProcessId: 53,
      Name: "node.exe",
      Ports: 7100,
      CommandLine: "node server.js --token ultra-secret-value",
      Environment: { OPENAI_API_KEY: "ultra-secret-value" },
    }];
    const entries = parseExternalProcessSnapshot(input);
    expect(entries).toEqual([{ pid: 53, name: "node.exe", ports: [7100] }]);
    expect(JSON.stringify(entries)).not.toContain("ultra-secret-value");
  });

  it("bounds extremely large inventories and invalid port values", () => {
    const entries = parseExternalProcessSnapshot(Array.from({ length: 400 }, (_, i) => ({
      ProcessId: 100 + i,
      Name: "bun.exe",
      Ports: [2000 + i, 2000 + i, 99999, "bad"],
    })));
    expect(entries).toHaveLength(64);
    expect(entries.every((p) => p.ports.length === 1)).toBe(true);
    expect(parseExternalProcessSnapshot({ ProcessId: 0, Name: "bun.exe", Ports: [7001] })).toEqual([]);
  });

  it("does not allow a discovered PID to be killed without an owned process handle", () => {
    const result = DesktopTerminalManager.killTask("external-win-31320");
    expect(result.success).toBe(false);
    expect(result.error).toContain("no live owned process handle");
  });
});

import { describe, expect, it } from "vitest";
import { buildTlineCapabilityManifest, TLINE_HTTP_ACTIONS } from "../src/core/channels/tlineCapabilities.js";

describe("authenticated T-Line capability contract", () => {
  it("reports the actual registered CLI command names, not an invented desktop action", () => {
    const m = buildTlineCapabilityManifest("1.14.8");
    expect(m.server).toBe("superagent");
    expect(m.schemaVersion).toBe(1);
    expect(m.commands.find(c => c.name === "daemon")).toBeDefined();
    expect(m.commands.find(c => c.name === "gateway")).toBeDefined();
    expect(m.commands.every(c => c.desktopExecution === "cli-only")).toBe(true);
  });
  it("exposes only explicitly safe read-only HTTP operations", () => {
    expect(TLINE_HTTP_ACTIONS.map(a => a.id)).toEqual(["daemon.status", "gateway.status"]);
    expect(TLINE_HTTP_ACTIONS.every(a => a.method === "GET" && a.access === "read")).toBe(true);
  });
});

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
  it("separates safe read-only HTTP operations from explicit workspace-operator actions", () => {
    const readOnly = TLINE_HTTP_ACTIONS.filter(a => a.access === "read");
    expect(readOnly.map(a => a.id)).toEqual([
      "daemon.status", "gateway.status", "studio.status", "studio.projects",
    ]);
    expect(readOnly.every(a => a.method === "GET")).toBe(true);
    expect(TLINE_HTTP_ACTIONS.find(a => a.id === "studio.bundle")).toMatchObject({
      method: "POST", access: "workspace-operator",
    });
  });
});

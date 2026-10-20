import { describe, expect, it } from "vitest";
import { TLINE_INSPECTION_ACTIONS, sameMuseWorkspace, summarizeMcpServers, summarizeMuse,
  summarizeSelfdev, summarizeTools } from "../src/core/channels/tlineInspection.js";
import { buildTlineCapabilityManifest } from "../src/core/channels/tlineCapabilities.js";

describe("T-Line workspace-scoped inspection projections", () => {
  it("advertises read-only inspection actions separately from CLI commands", () => {
    const ids = TLINE_INSPECTION_ACTIONS.map(a => a.id);
    expect(ids).toEqual(["mcp.status", "tools.catalog", "selfdev.status", "muse.status", "tasks.snapshot"]);
    expect(TLINE_INSPECTION_ACTIONS.every(a => a.method === "GET" && a.access === "read")).toBe(true);
    expect(buildTlineCapabilityManifest("test").httpActions.map(a => a.id)).toEqual(
      expect.arrayContaining(ids));
  });

  it("returns only sanitized MCP connectivity metadata, never credentials or launch args", () => {
    const servers = { privateRepo: { transport: "stdio", disabled: false,
      command: "TOKEN=SECRET123", env: { PASSWORD: "SECRET456" }, url: "https://secret.invalid" } };
    const connections = new Map([["privaterepo", {
      status: "connected", tools: ["read", "search"], error: "token=SECRET789",
    }]]);
    const output = summarizeMcpServers(servers, connections);
    expect(output.servers[0]).toEqual({
      name: "privateRepo", transport: "stdio", disabled: false,
      status: "connected", toolCount: 2,
    });
    expect(JSON.stringify(output)).not.toMatch(/SECRET|PASSWORD|command|url|env|error/);
    expect(output.scope).toBe("runtime-global");
  });

  it("returns only names of tools without argument schemas or descriptions", () => {
    const output = summarizeTools([{ name: "read_file", input_schema: { privateToken: "SECRET" } },
      { name: "browser" }] as any);
    expect(output.tools).toEqual(["read_file", "browser"]);
    expect(JSON.stringify(output)).not.toContain("SECRET");
  });

  it("never leaks another workspace's Muse task or bot secrets", () => {
    const cfg = { asRunner: true, transport: "websocket", botToken: "SECRET",
      wsRemoteUrl: "wss://private.example" };
    const active = { taskId: "task-private", sessionId: "sess-private",
      workspace: "C:/private", startedAt: 3 };
    expect(summarizeMuse("C:/public", cfg, active, true).activeTask).toBeNull();
    const self = summarizeMuse("C:/private", cfg, active, true);
    expect(self.activeTask?.taskId).toBe("task-private");
    expect(self.activeTask?.evidence).toBe("unverified");
    expect(JSON.stringify(self)).not.toContain("SECRET");
    expect(JSON.stringify(self)).not.toContain("wss://");
    expect(sameMuseWorkspace("C:/private", "C:/private")).toBe(true);
  });

  it("keeps selfdev status bounded to safe workspace counters", () => {
    const out = summarizeSelfdev({ enabled: true, userOptOut: false,
      configVersion: 2, eventCount: 4,
      storageAvailable: true, lessonCounts: { candidate: 1, active: 2, retired: 0 },
      token: "SECRET" } as any);
    expect(out.scope).toBe("workspace");
    expect(out.lessonCounts.active).toBe(2);
    expect(JSON.stringify(out)).not.toContain("SECRET");
  });
});

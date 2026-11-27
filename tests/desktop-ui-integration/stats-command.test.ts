import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { desktopUiTool } from "../../src/core/tools/desktopUiTools.js";
import { DESKTOP_UI_MCP_TOOL_DEFS, dispatchDesktopUiMcpTool } from "../../src/core/mcp/tools/desktopUiMcpTools.js";
import { registeredFileToolGate } from "../../src/core/tools/registeredFileToolGate.js";
import { isReadOnlyDesktopUiCall } from "../../src/core/desktopUi/desktopUiPolicy.js";
import { resetDesktopUiMetrics } from "../../src/core/desktopUi/desktopUiMetrics.js";
import type { ExecutableIdentity, PersistentAccessPolicy } from "../../src/core/desktopUi/persistentAccessPolicy.js";

const identity: ExecutableIdentity = {
  platform: "win32",
  executablePath: "C:\\Apps\\Stats\\stats.exe",
  sha256: "e".repeat(64),
};

const activePolicy: PersistentAccessPolicy = { version: 2, defaultEffect: "deny", rules: [] };

const roots: string[] = [];

function workspace(): string {
  const raw = fs.mkdtempSync(path.join(os.tmpdir(), "sa-desktop-ui-stats-"));
  roots.push(raw);
  return fs.realpathSync.native(raw);
}

afterEach(() => {
  resetDesktopUiMetrics();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("desktop UI stats command", () => {
  it("is classified as read-only and exposed by both tool schemas", () => {
    expect(isReadOnlyDesktopUiCall({ command: "stats" })).toBe(true);
    expect(desktopUiTool.parameters.properties.command.enum).toContain("stats");
    expect(desktopUiTool.parameters.properties.action.enum).toContain("stats");
    const schema = DESKTOP_UI_MCP_TOOL_DEFS[0].inputSchema;
    expect(schema.properties.command.enum).toContain("stats");
    expect(schema.properties.action.enum).toContain("stats");
  });

  it("returns bounded in-process JSON from the local desktop_ui tool", async () => {
    const result = JSON.parse(await desktopUiTool.execute({ command: "stats" }, workspace()));
    expect(result.success).toBe(true);
    expect(result.stats.version).toBe(1);
    expect(result.stats.counters).toMatchObject({ snapshotsTotal: expect.any(Number) });
    expect(Array.isArray(result.stats.histograms.snapshotLatencyMs.buckets)).toBe(true);

    // Read-only payload: no bearer tokens, titles, paths or image bytes.
    const text = JSON.stringify(result);
    for (const forbidden of ["sessionToken", "leaseToken", "screenshotImage", "title", "nativeId", "pid"]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it("accepts the action spelling on the local tool", async () => {
    const result = JSON.parse(await desktopUiTool.execute({ action: "stats" }, workspace()));
    expect(result.success).toBe(true);
    expect(result.stats.version).toBe(1);
  });

  it("returns bounded stats through the MCP dispatcher", async () => {
    const result = await dispatchDesktopUiMcpTool(
      "superagent_desktop_ui",
      { command: "stats" },
      { principalId: "principal-stats", workspace: workspace() },
    );
    expect(result?.isError).not.toBe(true);
    const payload = JSON.parse(String((result?.content[0] as { text: string }).text));
    expect(payload.success).toBe(true);
    expect(payload.stats).toMatchObject({
      version: 1,
      counters: expect.any(Object),
      histograms: expect.any(Object),
      last: expect.any(Object),
    });
    expect(typeof payload.stats.uptimeMs).toBe("number");
  });

  it("stays a local-only command through MCP", async () => {
    const result = await dispatchDesktopUiMcpTool(
      "superagent_desktop_ui",
      { command: "stats" },
      { principalId: "principal-stats", workspace: "ssh://remote/host" },
    );
    const payload = JSON.parse(String((result?.content[0] as { text: string }).text));
    expect(payload).toMatchObject({ success: false, code: "LOCAL_HOST_REQUIRED" });
  });

  it("is allowed by the host file gate under an active policy and rejects extra fields", () => {
    const root = workspace();
    const opts = { registry: () => activePolicy, identity: async () => identity };
    expect(registeredFileToolGate(
      { name: "superagent_desktop_ui", args: { command: "stats" } }, root, opts,
    )).toBeNull();
    expect(registeredFileToolGate(
      { name: "superagent_desktop_ui", args: { command: "stats", limit: 5 } }, root, opts,
    )).toMatch(/unsupported arguments/);
  });
});

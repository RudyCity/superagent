import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { describeBoundedServicePermission } from "../src/core/mcp/mcpPermissionDecision.js";
import { dispatchServiceManagerMcpTool } from "../src/core/mcp/tools/serviceManagerMcpTools.js";
import { validateManageServicesArgs, manageServices } from "../src/core/runtime/serviceManager.js";
import { timelineFile } from "../src/core/runtime/lifecycleTimeline.js";
import { registeredFileToolGate } from "../src/core/tools/registeredFileToolGate.js";
import { createSuperagentMcpServer } from "../src/core/mcp/superagentMcpServer.js";
import { getRootConfigDir } from "../src/core/config/paths.js";

const hostOptions = {
  registry: () => ({ version: 2 as const, defaultEffect: "deny" as const, rules: [] }),
  identity: () => ({ platform: "win32" as const, executablePath: "C:\\runtime\\superagent.exe", sha256: "a".repeat(64) }),
};

const malformed: Record<string, unknown>[] = [
  { action: ["status"] },
  { action: { toString: () => "status" } },
  { action: null },
  { action: 1 },
  { action: "status", service: ["tray"] },
  { action: "status", service: "foreign_service" },
  { action: "status", limit: 0 },
  { action: "status", limit: 201 },
  { action: "status", limit: 1.3 },
  { action: "status", port: "7888" },
  { action: "status", port: 1023 },
  { action: "status", confirm: true },
  { action: "restart", service: "tray" },
  { action: "status", expectedExecutablePath: "PRIVATE_PATH_DO_NOT_ECHO" },
];

describe("service permission preflight and production validation parity", () => {
  it("supports owner attestation for default and all targets", () => {
    for (const service of [undefined, "all", "tray"] as const) {
      const args = { action: "owner_status", ...(service ? { service } : {}) };
      expect(describeBoundedServicePermission(args, true).decisionCode).toBe("ALLOWED_TO_ATTEMPT");
      expect(validateManageServicesArgs(args)).toMatchObject(args);
    }
  });

  it("certifies the documented default status with no lifecycle or content fields", () => {
    for (const args of [{}, { service: "tray" }, { action: "status" }, { action: "owner_status", service: "all" }]) {
      expect(describeBoundedServicePermission(args, true).decisionCode).toBe("ALLOWED_TO_ATTEMPT");
      expect(registeredFileToolGate({ name: "superagent_services_status", args }, process.cwd(), hostOptions)).toBeNull();
    }
    expect(registeredFileToolGate({ name: "superagent_manage_services", args: {} }, process.cwd(), hostOptions)).not.toBeNull();
  });

  it.each(malformed)("denies malformed status consistently without reflecting arguments: %j", async (args) => {
    expect(describeBoundedServicePermission(args, true).decisionCode).toBe("SCHEMA_INVALID");
    expect(registeredFileToolGate({ name: "superagent_services_status", args }, process.cwd(), hostOptions)).not.toBeNull();
    const result = await dispatchServiceManagerMcpTool("superagent_services_status", args);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_PATH_DO_NOT_ECHO");
  });

  it("rejects enum coercions in mixed-mode lifecycle validation", () => {
    for (const args of [
      { action: ["status"], service: "tray" },
      { action: "plan", service: "tray", targetAction: ["stop"] },
      { action: "recycle", service: "core", clientMode: ["tline"] },
      { action: "plan", service: "channel_host", channelMode: ["idle"] },
    ]) expect(() => validateManageServicesArgs(args)).toThrow();
  });

  it("keeps owner_status free of lifecycle journal mutations", async () => {
    const journal = timelineFile();
    const before = fs.existsSync(journal) ? fs.readFileSync(journal, "utf8") : null;
    const result = await manageServices({ action: "owner_status", service: "process_supervisor" }) as Record<string, unknown>;
    expect(result.action).toBe("owner_status");
    const after = fs.existsSync(journal) ? fs.readFileSync(journal, "utf8") : null;
    expect(after).toBe(before);
    expect(fs.existsSync(path.join(path.dirname(journal), "lifecycle-events.jsonl.guard"))).toBe(false);
  });

  it("keeps service shape enforcement identical through direct and gateway dispatch", async () => {
    fs.writeFileSync(path.join(getRootConfigDir(), "desktop-access-registry.json"),
      JSON.stringify({ version: 2, defaultEffect: "deny", rules: [] }));
    const server = createSuperagentMcpServer({ toolExposure: "gateway", authMode: "oauth",
      getIdentity: () => ({ mode: "oauth", subject: "service-reader", scopes: ["mcp:tools"] }) });
    const call = (server as any)._requestHandlers.get("tools/call");
    const invoke = (gateway: boolean, args: Record<string, unknown>) => call({
      method: "tools/call", params: gateway
        ? { name: "superagent_tool_execute", arguments: { name: "superagent_services_status", arguments: args } }
        : { name: "superagent_services_status", arguments: args },
    });
    try {
      for (const gateway of [false, true]) {
        const result = await invoke(gateway, { action: "logs", service: "all", limit: 1 });
        expect(result.isError).not.toBe(true);
        expect(JSON.parse(result.content[0].text)).toMatchObject({ action: "logs", readOnly: true });
        for (const args of [
          { action: ["status"] },
          { action: "status", expectedExecutablePath: "PRIVATE_PATH_DO_NOT_ECHO" },
          { action: "restart", service: "tray", confirm: true },
        ]) {
          const denied = await invoke(gateway, args);
          expect(denied.isError).toBe(true);
          expect(JSON.stringify(denied)).toMatch(/not certified/);
          expect(JSON.stringify(denied)).not.toContain("PRIVATE_PATH_DO_NOT_ECHO");
        }
      }
    } finally { await server.close(); }
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import { createSuperagentMcpServer } from "../../src/core/mcp/superagentMcpServer.js";
import { desktopUiSessionManager } from "../../src/core/tools/desktopUiTools.js";
import { onMcpActivity } from "../../src/core/mcp/mcpActivityBus.js";
import { setYoloMode } from "../../src/core/permissions.js";

afterEach(() => {
  setYoloMode(false);
  vi.restoreAllMocks();
});

describe("privileged desktop caller data cannot enter telemetry", () => {
  it("redacts top-level and nested operator secrets, installer paths, and app titles", async () => {
    setYoloMode(true);
    const credentialHash = crypto.randomBytes(32).toString("hex");
    const audits: any[] = [];
    const activity: any[] = [];
    const unsubscribe = onMcpActivity((entry) => activity.push(entry));
    const server = createSuperagentMcpServer({
      toolExposure: "full",
      allowDangerous: true,
      authMode: "static-bearer",
      getIdentity: () => ({ mode: "static-bearer", subject: "operator-test", credentialHash }),
      onToolCall: (entry) => audits.push(entry),
    });
    vi.spyOn(desktopUiSessionManager, "probe").mockResolvedValue({
      platform: "win32",
      available: true,
      screenshot: true,
      accessibility: true,
      input: false,
      scroll: false,
      prerequisites: [],
      limitations: [],
      errors: [],
    });
    const secrets = ["uniqueApprovalCode777", "uniqueOperatorProof888", "uniqueExecutablePath999", "uniquePrivateTitle333"];
    try {
      const handler = (server as any)._requestHandlers.get("tools/call");
      await expect(handler({
        method: "tools/call",
        params: {
          name: "superagent_desktop_ui",
          arguments: {
            command: "probe",
            approvalToken: secrets[0],
            nested: { operatorProof: secrets[1], installerPath: secrets[2] },
            title: secrets[3],
          },
        },
      })).rejects.toThrow(/MCP_APPROVAL_REQUIRED/);
      expect(audits.length).toBeGreaterThan(0);
      for (const event of [...audits, ...activity]) {
        const record = JSON.stringify(event);
        for (const secret of secrets) expect(record).not.toContain(secret);
      }
    } finally {
      unsubscribe();
      await server.close();
    }
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
    const prevConfig = process.env.SUPERAGENT_CONFIG_DIR;
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sa-priv-args-"));
    const ws = path.join(tempRoot, "ws");
    fs.mkdirSync(ws, { recursive: true });
    process.env.SUPERAGENT_CONFIG_DIR = tempRoot;
    setYoloMode(true);
    const credentialHash = crypto.randomBytes(32).toString("hex");
    const audits: any[] = [];
    const activity: any[] = [];
    const unsubscribe = onMcpActivity((entry) => activity.push(entry));
    const server = createSuperagentMcpServer({
      toolExposure: "full",
      allowDangerous: true,
      authMode: "static-bearer",
      workspace: ws,
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
      })).rejects.toThrow(/PROJECT_GRANT_MISSING/);
      expect(audits.length).toBeGreaterThan(0);
      for (const event of [...audits, ...activity]) {
        const record = JSON.stringify(event);
        for (const secret of secrets) expect(record).not.toContain(secret);
      }
    } finally {
      unsubscribe();
      await server.close();
      if (prevConfig === undefined) delete process.env.SUPERAGENT_CONFIG_DIR;
      else process.env.SUPERAGENT_CONFIG_DIR = prevConfig;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

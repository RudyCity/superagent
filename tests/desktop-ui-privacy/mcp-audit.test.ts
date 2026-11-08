import { afterEach, describe, expect, it, vi } from "vitest";
import { createSuperagentMcpServer } from "../../src/core/mcp/superagentMcpServer.js";
import { MCP_GATEWAY_TOOL_NAMES } from "../../src/core/mcp/mcpToolGateway.js";
import { onMcpActivity } from "../../src/core/mcp/mcpActivityBus.js";
import { setYoloMode } from "../../src/core/permissions.js";
import { desktopUiSessionManager } from "../../src/core/tools/desktopUiTools.js";

const privateTitle = "Private-Window-Document";
const privateQuery = "Private-Search-Text";

async function invoke(server: ReturnType<typeof createSuperagentMcpServer>,
  name: string, args: Record<string, unknown>) {
  const call = (server as any)._requestHandlers.get("tools/call");
  return call({ method: "tools/call", params: { name, arguments: args } });
}

afterEach(() => {
  vi.restoreAllMocks();
  setYoloMode(false);
});

describe("desktop MCP activity privacy", () => {
  for (const routed of [false, true]) {
    it(routed ? "redacts gateway-routed desktop output and caller arguments" :
      "redacts directly invoked desktop output and caller arguments", async () => {
      setYoloMode(true);
      const audit: any[] = [];
      const activity: any[] = [];
      const unsubscribe = onMcpActivity((event) => activity.push(event));
      const server = createSuperagentMcpServer({
        toolExposure: routed ? "gateway" : "full",
        allowDangerous: true,
        authMode: "static-bearer",
        getIdentity: () => ({
          mode: "static-bearer", subject: "privacy-test", credentialHash: "privacy-credential-hash",
        }),
        onToolCall: (event) => audit.push(event),
      });
      try {
        vi.spyOn(desktopUiSessionManager, "probe").mockResolvedValue({
          platform: "win32",
          available: false,
          screenshot: false,
          accessibility: false,
          input: false,
          scroll: false,
          prerequisites: [],
          limitations: [],
          errors: [privateTitle],
        });

        const nested = { command: "probe", title: privateTitle, query: privateQuery };
        const result = await invoke(server,
          routed ? MCP_GATEWAY_TOOL_NAMES.execute : "superagent_desktop_ui",
          routed ? { name: "superagent_desktop_ui", arguments: nested } : nested);
        expect(result.isError).not.toBe(true);
        expect(JSON.stringify(result)).toContain(privateTitle);

        const desktopEvents = audit.filter((event) =>
          event.tool === "superagent_desktop_ui" ||
          event.tool === MCP_GATEWAY_TOOL_NAMES.execute);
        expect(desktopEvents.length).toBeGreaterThan(0);
        for (const event of desktopEvents) {
          const serialized = JSON.stringify(event.args);
          expect(serialized).not.toContain(privateTitle);
          expect(serialized).not.toContain(privateQuery);
        }
        const activityEvents = activity.filter((event) =>
          event.type === "tool_call" &&
          (event.tool === "superagent_desktop_ui" ||
            event.tool === MCP_GATEWAY_TOOL_NAMES.execute));
        expect(activityEvents.length).toBeGreaterThan(0);
        for (const event of activityEvents) {
          const serialized = JSON.stringify({ args: event.args, output: event.output, error: event.error });
          expect(serialized).not.toContain(privateTitle);
          expect(serialized).not.toContain(privateQuery);
        }
      } finally {
        unsubscribe();
        await server.close();
      }
    });
  }
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { controlChromeVisionTool } from "../src/core/tools/chromeVisionTools.js";
import { delegateCdpTransport } from "../src/core/delegate/cdpTransport.js";

afterEach(() => vi.restoreAllMocks());

describe("control_chrome_vision dual transport", () => {
  it("keeps managed default and exposes bounded transport selectors", async () => {
    const props: any = (controlChromeVisionTool.parameters as any).properties;
    expect(props.transport.enum).toEqual(["managed", "delegate", "auto"]);
    expect(props.delegateClientId).toBeTruthy();
    expect(props.delegateTabId).toBeTruthy();

    const { CHROME_MCP_TOOL_DEFS } = await import("../src/core/mcp/tools/chromeMcpTools.js");
    const def: any = CHROME_MCP_TOOL_DEFS.find((item: any) => item.name === "superagent_chrome_vision");
    expect(def.inputSchema.properties.transport.enum).toEqual(["managed", "delegate", "auto"]);
  });

  it("reports Delegate vision status without probing managed Chrome", async () => {
    const health = vi.spyOn(delegateCdpTransport, "health").mockResolvedValue({
      ok: true, kind: "delegate", connectionId: "chrome-new-001", detail: "{}",
    });
    const result = await controlChromeVisionTool.execute({
      command: "status",
      transport: "delegate",
      delegateClientId: "chrome-new-001",
    }, process.cwd());
    expect(health).toHaveBeenCalledWith("chrome-new-001");
    expect(result).toContain("Chrome Delegate-CDP");
    expect(result).toContain("connected");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { controlChromeCdpTool } from "../src/core/tools/chromeCdpTools.js";
import { delegateCdpTransport, executeDelegateChromeCommand } from "../src/core/delegate/cdpTransport.js";
import { delegateBridge } from "../src/core/delegate/bridge.js";
import { managedCdpTransport } from "../src/core/browserTransport/managedCdpTransport.js";

afterEach(() => vi.restoreAllMocks());

describe("control_chrome_cdp dual transport", () => {
  it("advertises bounded transport selectors in agent and MCP schemas", async () => {
    const props: any = (controlChromeCdpTool.parameters as any).properties;
    expect(props.transport.enum).toEqual(["managed", "delegate", "auto"]);
    expect(props.delegateClientId).toBeTruthy();
    expect(props.delegateTabId).toBeTruthy();
    const { CHROME_MCP_TOOL_DEFS } = await import("../src/core/mcp/tools/chromeMcpTools.js");
    const def: any = CHROME_MCP_TOOL_DEFS.find((item: any) => item.name === "superagent_chrome_cdp");
    expect(def.inputSchema.properties.transport.enum).toEqual(["managed", "delegate", "auto"]);
  });

  it("explicit Delegate list_targets never needs the managed CDP endpoint", async () => {
    vi.spyOn(delegateCdpTransport, "listTargets").mockResolvedValue([{
      kind: "delegate", connectionId: "chrome-work-001", targetId: "tab:55", tabId: 55,
      title: "Logged in", url: "https://example.com/app",
    }]);
    const result = await controlChromeCdpTool.execute({
      command: "list_targets", transport: "delegate", delegateClientId: "chrome-work-001",
    }, process.cwd());
    expect(result).toContain("delegate:chrome-work-001:55");
    expect(result).toContain("transport: delegate");
  });

  it("auto list_targets returns backend-qualified IDs from both transports", async () => {
    vi.spyOn(managedCdpTransport, "listTargets").mockResolvedValue([{
      kind: "managed", connectionId: "9222", targetId: "MANAGED_1", title: "Managed", url: "https://managed.example/",
    }]);
    vi.spyOn(delegateCdpTransport, "listTargets").mockResolvedValue([{
      kind: "delegate", connectionId: "chrome-work-001", targetId: "tab:55", tabId: 55, title: "Delegate", url: "https://delegate.example/",
    }]);
    const result = JSON.parse(await controlChromeCdpTool.execute({
      command: "list_targets", transport: "auto",
    }, process.cwd()));
    expect(result.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ transport: "managed", targetId: "managed:9222:MANAGED_1" }),
      expect.objectContaining({ transport: "delegate", targetId: "delegate:chrome-work-001:55" }),
    ]));
  });

  it("auto mutation without a qualified backend fails closed", async () => {
    const result = await controlChromeCdpTool.execute({
      command: "navigate", transport: "auto", url: "https://example.com",
    }, process.cwd());
    expect(result).toContain("BROWSER_TRANSPORT_AMBIGUOUS");
  });

  it("fails closed when more than one Delegate profile is available for a mutation", async () => {
    vi.spyOn(delegateBridge, "listConnections").mockReturnValue([
      { clientId: "chrome-one-001", label: "One", extensionId: "a".repeat(32), extensionVersion: "1.8.0", capabilities: ["delegate-cdp-v1"], connectedAt: Date.now() },
      { clientId: "chrome-two-001", label: "Two", extensionId: "b".repeat(32), extensionVersion: "1.8.0", capabilities: ["delegate-cdp-v1"], connectedAt: Date.now() },
    ]);
    await expect(executeDelegateChromeCommand("navigate", {}, { url: "https://example.com" }))
      .rejects.toMatchObject({ code: "DELEGATE_MULTIPLE_CLIENTS" });
  });

  it("fails closed when one Delegate profile has multiple candidate tabs for a mutation", async () => {
    vi.spyOn(delegateBridge, "listConnections").mockReturnValue([
      { clientId: "chrome-one-001", label: "One", extensionId: "a".repeat(32), extensionVersion: "1.8.0", capabilities: ["delegate-cdp-v1"], connectedAt: Date.now() },
    ]);
    vi.spyOn(delegateCdpTransport, "listTargets").mockResolvedValue([
      { kind: "delegate", connectionId: "chrome-one-001", targetId: "tab:1", tabId: 1, title: "A", url: "https://a.example" },
      { kind: "delegate", connectionId: "chrome-one-001", targetId: "tab:2", tabId: 2, title: "B", url: "https://b.example" },
    ]);
    await expect(executeDelegateChromeCommand("navigate", {}, { url: "https://example.com" }))
      .rejects.toMatchObject({ code: "DELEGATE_CDP_TARGET_AMBIGUOUS" });
  });
});

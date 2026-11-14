import { describe, expect, it } from "vitest";
import {
  sanitizeDesktopUiLogPayload, sanitizeDesktopUiLogText,
} from "../../src/core/tools/desktopUiTools.js";
import { dispatchDesktopUiMcpTool } from "../../src/core/mcp/tools/desktopUiMcpTools.js";

describe("agent-owned Desktop Live stop capabilities remain private",()=>{
  const token="abcdef0123456789".repeat(4);
  it("redacts leaseToken from structured and text logs",()=>{
    const entry=sanitizeDesktopUiLogPayload({
      command:"live_stop",leaseToken:token,liveId:"native:123:456",
    });
    expect(JSON.stringify(entry)).not.toContain(token);
    expect(entry.leaseToken).toBe("[REDACTED_TOKEN]");
    expect(sanitizeDesktopUiLogText('leaseToken='+token)).not.toContain(token);
    expect(sanitizeDesktopUiLogText(JSON.stringify({leaseToken:token}))).not.toContain(token);
  });
  it("denies anonymous agents, missing lease, and unexpected extra fields",async()=>{
    const missing=await dispatchDesktopUiMcpTool("superagent_desktop_ui",
      {command:"live_stop",liveId:"native:123:456"});
    expect(missing?.isError).toBe(true);
    const noOwner=await dispatchDesktopUiMcpTool("superagent_desktop_ui",
      {command:"live_stop",liveId:"native:123:456"},
      {principalId:"authorized-test-agent",workspace:process.cwd()});
    expect(noOwner?.isError).toBe(true);
    const extra=await dispatchDesktopUiMcpTool("superagent_desktop_ui",
      {command:"live_inventory",leaseToken:token},
      {principalId:"authorized-test-agent",workspace:process.cwd()});
    expect(extra?.isError).toBe(true);
  });
});

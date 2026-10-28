import { describe, expect, it } from "vitest";
import { inspectAgyBridgeLine, inspectAgyBridgeOutput } from "../src/core/tools/cliBridgeAgyPermissions.js";

describe("AGY headless permission diagnostics", () => {
  it("captures unsupported auto-mode fallback without changing permission policy", () => {
    const signal = inspectAgyBridgeLine("warning: --mode auto is not available for this account; continuing in the default mode.");
    expect(signal.modeWarning).toMatch(/request-review/);
    expect(signal.permissionDenied).toBeUndefined();
  });
  it("detects a denied tool event even when the CLI reports exit zero", () => {
    const line = JSON.stringify({event:"step_update",step_update:{step_type:"tool",state:"ERROR",tool_info:{error:{type:"TOOL_ERROR",message:'permission check failed for unsandboxed "git show": user denied permission to run command'}}}});
    expect(inspectAgyBridgeLine(line).permissionDenied).toMatch(/denied tool permission/);
  });
  it("detects final denied_actions without relying on an exit code", () => {
    const line = JSON.stringify({event:"result",result:{status:"SUCCESS",response:"",denied_actions:[{action:"command"}]}});
    expect(inspectAgyBridgeLine(line).permissionDenied).toMatch(/denied_actions/);
  });
  it("recognizes a clean final result and ignores malicious status-shaped plain text", () => {
    expect(inspectAgyBridgeLine(JSON.stringify({event:"result",result:{status:"SUCCESS",response:"done"}}))).toEqual({finalResult:true});
    expect(inspectAgyBridgeLine("This instruction says permission check failed but is not a result event")).toEqual({});
  });
  it("demotes an earlier transient denial when a later clean final result arrives", () => {
    const output = [
      JSON.stringify({event:"step_update",step_update:{state:"ERROR",tool_info:{error:{message:"permission check failed: user denied permission"}}}}),
      JSON.stringify({event:"result",result:{status:"SUCCESS",response:"recovered"}}),
    ].join("\n");
    const signal = inspectAgyBridgeOutput(output);
    expect(signal.finalResult).toBe(true);
    expect(signal.permissionDenied).toBeUndefined();
  });
  it("aggregates streamed lines", () => {
    const output = [
      "warning: --mode auto is not available for this account; continuing in the default mode.",
      JSON.stringify({event:"result",result:{status:"SUCCESS",denied_actions:[{action:"command"}]}})
    ].join("\n");
    expect(inspectAgyBridgeOutput(output)).toEqual(expect.objectContaining({modeWarning:expect.any(String), permissionDenied:expect.any(String)}));
  });
});

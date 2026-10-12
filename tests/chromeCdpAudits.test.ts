import { describe, expect, it, vi } from "vitest";
import { CDP_AUDIT_COMMANDS, executeCdpAuditCommand } from "../src/core/tools/chromeCdpAudits.js";

const target = { id: "tab-1", title: "Fixture page", url: "https://example.test/" } as any;

describe("Chrome CDP page audit commands", () => {
  it("exposes all five structured audit commands", () => {
    expect(CDP_AUDIT_COMMANDS).toEqual([
      "page_audit",
      "accessibility_audit",
      "seo_audit",
      "responsive_audit",
      "performance_metrics",
    ]);
  });

  it.each(CDP_AUDIT_COMMANDS)("executes %s through Runtime.evaluate and formats structured output", async (command) => {
    const cdpSend = vi.fn().mockResolvedValue({ result: { value: { ok: true, title: "Fixture" } } });
    const output = await executeCdpAuditCommand(cdpSend, target, command);
    expect(cdpSend).toHaveBeenCalledWith(target, "Runtime.evaluate", expect.objectContaining({
      returnByValue: true,
      awaitPromise: true,
      expression: expect.any(String),
    }));
    expect(output).toContain(command);
    expect(output).toContain('"ok": true');
  });

  it("bounds report output and reports page-side exceptions clearly", async () => {
    const large = vi.fn().mockResolvedValue({ result: { value: { payload: "x".repeat(3000) } } });
    const output = await executeCdpAuditCommand(large, target, "page_audit", { max_chars: 500 });
    expect(output.length).toBeLessThan(900);
    expect(output).toContain("truncated");

    const failing = vi.fn().mockResolvedValue({ exceptionDetails: { text: "SyntaxError: fixture" } });
    expect(await executeCdpAuditCommand(failing, target, "seo_audit")).toContain("SyntaxError: fixture");
  });

  it("returns a safe message when the page returns no object", async () => {
    const cdpSend = vi.fn().mockResolvedValue({ result: { value: null } });
    expect(await executeCdpAuditCommand(cdpSend, target, "responsive_audit")).toContain("no structured result");
  });
});

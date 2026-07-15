import { describe, it, expect, vi, afterEach } from "vitest";

describe("wait action — controlBrowserTabTool", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("succeeds with only value specified", async () => {
    const { setBrowserControlHandler, controlBrowserTabTool } = await import(
      "../src/core/tools/otherTools.js"
    );

    const mockHandler = vi.fn().mockResolvedValue("Waited for 2000ms");
    setBrowserControlHandler(mockHandler);

    const result = await controlBrowserTabTool.execute({ action: "wait", value: "2000" }, process.cwd(), undefined);

    expect(mockHandler).toHaveBeenCalledWith("wait", "", "2000");
    expect(result).toBe("Waited for 2000ms");
  });

  it("succeeds with only target specified", async () => {
    const { setBrowserControlHandler, controlBrowserTabTool } = await import(
      "../src/core/tools/otherTools.js"
    );

    const mockHandler = vi.fn().mockResolvedValue("Waited for 1500ms");
    setBrowserControlHandler(mockHandler);

    const result = await controlBrowserTabTool.execute({ action: "wait", target: "1500" }, process.cwd(), undefined);

    expect(mockHandler).toHaveBeenCalledWith("wait", "1500", "");
    expect(result).toBe("Waited for 1500ms");
  });

  it("succeeds with target page_load and value 2500 specified", async () => {
    const { setBrowserControlHandler, controlBrowserTabTool } = await import(
      "../src/core/tools/otherTools.js"
    );

    const mockHandler = vi.fn().mockResolvedValue("Page loaded");
    setBrowserControlHandler(mockHandler);

    const result = await controlBrowserTabTool.execute({ action: "wait", target: "page_load", value: "2500" }, process.cwd(), undefined);

    expect(mockHandler).toHaveBeenCalledWith("wait", "page_load", "2500");
    expect(result).toBe("Page loaded");
  });

  it("fails when neither target nor value is specified for wait", async () => {
    const { setBrowserControlHandler, controlBrowserTabTool } = await import(
      "../src/core/tools/otherTools.js"
    );

    const mockHandler = vi.fn().mockResolvedValue("OK");
    setBrowserControlHandler(mockHandler);

    const result = await controlBrowserTabTool.execute({ action: "wait" }, process.cwd(), undefined);

    expect(mockHandler).not.toHaveBeenCalled();
    expect(result).toContain('Error: Either target (CSS selector or milliseconds) or value (milliseconds) is required for action "wait"');
  });
});

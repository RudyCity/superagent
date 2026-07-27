import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "path";
import os from "os";
import fs from "fs";

// ─── Unit tests for UI-DETR-1 detect_ui integration ──────────────────────────

const tmpDir = path.join(os.tmpdir(), `superagent-test-detr-${Date.now()}`);

const DETECTED_RESULT = {
  success: true,
  elements: [
    { label: "button", score: 0.92, box: [10, 20, 80, 50], center: [45, 35] },
    { label: "input", score: 0.85, box: [100, 100, 300, 130], center: [200, 115] },
  ]
};

const EMPTY_RESULT = { success: true, elements: [] };

describe("detect_ui action — controlBrowserTabTool", () => {
  beforeEach(async () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "chrome_screenshot.png"), "dummy");
  });

  afterEach(async () => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    const { stopRemoteChromeBridge } = await import("../src/core/tools/remoteChromeBridge.js");
    await stopRemoteChromeBridge().catch(() => {});
    vi.restoreAllMocks();
  });

  it("returns detected elements as a formatted string on success via fetch", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => DETECTED_RESULT
    });
    vi.stubGlobal("fetch", fetchMock);

    const { setBrowserControlHandler, controlBrowserTabTool } = await import(
      "../src/core/tools/otherTools.js"
    );

    const mockHandler = vi.fn().mockImplementation(async (action, target, value) => {
      if (action === "screenshot") {
        return "Screenshot saved to workspace at: " + path.join(tmpDir, "chrome_screenshot.png");
      }
      if (action === "dom_info") {
        if (target === "45,35") {
          return JSON.stringify({ found: true, id: "my-id" });
        }
        if (target === "200,115") {
          return JSON.stringify({ found: true, selector: "div > input" });
        }
      }
      return "OK";
    });
    setBrowserControlHandler(mockHandler);

    const result = await controlBrowserTabTool.execute({ action: "detect_ui" }, tmpDir, undefined);

    expect(fetchMock).toHaveBeenCalled();
    expect(typeof result).toBe("string");
    expect(result).toContain("Detected UI elements");
    expect(result).toContain("button @ 45,35 | #my-id (92%)");
    expect(result).toContain("input @ 200,115 | div > input (85%)");
  });

  it("returns no-elements message when model finds nothing", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => EMPTY_RESULT
    });
    vi.stubGlobal("fetch", fetchMock);

    const { setBrowserControlHandler, controlBrowserTabTool } = await import(
      "../src/core/tools/otherTools.js"
    );

    const mockHandler = vi.fn().mockImplementation(async (action) => {
      if (action === "screenshot") {
        return "Screenshot saved to workspace at: " + path.join(tmpDir, "chrome_screenshot.png");
      }
      return "OK";
    });
    setBrowserControlHandler(mockHandler);

    const result = await controlBrowserTabTool.execute({ action: "detect_ui" }, tmpDir, undefined);

    expect(result).toBe("UI Detection finished: No elements detected on the page.");
  });

  it("returns error when browser handler is not active", async () => {
    const { setBrowserControlHandler, controlBrowserTabTool } = await import(
      "../src/core/tools/otherTools.js"
    );
    setBrowserControlHandler(null);

    const result = await controlBrowserTabTool.execute({ action: "detect_ui" }, tmpDir, undefined);

    expect(result).toContain("UI Detection execution failed");
  });
});

describe("coordinate-based target with optional selector pattern", () => {
  it("regex pattern matches valid coordinates and selectors", () => {
    const validCoordinates = ["150,230", "0,0", "1920,1080", "800,600", "150,230|#backup", "400,200|button.primary"];
    const invalidCoordinates = ["button.submit", "#id", "150", "abc,def"];

    const regex = /^(\d+),(\d+)(?:\|(.+))?$/;

    for (const coord of validCoordinates) {
      expect(regex.test(coord)).toBe(true);
    }
    for (const coord of invalidCoordinates) {
      expect(regex.test(coord)).toBe(false);
    }
  });

  it("extracts correct X, Y and backup selector from coordinate string", () => {
    const tgt = "320,480|#submit-btn";
    const match = tgt.match(/^(\d+),(\d+)(?:\|(.+))?$/);
    expect(match).not.toBeNull();
    if (match) {
      expect(parseInt(match[1], 10)).toBe(320);
      expect(parseInt(match[2], 10)).toBe(480);
      expect(match[3]).toBe("#submit-btn");
    }
  });
});


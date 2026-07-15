import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "path";
import os from "os";
import fs from "fs";

// ─── Mock execa at top level (required by Vitest hoisting) ───────────────────
vi.mock("execa", () => ({
  execa: vi.fn()
}));

// ─── Unit tests for UI-DETR-1 detect_ui integration ──────────────────────────

const tmpDir = path.join(os.tmpdir(), `superagent-test-detr-${Date.now()}`);

const DETECTED_RESULT = JSON.stringify({
  success: true,
  elements: [
    { label: "button", score: 0.92, box: [10, 20, 80, 50], center: [45, 35] },
    { label: "input", score: 0.85, box: [100, 100, 300, 130], center: [200, 115] },
  ]
});

const EMPTY_RESULT = JSON.stringify({ success: true, elements: [] });

describe("detect_ui action — controlBrowserTabTool", () => {
  beforeEach(async () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "scripts", "detect_ui.py"), "# stub");
    fs.writeFileSync(path.join(tmpDir, "chrome_screenshot.png"), "dummy");
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    vi.resetAllMocks();
  });

  it("returns detected elements as a formatted string on success", async () => {
    const { execa } = await import("execa");
    vi.mocked(execa).mockResolvedValue({ stdout: DETECTED_RESULT, stderr: "" } as any);

    const { setBrowserControlHandler, controlBrowserTabTool } = await import(
      "../src/core/tools/otherTools.js"
    );

    const mockHandler = vi.fn().mockResolvedValue(
      "Screenshot saved to workspace at: " + path.join(tmpDir, "chrome_screenshot.png")
    );
    setBrowserControlHandler(mockHandler);

    const result = await controlBrowserTabTool.execute({ action: "detect_ui" }, tmpDir, undefined);

    expect(typeof result).toBe("string");
    expect(result).toContain("Detected UI elements");
    expect(result).toContain("button at coordinate 45,35");
    expect(result).toContain("input at coordinate 200,115");
  });

  it("returns no-elements message when model finds nothing", async () => {
    const { execa } = await import("execa");
    vi.mocked(execa).mockResolvedValue({ stdout: EMPTY_RESULT, stderr: "" } as any);

    const { setBrowserControlHandler, controlBrowserTabTool } = await import(
      "../src/core/tools/otherTools.js"
    );

    const mockHandler = vi.fn().mockResolvedValue(
      "Screenshot saved to workspace at: " + path.join(tmpDir, "chrome_screenshot.png")
    );
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

    expect(result).toContain("Browser control handler is not active");
  });
});

describe("coordinate-based target — detect_ui coordinate pattern", () => {
  it("regex pattern matches valid coordinates", () => {
    const validCoordinates = ["150,230", "0,0", "1920,1080", "800,600"];
    const invalidCoordinates = ["button.submit", "#id", "150", "150,230,5", "abc,def"];

    for (const coord of validCoordinates) {
      expect(/^(\d+),(\d+)$/.test(coord)).toBe(true);
    }
    for (const coord of invalidCoordinates) {
      expect(/^(\d+),(\d+)$/.test(coord)).toBe(false);
    }
  });

  it("extracts correct X and Y from coordinate string", () => {
    const tgt = "320,480";
    const match = tgt.match(/^(\d+),(\d+)$/);
    expect(match).not.toBeNull();
    if (match) {
      expect(parseInt(match[1], 10)).toBe(320);
      expect(parseInt(match[2], 10)).toBe(480);
    }
  });
});

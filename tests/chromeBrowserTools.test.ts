import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  chromeExtensionStatusTool,
  getActiveBrowserTabsTool,
  extractPageContentMarkdownTool,
  captureTabFullpagePdfTool,
  manageChromeBookmarksTool,
  launchChromeProfileTool,
} from "../src/core/tools/chromeBrowserTools.js";
import { setBrowserControlHandler } from "../src/core/tools/browserMacroTools.js";
import fs from "fs";
import path from "path";
import os from "os";

describe("chromeBrowserTools", () => {
  beforeEach(() => {
    setBrowserControlHandler(null);
  });

  afterEach(() => {
    setBrowserControlHandler(null);
  });

  test("chromeExtensionStatusTool returns disconnected status when no handler registered", async () => {
    const res = await chromeExtensionStatusTool.execute({});
    expect(res).toContain("Disconnected");
  });

  test("chromeExtensionStatusTool returns connected status when handler registered", async () => {
    setBrowserControlHandler(async (action: string) => {
      if (action === "list_instances") return "Window 1 (Tabs: 2)";
      return "";
    });

    const res = await chromeExtensionStatusTool.execute({});
    expect(res).toContain("Connected");
  });

  test("chromeExtensionStatusTool handles handler errors gracefully", async () => {
    setBrowserControlHandler(async () => {
      throw new Error("Bridge connection lost");
    });

    const res = await chromeExtensionStatusTool.execute({});
    expect(res).toContain("Error listing instances: Bridge connection lost");
  });

  test("getActiveBrowserTabsTool delegates to browserControlHandler", async () => {
    setBrowserControlHandler(async (action: string) => {
      if (action === "list") return "[0] Google (https://google.com)";
      return "";
    });

    const res = await getActiveBrowserTabsTool.execute({});
    expect(res).toContain("Google");
  });

  test("getActiveBrowserTabsTool returns fallback when handler throws", async () => {
    setBrowserControlHandler(async () => {
      throw new Error("Tab listing failed");
    });

    const res = await getActiveBrowserTabsTool.execute({});
    expect(res).toContain("Failed to get active browser tabs");
  });

  test("extractPageContentMarkdownTool extracts text via browserControlHandler", async () => {
    setBrowserControlHandler(async (action: string) => {
      if (action === "text") return "Heading Content Body Text";
      return "";
    });

    const res = await extractPageContentMarkdownTool.execute({ selector: "body" });
    expect(res).toContain("Heading Content Body Text");
  });

  test("captureTabFullpagePdfTool handles screenshot and html modes", async () => {
    setBrowserControlHandler(async (action: string) => {
      if (action === "screenshot") return "data:image/png;base64,mock";
      if (action === "html") return "<html><body>Test HTML</body></html>";
      return "";
    });

    const screenshotRes = await captureTabFullpagePdfTool.execute({ mode: "screenshot" });
    expect(screenshotRes).toContain("data:image/png;base64,mock");

    const htmlRes = await captureTabFullpagePdfTool.execute({ mode: "html" });
    expect(htmlRes).toContain("<html><body>Test HTML</body></html>");
  });

  test("manageChromeBookmarksTool parses local Bookmarks JSON file correctly", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "chrome-bookmarks-test-"));
    const defaultDir = path.join(tmpDir, "Default");
    fs.mkdirSync(defaultDir, { recursive: true });

    const mockBookmarks = {
      roots: {
        bookmark_bar: {
          children: [
            { name: "GitHub", url: "https://github.com" },
            { name: "Google", url: "https://google.com" },
          ],
        },
      },
    };

    fs.writeFileSync(path.join(defaultDir, "Bookmarks"), JSON.stringify(mockBookmarks));

    const res = await manageChromeBookmarksTool.execute({ userDataPath: tmpDir, searchQuery: "GitHub" });
    expect(res).toContain("GitHub");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("manageChromeBookmarksTool handles missing Bookmarks file", async () => {
    const res = await manageChromeBookmarksTool.execute({ searchQuery: "nonexistent" });
    expect(typeof res).toBe("string");
  });
});

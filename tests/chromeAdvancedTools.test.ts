import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  manageChromeHistoryTool,
  listChromeExtensionsTool,
  getBrowserConsoleLogsTool,
  getBrowserNetworkLogsTool,
  manageChromeDownloadsTool,
} from "../src/core/tools/chromeAdvancedTools.js";
import { setBrowserControlHandler } from "../src/core/tools/browserMacroTools.js";
import fs from "fs";
import path from "path";
import os from "os";

describe("chromeAdvancedTools", () => {
  beforeEach(() => {
    setBrowserControlHandler(null);
  });

  afterEach(() => {
    setBrowserControlHandler(null);
  });

  test("manageChromeHistoryTool returns fallback status when no handler registered", async () => {
    const res = await manageChromeHistoryTool.execute({});
    expect(res).toContain("Browsing history search query");
  });

  test("manageChromeHistoryTool delegates query to handler", async () => {
    setBrowserControlHandler(async (action: string, target: string) => {
      if (action === "history_search") {
        return `• History item for ${target}`;
      }
      return "";
    });

    const res = await manageChromeHistoryTool.execute({ query: "github" });
    expect(res).toContain("History item for github");
  });

  test("manageChromeHistoryTool handles handler errors gracefully", async () => {
    setBrowserControlHandler(async () => {
      throw new Error("History query error");
    });

    const res = await manageChromeHistoryTool.execute({ query: "github" });
    expect(res).toContain("Ensure Superagent Chrome Extension is connected");
  });

  test("getBrowserConsoleLogsTool returns errors from browser handler", async () => {
    setBrowserControlHandler(async (action: string) => {
      if (action === "errors") {
        return "Uncaught TypeError: Cannot read property of undefined";
      }
      return "";
    });

    const res = await getBrowserConsoleLogsTool.execute({});
    expect(res).toContain("Uncaught TypeError");
  });

  test("getBrowserConsoleLogsTool handles missing logs or errors gracefully", async () => {
    setBrowserControlHandler(async (action: string) => {
      if (action === "errors") {
        throw new Error("Console log capture error");
      }
      return "";
    });

    const res = await getBrowserConsoleLogsTool.execute({});
    expect(res).toContain("Failed to retrieve console logs");
  });

  test("getBrowserNetworkLogsTool returns dom/network info from handler", async () => {
    setBrowserControlHandler(async (action: string) => {
      if (action === "dom_info") {
        return "Network requests: 12 XHR/Fetch items. 200 OK";
      }
      return "";
    });

    const res = await getBrowserNetworkLogsTool.execute({});
    expect(res).toContain("Network requests");
  });

  test("getBrowserNetworkLogsTool handles handler errors gracefully", async () => {
    setBrowserControlHandler(async () => {
      throw new Error("Network log capture error");
    });

    const res = await getBrowserNetworkLogsTool.execute({});
    expect(res).toContain("Failed to retrieve network logs");
  });

  test("listChromeExtensionsTool returns profile extensions summary", async () => {
    const res = await listChromeExtensionsTool.execute({ profileDirectory: "Default" });
    expect(typeof res).toBe("string");
  });

  test("manageChromeDownloadsTool returns download directory status", async () => {
    const res = await manageChromeDownloadsTool.execute({});
    expect(typeof res).toBe("string");
  });
});

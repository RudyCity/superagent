import { describe, test, expect } from "vitest";
import { CHROME_EXTENSION_SYSTEM_PROMPT, SUBAGENT_SYSTEM_PROMPTS } from "../src/core/prompts.js";
import { chromeExtensionStatusTool } from "../src/core/tools/chromeBrowserTools.js";
import { setBrowserControlHandler, browserControlHandler } from "../src/core/tools/browserMacroTools.js";

describe("Chrome Extension vs Remote Extension Isolation", () => {
  test("CHROME_EXTENSION_SYSTEM_PROMPT (Sidepanel UI) does not contain port 9223 or remote bridge references", () => {
    expect(CHROME_EXTENSION_SYSTEM_PROMPT).not.toContain("9223");
    expect(CHROME_EXTENSION_SYSTEM_PROMPT).not.toContain("PORT_9223_BRIDGE");
    expect(CHROME_EXTENSION_SYSTEM_PROMPT).not.toContain("chrome-extension-remote");
    expect(CHROME_EXTENSION_SYSTEM_PROMPT).toContain("chrome-extension/");
    expect(CHROME_EXTENSION_SYSTEM_PROMPT).toContain("EXTENSION_ISOLATION_GUARD");
  });

  test("SUBAGENT_SYSTEM_PROMPTS['chrome-agent'] explicitly references remote Chrome extension (chrome-extension-remote)", () => {
    const chromeAgentPrompt = SUBAGENT_SYSTEM_PROMPTS["chrome-agent"];
    expect(chromeAgentPrompt).toContain("chrome-extension-remote");
    expect(chromeAgentPrompt).toContain("9223");
    expect(chromeAgentPrompt).toContain("EXTENSION_ISOLATION_GUARD");
  });

  test("chrome_extension_status cleanly recognizes Sidepanel UI mode without demanding port 9223 bridge", async () => {
    // Mock a sidepanel control handler
    const mockSidepanelHandler = async (action: string) => {
      if (action === "list_instances") {
        return "Sidepanel UI Active Tab: Google (https://google.com)";
      }
      return "OK";
    };

    setBrowserControlHandler(mockSidepanelHandler);

    const statusReport = await chromeExtensionStatusTool.execute({});
    expect(statusReport).toContain("Direct Sidepanel UI Client Mode");
    expect(statusReport).toContain("chrome-extension/");
    expect(statusReport).not.toContain("ws://127.0.0.1:9223");

    // Clean up
    setBrowserControlHandler(null);
  });
});

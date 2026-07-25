import fs from "fs/promises";
import path from "path";
import os from "os";
import { Tool } from "./types.js";
import { getChromeUserDataPath } from "./chromeProfileTools.js";
import { browserControlHandler } from "./browserMacroTools.js";

export const manageChromeHistoryTool: Tool = {
  name: "manage_chrome_history",
  description: "Read or search browsing history from Chrome profile via browser extension or local data.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search query string to filter browsing history URLs or titles.",
      },
      maxResults: {
        type: "number",
        description: "Maximum number of history items to return. Defaults to 20.",
      },
    },
  },
  execute: async ({ query = "", maxResults = 20 }: { query?: string; maxResults?: number }) => {
    if (browserControlHandler) {
      try {
        const res = await browserControlHandler("history_search", query, String(maxResults));
        return res;
      } catch (err: any) {
        // Fall back to message if extension history search fails
      }
    }

    return `Browsing history search query: "${query}". Ensure Superagent Chrome Extension is connected to query live browsing history via extension APIs.`;
  },
};

export const listChromeExtensionsTool: Tool = {
  name: "list_chrome_extensions",
  description: "Scan installed extensions in a Chrome profile directory.",
  parameters: {
    type: "object",
    properties: {
      profileName: {
        type: "string",
        description: "Chrome profile directory (e.g. 'Default', 'Profile 1'). Defaults to 'Default'.",
      },
    },
  },
  execute: async ({ profileName = "Default" }: { profileName?: string }) => {
    if (browserControlHandler) {
      try {
        const res = await browserControlHandler("management_list", "");
        if (res) return res;
      } catch {
        // Fallback to disk scan
      }
    }

    const userDataPath = getChromeUserDataPath();
    const extDir = path.join(userDataPath, profileName, "Extensions");

    try {
      const entries = await fs.readdir(extDir, { withFileTypes: true });
      const extIds = entries.filter((e) => e.isDirectory()).map((e) => e.name);

      if (extIds.length === 0) {
        return `No extensions found in Chrome profile \`${profileName}\`.`;
      }

      const lines = [
        `### Installed Chrome Extensions (${extIds.length}) - Profile \`${profileName}\``,
        `**Directory**: \`${extDir}\`\n`,
        "| Extension ID | Location |",
        "| --- | --- |",
      ];

      for (const id of extIds.slice(0, 30)) {
        lines.push(`| \`${id}\` | \`${path.join(extDir, id)}\` |`);
      }

      if (extIds.length > 30) {
        lines.push(`\n*... and ${extIds.length - 30} more extensions.*`);
      }

      return lines.join("\n");
    } catch (err: any) {
      return `Failed to list installed extensions for profile \`${profileName}\`: ${err.message || String(err)}`;
    }
  },
};

export const getBrowserConsoleLogsTool: Tool = {
  name: "get_browser_console_logs",
  description: "Retrieve JavaScript console output, errors, and warnings from the active Chrome tab.",
  parameters: {
    type: "object",
    properties: {
      instanceId: {
        type: "string",
        description: "Optional Chrome instance ID.",
      },
    },
  },
  execute: async ({ instanceId }: { instanceId?: string }) => {
    if (!browserControlHandler) {
      return "No active browser connection. Ensure `superagent --server` is running and Chrome Extension is active.";
    }

    try {
      const logs = await browserControlHandler("errors", "", undefined, instanceId);
      return logs || "No JS errors or console logs detected on current tab.";
    } catch (err: any) {
      return `Failed to retrieve console logs: ${err.message || String(err)}`;
    }
  },
};

export const getBrowserNetworkLogsTool: Tool = {
  name: "get_browser_network_logs",
  description: "Retrieve network requests/responses and XHR traffic from the active Chrome tab.",
  parameters: {
    type: "object",
    properties: {
      filterPattern: {
        type: "string",
        description: "Optional URL filter or regex pattern.",
      },
      instanceId: {
        type: "string",
        description: "Optional Chrome instance ID.",
      },
    },
  },
  execute: async ({ filterPattern = "", instanceId }: { filterPattern?: string; instanceId?: string }) => {
    if (!browserControlHandler) {
      return "No active browser connection. Ensure `superagent --server` is running and Chrome Extension is active.";
    }

    try {
      const logs = await browserControlHandler("dom_info", filterPattern, undefined, instanceId);
      return logs || "No network logs recorded for current tab.";
    } catch (err: any) {
      return `Failed to retrieve network logs: ${err.message || String(err)}`;
    }
  },
};

export const manageChromeDownloadsTool: Tool = {
  name: "manage_chrome_downloads",
  description: "Read recent downloads from local Chrome profile data directory.",
  parameters: {
    type: "object",
    properties: {
      profileName: {
        type: "string",
        description: "Chrome profile directory (e.g. 'Default', 'Profile 1'). Defaults to 'Default'.",
      },
    },
  },
  execute: async ({ profileName = "Default" }: { profileName?: string }) => {
    const userDataPath = getChromeUserDataPath();
    const downloadDir = path.join(os.homedir(), "Downloads");

    try {
      const files = await fs.readdir(downloadDir);
      const recent = files.slice(0, 15);

      if (recent.length === 0) {
        return `Downloads directory \`${downloadDir}\` is empty.`;
      }

      const lines = [
        `### Recent Downloads (\`${downloadDir}\`)`,
        "| File Name | Path |",
        "| --- | --- |",
      ];

      for (const f of recent) {
        lines.push(`| **${f}** | \`${path.join(downloadDir, f)}\` |`);
      }

      return lines.join("\n");
    } catch (err: any) {
      return `Failed to inspect download directory: ${err.message || String(err)}`;
    }
  },
};

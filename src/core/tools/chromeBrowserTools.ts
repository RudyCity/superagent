import fs from "fs/promises";
import path from "path";
import os from "os";
import { exec } from "child_process";
import { promisify } from "util";
import { Tool } from "./types.js";
import { getChromeUserDataPath, detectChromeProfiles } from "./chromeProfileTools.js";
import { browserControlHandler } from "./browserMacroTools.js";
import { ensureRemoteChromeBridge, isRemoteChromeConnected, getRemoteChromeClientMetadata, sendRemoteCommand } from "./remoteChromeBridge.js";

const execAsync = promisify(exec);

export const launchChromeProfileTool: Tool = {
  name: "launch_chrome_profile",
  description: "Launch Google Chrome with a specific user profile (e.g. 'Default', 'Profile 1') and optional target URL.",
  parameters: {
    type: "object",
    properties: {
      profileName: {
        type: "string",
        description: "Directory name of the Chrome profile to launch (e.g. 'Default', 'Profile 1'). Defaults to 'Default'.",
      },
      url: {
        type: "string",
        description: "Optional URL to open on Chrome launch.",
      },
    },
  },
  execute: async ({ profileName = "Default", url = "" }: { profileName?: string; url?: string }) => {
    const platform = os.platform();
    let cmd = "";

    const safeProfile = profileName.replace(/["'\\]/g, "");
    const safeUrl = url ? `"${url.replace(/"/g, '\\"')}"` : "";

    if (platform === "win32") {
      cmd = `start chrome --profile-directory="${safeProfile}" ${safeUrl}`;
    } else if (platform === "darwin") {
      cmd = `open -a "Google Chrome" --args --profile-directory="${safeProfile}" ${safeUrl}`;
    } else {
      cmd = `google-chrome --profile-directory="${safeProfile}" ${safeUrl} &`;
    }

    try {
      await execAsync(cmd);
      return `Launched Chrome with profile \`${safeProfile}\`${url ? ` opening \`${url}\`` : ""}.`;
    } catch (err: any) {
      return `Failed to launch Chrome with profile \`${safeProfile}\`: ${err.message || String(err)}`;
    }
  },
};

export const getActiveBrowserTabsTool: Tool = {
  name: "get_active_browser_tabs",
  description: "List all active Chrome browser instances and open tabs connected via the Superagent Chrome Extension.",
  parameters: {
    type: "object",
    properties: {},
  },
  execute: async () => {
    await ensureRemoteChromeBridge();
    if (!browserControlHandler) {
      return "No active browser control connection. Ensure `superagent --server` is running and Superagent Chrome Extension is active.";
    }

    try {
      const res = await browserControlHandler("list", "");
      return res;
    } catch (err: any) {
      return `Failed to get active browser tabs: ${err.message || String(err)}`;
    }
  },
};

export const chromeExtensionStatusTool: Tool = {
  name: "chrome_extension_status",
  description: "Inspect Superagent Chrome Extension connection status and active instances.",
  parameters: {
    type: "object",
    properties: {},
  },
  execute: async () => {
    await ensureRemoteChromeBridge();
    
    // Connected if WebSocket client is open or custom mock control handler is registered
    const isMockHandler = Boolean(browserControlHandler && browserControlHandler !== sendRemoteCommand);
    let connected = isRemoteChromeConnected() || isMockHandler;
    if (!connected) {
      const start = Date.now();
      while (!connected && Date.now() - start < 1500) {
        await new Promise((res) => setTimeout(res, 150));
        connected = isRemoteChromeConnected() || isMockHandler;
      }
    }

    if (!connected) {
      return [
        "### Chrome Extension Connection Status",
        "**Status**: 🔴 Disconnected",
        "**Bridge Port**: 9223 (WebSocket Server Listening)",
        "\n**Troubleshooting:**",
        "1. Open Google Chrome and ensure Superagent Remote Bridge extension is enabled.",
        "2. Click on the extension icon in Chrome toolbar to trigger WebSocket connection (ws://127.0.0.1:9223).",
      ].join("\n");
    }

    try {
      const instances = await browserControlHandler!("list_instances", "");
      const meta = getRemoteChromeClientMetadata();
      const metaLines: string[] = [];

      if (meta) {
        const uptimeSec = Math.floor((Date.now() - meta.connectedAt) / 1000);
        metaLines.push(`**Extension Version**: ${meta.extensionVersion || "1.0.0"}`);
        metaLines.push(`**Platform**: ${meta.platform || "N/A"}`);
        metaLines.push(`**Open Tabs**: ${meta.tabsCount ?? "N/A"}`);
        metaLines.push(`**Connected Duration**: ${uptimeSec}s`);
        metaLines.push(`**Commands Executed**: ${meta.commandCount}`);
      }

      return [
        "### Chrome Extension Connection Status",
        "**Status**: 🟢 Connected",
        "**Bridge Port**: 9223 (WebSocket Server Listening)",
        metaLines.length > 0 ? "\n**Client Metadata:**\n" + metaLines.map((l) => `- ${l}`).join("\n") : "",
        "\n**Active Extension Instances / Connected Windows:**",
        instances || "No active connected tabs reported yet.",
      ]
        .filter(Boolean)
        .join("\n");
    } catch (err: any) {
      return `### Chrome Extension Connection Status\n**Status**: 🟡 Connected (Error listing instances: ${err.message || String(err)})`;
    }
  },
};

export const manageChromeBookmarksTool: Tool = {
  name: "manage_chrome_bookmarks",
  description: "Read and search bookmarks from a local Chrome profile (`Bookmarks` file).",
  parameters: {
    type: "object",
    properties: {
      profileName: {
        type: "string",
        description: "Profile directory name (e.g. 'Default', 'Profile 1'). Defaults to 'Default'.",
      },
      userDataPath: {
        type: "string",
        description: "Optional custom Chrome user data root directory path.",
      },
      searchQuery: {
        type: "string",
        description: "Optional search query to filter bookmark titles or URLs.",
      },
    },
  },
  execute: async ({
    profileName = "Default",
    userDataPath,
    searchQuery,
  }: {
    profileName?: string;
    userDataPath?: string;
    searchQuery?: string;
  }) => {
    const rootPath = userDataPath || getChromeUserDataPath();
    const bookmarksPath = path.join(rootPath, profileName, "Bookmarks");

    try {
      const content = await fs.readFile(bookmarksPath, "utf-8");
      const json = JSON.parse(content);

      const results: { title: string; url: string; folder: string }[] = [];

      function traverse(node: any, folderName: string) {
        if (!node) return;
        if (node.type === "url" && node.url) {
          const title = node.name || "Untitled";
          const url = node.url;
          if (
            !searchQuery ||
            title.toLowerCase().includes(searchQuery.toLowerCase()) ||
            url.toLowerCase().includes(searchQuery.toLowerCase())
          ) {
            results.push({ title, url, folder: folderName });
          }
        } else if (node.type === "folder" || node.children) {
          const name = node.name || folderName;
          if (Array.isArray(node.children)) {
            for (const child of node.children) {
              traverse(child, name);
            }
          }
        }
      }

      if (json.roots) {
        for (const [key, rootNode] of Object.entries(json.roots)) {
          traverse(rootNode, key);
        }
      }

      if (results.length === 0) {
        return `No bookmarks found${searchQuery ? ` matching query \`${searchQuery}\`` : ""} in profile \`${profileName}\`.`;
      }

      const lines = [
        `### Chrome Bookmarks Found (${results.length}) - Profile \`${profileName}\``,
        searchQuery ? `*Filtered by query: "${searchQuery}"*\n` : "\n",
        "| Title | Folder | URL |",
        "| --- | --- | --- |",
      ];

      for (const b of results.slice(0, 50)) {
        lines.push(`| **${b.title.replace(/\|/g, "\\|")}** | \`${b.folder}\` | [${b.url}](${b.url}) |`);
      }

      if (results.length > 50) {
        lines.push(`\n*... and ${results.length - 50} more bookmarks.*`);
      }

      return lines.join("\n");
    } catch (err: any) {
      return `Failed to read bookmarks for profile \`${profileName}\`: ${err.message || String(err)}. Ensure profile directory exists at \`${bookmarksPath}\`.`;
    }
  },
};

export const extractPageContentMarkdownTool: Tool = {
  name: "extract_page_content_markdown",
  description: "Extract text/Markdown content from the user's currently active Chrome tab.",
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
      return "No active browser control connection. Ensure `superagent --server` is running and Superagent Chrome Extension is active.";
    }

    try {
      const text = await browserControlHandler("extract_markdown", "", undefined, instanceId);
      return text || "No text content extracted from current tab.";
    } catch (err: any) {
      return `Failed to extract page content: ${err.message || String(err)}`;
    }
  },
};

export const captureTabFullpagePdfTool: Tool = {
  name: "capture_tab_fullpage_pdf",
  description: "Capture visual screenshot or HTML content of the active browser tab.",
  parameters: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: ["screenshot", "html"],
        description: "Capture mode: 'screenshot' (image representation) or 'html' (DOM snapshot). Defaults to 'screenshot'.",
      },
      instanceId: {
        type: "string",
        description: "Optional Chrome instance ID.",
      },
    },
  },
  execute: async ({ mode = "screenshot", instanceId }: { mode?: "screenshot" | "html"; instanceId?: string }) => {
    if (!browserControlHandler) {
      return "No active browser control connection. Ensure `superagent --server` is running and Superagent Chrome Extension is active.";
    }

    try {
      const action = mode === "html" ? "html" : "screenshot";
      const result = await browserControlHandler(action, "", undefined, instanceId);
      return result || `Successfully captured tab ${mode}.`;
    } catch (err: any) {
      return `Failed to capture tab ${mode}: ${err.message || String(err)}`;
    }
  },
};

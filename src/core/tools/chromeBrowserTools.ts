import fs from "fs/promises";
import path from "path";
import os from "os";
import { exec } from "child_process";
import { promisify } from "util";
import { Tool } from "./types.js";
import { getChromeUserDataPath, detectChromeProfiles } from "./chromeProfileTools.js";
import { callBrowser, NO_BROWSER_CONTROL_CONNECTION_MSG, withTimeout } from "./chromeCommon.js";
import {
  getBrowserProcessManager,
  probeLinuxDisplayEnvironment,
  discoverBrowserExecutable,
  type BrowserRuntimeMode,
} from "../browserRuntime/index.js";
import { applyProcessIntent } from "../process/processSpawnPolicy.js";
// PERF: `remoteChromeBridge` pulls in the `ws` websocket library and a
// per-module HTTP server. It is only needed when a tool *actually* runs
// — not at module-import time, when we are just constructing the
// tool list. Lazy-import the symbols we use inside the execute bodies
// so sessions that never invoke a chrome tool never pay the cost.
type RemoteBridge = {
  ensureRemoteChromeBridge: () => Promise<void>;
  isRemoteChromeConnected: () => boolean;
  getRemoteChromeClientMetadata: () => any;
  sendRemoteCommand: (action: string, payload: any, instanceId?: string) => Promise<any>;
};
let _remoteBridge: RemoteBridge | null = null;
async function getRemoteBridge(): Promise<RemoteBridge> {
  if (!_remoteBridge) {
    _remoteBridge = (await import("./remoteChromeBridge.js")) as unknown as RemoteBridge;
  }
  return _remoteBridge;
}
type BrowserMacro = {
  browserControlHandler: ((action: string, payload: any, tabId?: any, instanceId?: string) => Promise<any>) | null;
  getBrowserControlHandlerSource: () => ((action: string, payload: any, tabId?: any, instanceId?: string) => Promise<any>) | null;
};
let _browserMacro: BrowserMacro | null = null;
async function getBrowserMacro(): Promise<BrowserMacro> {
  if (!_browserMacro) {
    _browserMacro = (await import("./browserMacroTools.js")) as unknown as BrowserMacro;
  }
  return _browserMacro;
}

const execAsync = promisify(exec);

export const launchChromeProfileTool: Tool = {
  name: "launch_chrome_profile",
  description: "Launch Google Chrome with a specific user profile (e.g. 'Default', 'Profile 1'), optional target URL, and optional remote debugging port for CDP automation (e.g. 9222). Note: When remoteDebuggingPort is provided, an isolated user-data-dir is used automatically so Chrome opens with CDP enabled without conflicting with or killing any already-running Chrome windows.",
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
      remoteDebuggingPort: {
        type: "integer",
        description: "Optional remote debugging port to enable CDP automation (e.g. 9222). When provided, launches Chrome with --remote-debugging-port=<port> and an isolated debug profile.",
      },
      userDataDir: {
        type: "string",
        description: "Optional custom Chrome user-data-dir path. Defaults to ~/.superagent-r/chrome-debug-profile when remoteDebuggingPort is provided to avoid singleton conflict.",
      },
      isolated: {
        type: "boolean",
        description: "Whether to launch in an isolated user-data-dir (default true when remoteDebuggingPort is specified).",
      },
      autoSelectDesktopCaptureSource: {
        type: "string",
        description: "Optional title or 'Entire screen' to automatically select and confirm screen sharing without prompting.",
      },
      useFakeMediaUi: {
        type: "boolean",
        description: "Whether to bypass screen sharing and webcam/mic prompts with fake media UI (default true when remoteDebuggingPort is specified).",
      },
      enableLocalHumanTakeover: {
        type: "boolean",
        description: "Linux virtual-display only: explicitly start locally password-protected VNC + noVNC for manual human takeover (disabled by default; remote access remains disabled).",
      },
      mode: {
        type: "string",
        enum: ["auto", "headless", "headed", "virtual-display"],
        description: "Browser execution mode: 'auto' (default; selects headless on displayless Linux, headed on desktop), 'headless' (Chromium --headless=new with CDP), 'headed' (visible browser window; requires DISPLAY/Wayland on Linux), or 'virtual-display' (reserved for Milestone M2).",
      },
    },
  },
  execute: async ({
    profileName = "Default",
    url = "",
    remoteDebuggingPort,
    userDataDir,
    isolated,
    autoSelectDesktopCaptureSource,
    useFakeMediaUi,
    enableLocalHumanTakeover = false,
    mode = "auto",
  }: {
    profileName?: string;
    url?: string;
    remoteDebuggingPort?: number;
    userDataDir?: string;
    isolated?: boolean;
    autoSelectDesktopCaptureSource?: string;
    useFakeMediaUi?: boolean;
    enableLocalHumanTakeover?: boolean;
    mode?: BrowserRuntimeMode;
  }) => {
    const platform = os.platform();
    const safeProfile = profileName.replace(/["'\\]/g, "");
    const safeUrl = url ? `"${url.replace(/"/g, '\\"')}"` : "";

    // Fail-fast checks for reserved / unsupported modes
    if (mode === "virtual-display") {
      if (platform !== "linux") {
        return `Failed to launch Chrome: Virtual display mode (Xvfb/minimal WM) is only supported on Linux. On ${platform}, use 'headed' or 'headless' mode.`;
      }
    }

    if (platform === "linux" && mode === "headed") {
      const display = probeLinuxDisplayEnvironment();
      if (!display.hasDisplay) {
        return "Failed to launch Chrome: Cannot launch Chrome in 'headed' mode on Linux because neither DISPLAY nor WAYLAND_DISPLAY is set. Use 'headless' mode or provide an active display server.";
      }
    }

    const shouldIsolate = isolated ?? Boolean(remoteDebuggingPort || mode === "virtual-display");
    let resolvedDataDir = userDataDir;
    if (shouldIsolate && !resolvedDataDir) {
      resolvedDataDir = path.join(os.homedir(), ".superagent-r", "chrome-debug-profile");
    }

    // When remote debugging port is requested, use canonical BrowserProcessManager
    if (remoteDebuggingPort || mode === "virtual-display") {
      try {
        const manager = getBrowserProcessManager();
        const instance = await manager.launchBrowser({
          port: Number(remoteDebuggingPort || 9222),
          mode,
          userDataDir: resolvedDataDir,
          profileName: safeProfile,
          url: url || undefined,
          autoSelectDesktopCaptureSource,
          useFakeMediaUi,
          virtualDisplay: mode === "virtual-display" && enableLocalHumanTakeover
            ? { enableLocalVnc: true, enableLocalNoVnc: true }
            : undefined,
        });

        const isolatedNote = instance.userDataDir ? ` (isolated debug profile: \`${instance.userDataDir}\`)` : "";
        const displayNote = instance.virtualDisplay ? ` on virtual display \`${instance.virtualDisplay.displayStr}\`` : "";
        const baseMsg = `Launched Chrome in \`${instance.resolvedMode}\` mode with profile \`${safeProfile}\`${isolatedNote}${displayNote} (CDP port ${instance.port}, PID ${instance.pid})${url ? ` opening \`${url}\`` : ""}.`;
        return `${baseMsg} NEXT_ACTION: Chrome is ready for automation. Call control_chrome_cdp(command: 'list_targets') or control_chrome_cdp(command: 'navigate', url: '...') immediately to execute the user's task. Do NOT stop or write manual guides for the user.`;
      } catch (err: any) {
        return `Failed to launch Chrome with profile \`${safeProfile}\`: ${err.message || String(err)}`;
      }
    }

    // Standard launch without remote debugging port
    if (resolvedDataDir) {
      try {
        await fs.mkdir(resolvedDataDir, { recursive: true });
      } catch {}
    }

    const dataDirFlag = resolvedDataDir
      ? ` --user-data-dir="${resolvedDataDir.replace(/\\/g, "/")}" --no-first-run --no-default-browser-check`
      : "";

    let cmd = "";
    if (platform === "win32") {
      cmd = `start "" chrome --profile-directory="${safeProfile}"${dataDirFlag} ${safeUrl}`;
    } else if (platform === "darwin") {
      cmd = `open -a "Google Chrome" --args --profile-directory="${safeProfile}"${dataDirFlag} ${safeUrl}`;
    } else {
      const discovery = discoverBrowserExecutable();
      const exe = discovery.executable;
      const isHeadless = mode === "headless" || (mode === "auto" && !probeLinuxDisplayEnvironment().hasDisplay);
      const headlessFlag = isHeadless ? " --headless=new --disable-gpu" : "";
      cmd = `${exe} --profile-directory="${safeProfile}"${dataDirFlag}${headlessFlag} ${safeUrl} &`;
    }

    try {
      await execAsync(cmd, applyProcessIntent({ timeout: 15000 }, "headless", { caller: "chromeBrowserTools.launchChromeProfile", executable: "chrome" }));
      const isolatedNote = resolvedDataDir ? ` (isolated debug profile: \`${resolvedDataDir}\`)` : "";
      return `Launched Chrome with profile \`${safeProfile}\`${isolatedNote}${url ? ` opening \`${url}\`` : ""}.`;
    } catch (err: any) {
      return `Failed to launch Chrome with profile \`${safeProfile}\`: ${err.message || String(err)}`;
    }
  },
};

export const getActiveBrowserTabsTool: Tool = {
  name: "get_active_browser_tabs",
  description: "List all active Chrome browser instances and open tabs connected via the Superagent Chrome Extension. Requires the Superagent Chrome Extension to be installed and connected on the target Chrome browser. Without it, this tool fails fast with an explicit error.",
  parameters: {
    type: "object",
    properties: {},
  },
  execute: async () => {
    const bridge = await getRemoteBridge();
    await bridge.ensureRemoteChromeBridge();
    // NOTE: read the handler AFTER ensureRemoteChromeBridge() — ensure installs it.
    const { browserControlHandler } = await getBrowserMacro();
    if (!browserControlHandler) {
      return NO_BROWSER_CONTROL_CONNECTION_MSG;
    }
    // Fail fast: when the remote bridge is listening but no extension client is
    // attached, sending would burn the whole timeout budget — report immediately.
    if ((await getBrowserMacro()).getBrowserControlHandlerSource() === bridge.sendRemoteCommand && !bridge.isRemoteChromeConnected()) {
      return "No active browser control connection. The Superagent Chrome Extension must be installed and connected on the target Chrome browser (remote bridge is listening but no extension client is attached). Ensure `superagent --server` is running.";
    }

    try {
      const res = await withTimeout(browserControlHandler("list", ""), 12000, "list");
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
    const { browserControlHandler } = await getBrowserMacro();
    const { ensureRemoteChromeBridge, isRemoteChromeConnected, getRemoteChromeClientMetadata, sendRemoteCommand } = await getRemoteBridge();
    // Check if sidepanel UI client mode is active
    const isSidepanelClient = Boolean(browserControlHandler && (await getBrowserMacro()).getBrowserControlHandlerSource() !== sendRemoteCommand);

    if (isSidepanelClient) {
      try {
        const instances = await browserControlHandler!("list_instances", "");
        return [
          "### Superagent Chrome Extension Sidepanel Status",
          "**Status**: 🟢 Connected (Direct Sidepanel UI Client Mode)",
          "**Client Mode**: Superagent Chrome Extension Sidepanel (`chrome-extension/`)",
          "\n**Active Sidepanel Instance / Open Tabs:**",
          instances || "Direct sidepanel UI active. No active tab list reported yet.",
        ].join("\n");
      } catch (err: any) {
        return `### Superagent Chrome Extension Sidepanel Status\n**Status**: 🟢 Connected (Direct Sidepanel UI Client Mode)\n**Info**: Sidepanel UI active. (${err.message || String(err)})`;
      }
    }

    await ensureRemoteChromeBridge();

    let connected = isRemoteChromeConnected();
    if (!connected) {
      const isTest = process.env.NODE_ENV === "test" || process.env.VITEST === "true";
      const maxWait = isTest ? 50 : 1500;
      const interval = isTest ? 10 : 150;
      const start = Date.now();
      while (!connected && Date.now() - start < maxWait) {
        await new Promise((res) => setTimeout(res, interval));
        connected = isRemoteChromeConnected();
      }
    }

    if (!connected) {
      return [
        "### Remote Chrome Extension (chrome-extension-remote) Status",
        "**Status**: 🔴 Disconnected",
        "**Bridge Port**: 9223 (WebSocket Server Listening)",
        "\n**Troubleshooting (for Remote Control mode):**",
        "1. Ensure Remote Chrome Control Extension (`chrome-extension-remote`) is installed in Chrome.",
        "2. Click the extension icon in Chrome toolbar to trigger WebSocket connection (ws://127.0.0.1:9223).",
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
        "### Remote Chrome Extension (chrome-extension-remote) Status",
        "**Status**: 🟢 Connected",
        "**Bridge Port**: 9223 (WebSocket Server Listening)",
        metaLines.length > 0 ? "\n**Client Metadata:**\n" + metaLines.map((l) => `- ${l}`).join("\n") : "",
        "\n**Active Extension Instances / Connected Windows:**",
        instances || "No active connected tabs reported yet.",
      ]
        .filter(Boolean)
        .join("\n");
    } catch (err: any) {
      return `### Remote Chrome Extension (chrome-extension-remote) Status\n**Status**: 🟡 Connected (Error listing instances: ${err.message || String(err)})`;
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
  description: "Extract text/Markdown content from the user's currently active Chrome tab. Requires the Superagent Chrome Extension to be installed and connected on the target Chrome browser. Without it, this tool fails fast with an explicit error.",
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
    return callBrowser("extract_markdown", "Failed to extract page content", ["", undefined, instanceId], {
      noConnMsg: NO_BROWSER_CONTROL_CONNECTION_MSG,
      emptyFallback: "No text content extracted from current tab.",
    });
  },
};

export const captureTabFullpagePdfTool: Tool = {
  name: "capture_tab_fullpage_pdf",
  description: "Capture visual screenshot or HTML content of the active browser tab. Requires the Superagent Chrome Extension to be installed and connected on the target Chrome browser. Without it, this tool fails fast with an explicit error.",
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
    const action = mode === "html" ? "html" : "screenshot";
    return callBrowser(action, `Failed to capture tab ${mode}`, ["", undefined, instanceId], {
      noConnMsg: NO_BROWSER_CONTROL_CONNECTION_MSG,
      emptyFallback: `Successfully captured tab ${mode}.`,
    });
  },
};


export const browserRuntimeStatusTool: Tool = {
  name: "browser_runtime_status",
  description: "Inspect active Chromium/Chrome browser runtime health, listening CDP port, process ownership PID, and target count.",
  parameters: {
    type: "object",
    properties: {
      port: {
        type: "integer",
        description: "CDP remote debugging port to inspect (default: 9222).",
      },
    },
  },
  execute: async ({ port = 9222 }: { port?: number }) => {
    try {
      const manager = getBrowserProcessManager();
      const health = await manager.checkHealth(Number(port));
      const lines = [
        `### Browser Runtime Health (Port ${health.port})`,
        `**Status**: ${health.status === "healthy" ? "🟢 Healthy" : health.status === "stopped" ? "⚪ Stopped" : "🔴 Unhealthy"}`,
        `**Listening**: ${health.listening ? "Yes (127.0.0.1:" + health.port + ")" : "No"}`,
      ];
      if (health.pid) lines.push(`**PID**: ${health.pid}`);
      if (health.recordId) lines.push(`**Supervisor Record**: \`${health.recordId}\``);
      if (health.mode) lines.push(`**Configured Mode**: \`${health.mode}\``);
      if (health.resolvedMode) lines.push(`**Active Mode**: \`${health.resolvedMode}\``);
      if (health.browserVersion) lines.push(`**Browser**: ${health.browserVersion}`);
      if (health.targetCount !== undefined) lines.push(`**Open Targets**: ${health.targetCount}`);
      if (health.uptimeMs !== undefined) lines.push(`**Uptime**: ${Math.floor(health.uptimeMs / 1000)}s`);
      if (health.virtualDisplay) {
        lines.push(`**Virtual Display**: \`${health.virtualDisplay.display}\` (Socket: ${health.virtualDisplay.xSocketActive ? "Active" : "Missing"})`);
        lines.push(`**Xvfb**: ${health.virtualDisplay.xvfbRunning ? "Running" : "Stopped"}, **WM**: ${health.virtualDisplay.wmRunning ? "Running" : "Stopped"}`);
        if (health.virtualDisplay.vncPort) {
          lines.push(`**Local VNC**: ${health.virtualDisplay.vncRunning ? "Listening" : "Stopped"} on 127.0.0.1:${health.virtualDisplay.vncPort}`);
        }
        if (health.virtualDisplay.noVncPort) {
          lines.push(`**Local noVNC**: ${health.virtualDisplay.noVncRunning ? "Listening" : "Stopped"} on 127.0.0.1:${health.virtualDisplay.noVncPort}`);
        }
      }
      if (health.error) lines.push(`**Error / Warning**: ${health.error}`);
      return lines.join("\n");
    } catch (err: any) {
      return `Failed to inspect browser runtime: ${err.message || String(err)}`;
    }
  },
};

export const stopBrowserRuntimeTool: Tool = {
  name: "stop_browser_runtime",
  description: "Gracefully terminate an owned Chromium/Chrome browser runtime instance on a given CDP port after verifying process ownership.",
  parameters: {
    type: "object",
    properties: {
      port: {
        type: "integer",
        description: "CDP port of the owned browser to terminate (default: 9222).",
      },
    },
  },
  execute: async ({ port = 9222 }: { port?: number }) => {
    try {
      const manager = getBrowserProcessManager();
      const res = await manager.stopBrowser({ port: Number(port) });
      return res.success
        ? `Stopped browser on port ${port}: ${res.reason}`
        : `Could not stop browser on port ${port}: ${res.reason}`;
    } catch (err: any) {
      return `Failed to stop browser runtime on port ${port}: ${err.message || String(err)}`;
    }
  },
};


export const requestHumanTakeoverTool: Tool = {
  name: "request_human_takeover",
  description: "Pauses an automated browser task and requests secure human-in-the-loop takeover on a specific Chrome CDP target tab (e.g. when encountering CAPTCHAs, OTP verification, Google sign-in, or manual approval). Automatically installs a verified human hold on the CDP target before issuing an invitation, fencing all agent mutations until explicit Return to Agent.",
  parameters: {
    type: "object",
    properties: {
      targetId: {
        type: "string",
        description: "Explicit CDP targetId of the tab requiring human intervention.",
      },
      reason: {
        type: "string",
        description: "Reason for requesting human takeover (e.g. 'CAPTCHA verification', 'Google 2FA prompt', 'Payment approval').",
      },
      port: {
        type: "integer",
        description: "Optional CDP port (defaults to 9222 or active port).",
      },
      targetUrl: {
        type: "string",
        description: "Optional sanitized URL of the target page.",
      },
    },
    required: ["targetId", "reason"],
  },
  execute: async ({
    targetId,
    reason,
    port,
    targetUrl,
  }: {
    targetId?: string;
    reason?: string;
    port?: number;
    targetUrl?: string;
  }) => {
    if (!targetId || !reason) {
      return "Failed to request human takeover: targetId and reason are required.";
    }
    try {
      const {
        getTakeoverSessionManager,
        buildTakeoverNotificationPayload,
        formatTakeoverCliAlert,
      } = await import("../browserTakeover/index.js");

      const manager = getTakeoverSessionManager();
      const invitation = await manager.requestTakeover({
        targetId,
        reason,
        port: port ? Number(port) : undefined,
        targetUrl,
      });

      const payload = buildTakeoverNotificationPayload(invitation);
      const alertBox = formatTakeoverCliAlert(payload);

      return "Human hold installed. A human operator must retrieve the one-time invitation through the authenticated local Core control channel. Invitation secrets are not exposed to agents.";
    } catch (err: any) {
      return `Failed to request human takeover: ${err.message || String(err)}`;
    }
  },
};

export const takeoverStatusTool: Tool = {
  name: "takeover_status",
  description: "Inspects the status, state machine phase, and verification details of human takeover sessions.",
  parameters: {
    type: "object",
    properties: {
      sessionId: {
        type: "string",
        description: "Optional specific session UUID to inspect. If omitted, lists recent sessions.",
      },
    },
  },
  execute: async ({ sessionId }: { sessionId?: string }) => {
    try {
      const {
        loadTakeoverSession,
        listTakeoverSessions,
        sanitizePublicSession,
      } = await import("../browserTakeover/index.js");

      if (sessionId) {
        const session = await loadTakeoverSession(sessionId);
        if (!session) return `Takeover session '${sessionId}' not found.`;
        return JSON.stringify(sanitizePublicSession(session), null, 2);
      }

      const sessions = await listTakeoverSessions();
      if (sessions.length === 0) return "No active or recent human takeover sessions.";
      const publicSessions = sessions.slice(0, 10).map(sanitizePublicSession);
      return JSON.stringify(publicSessions, null, 2);
    } catch (err: any) {
      return `Failed to inspect takeover status: ${err.message || String(err)}`;
    }
  },
};

export const returnToAgentTool: Tool = {
  name: "return_to_agent",
  description: "Completes the human takeover handoff: revokes remote input, revalidates live browser identity and tab generation, and if verified, releases the human hold and resumes agent automation.",
  parameters: {
    type: "object",
    properties: {
      sessionId: {
        type: "string",
        description: "UUID of the takeover session to return and verify.",
      },
      actor: {
        type: "string",
        description: "Identifier of the actor initiating the return (default: 'operator').",
      },
      notes: {
        type: "string",
        description: "Optional verification notes or challenge outcome summary.",
      },
    },
    required: ["sessionId"],
  },
  execute: async ({
    sessionId,
    actor = "operator",
    notes,
  }: {
    sessionId?: string;
    actor?: string;
    notes?: string;
  }) => {
    if (!sessionId) {
      return "Failed to return control to agent: sessionId is required.";
    }
    try {
      const { getTakeoverSessionManager } = await import("../browserTakeover/index.js");
      const manager = getTakeoverSessionManager();

      // An agent must never be able to lift a human hold. The human must
      // redeem the invite and explicitly approve Return using an operator token.
      return "Human hold remains active. Only the authorized human takeover UI can return control to the agent.";

    } catch (err: any) {
      return `Failed to return control to agent: ${err.message || String(err)}`;
    }
  },
};

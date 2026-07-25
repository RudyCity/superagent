import { Tool } from "./types.js";
import { browserControlHandler } from "./browserMacroTools.js";

export const manageBrowserCookiesStorageTool: Tool = {
  name: "manage_browser_cookies_storage",
  description: "Read or clear cookies, localStorage, or sessionStorage on active Chrome tab domain.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["get", "clear"],
        description: "Action to perform: 'get' (retrieve storage/cookie summary) or 'clear' (purge storage).",
      },
      targetType: {
        type: "string",
        enum: ["cookies", "localStorage", "sessionStorage", "all"],
        description: "Target storage type to inspect or clear. Defaults to 'all'.",
      },
      instanceId: {
        type: "string",
        description: "Optional Chrome instance ID.",
      },
    },
  },
  execute: async ({ action = "get", targetType = "all", instanceId }: { action?: "get" | "clear"; targetType?: string; instanceId?: string }) => {
    if (!browserControlHandler) {
      return "No active browser connection. Ensure `superagent --server` is running and Chrome Extension is active.";
    }

    try {
      const res = await browserControlHandler("manage_storage", action, targetType, instanceId);
      return res || `Successfully executed ${action} on storage/cookies.`;
    } catch (err: any) {
      return `Failed to manage browser cookies/storage: ${err.message || String(err)}`;
    }
  },
};

export const setBrowserEmulationTool: Tool = {
  name: "set_browser_emulation",
  description: "Configure browser viewport emulation (device metrics, user-agent, touch mode).",
  parameters: {
    type: "object",
    properties: {
      device: {
        type: "string",
        enum: ["desktop", "mobile_iphone", "mobile_android", "tablet_ipad", "custom"],
        description: "Device profile preset. Defaults to 'desktop'.",
      },
      width: {
        type: "number",
        description: "Viewport width in pixels (used if device is 'custom').",
      },
      height: {
        type: "number",
        description: "Viewport height in pixels (used if device is 'custom').",
      },
      userAgent: {
        type: "string",
        description: "Optional custom User-Agent string.",
      },
      instanceId: {
        type: "string",
        description: "Optional Chrome instance ID.",
      },
    },
  },
  execute: async ({
    device = "desktop",
    width,
    height,
    userAgent,
    instanceId,
  }: {
    device?: string;
    width?: number;
    height?: number;
    userAgent?: string;
    instanceId?: string;
  }) => {
    if (!browserControlHandler) {
      return "No active browser connection. Ensure `superagent --server` is running and Chrome Extension is active.";
    }

    try {
      const modeStr = device === "custom" && width && height ? `${width}x${height}` : device;
      const res = await browserControlHandler("emulate_viewport", modeStr, userAgent, instanceId);
      return res || `Successfully updated browser emulation settings to '${modeStr}'.`;
    } catch (err: any) {
      return `Failed to update browser emulation: ${err.message || String(err)}`;
    }
  },
};

export const setNetworkConditionsTool: Tool = {
  name: "set_network_conditions",
  description: "Configure network throttling conditions or resource blocking (e.g. images, ads).",
  parameters: {
    type: "object",
    properties: {
      throttling: {
        type: "string",
        enum: ["online", "fast_3g", "slow_3g", "offline"],
        description: "Network speed throttling profile. Defaults to 'online'.",
      },
      blockImages: {
        type: "boolean",
        description: "If true, blocks loading image resources for faster scraping.",
      },
      blockAds: {
        type: "boolean",
        description: "If true, blocks known ad/analytics scripts.",
      },
      instanceId: {
        type: "string",
        description: "Optional Chrome instance ID.",
      },
    },
  },
  execute: async ({
    throttling = "online",
    blockImages = false,
    blockAds = false,
    instanceId,
  }: {
    throttling?: string;
    blockImages?: boolean;
    blockAds?: boolean;
    instanceId?: string;
  }) => {
    if (!browserControlHandler) {
      return "No active browser connection. Ensure `superagent --server` is running and Chrome Extension is active.";
    }

    try {
      const res = await browserControlHandler("set_network_conditions", throttling, "", instanceId);
      return res || `Updated network conditions: Throttling=${throttling}, BlockImages=${blockImages}, BlockAds=${blockAds}.`;
    } catch (err: any) {
      return `Failed to update network conditions: ${err.message || String(err)}`;
    }
  },
};

export const captureTabFullpagePdfTool: Tool = {
  name: "capture_tab_fullpage_pdf",
  description: "Capture visual screenshot or HTML content of the active browser tab.",
  parameters: {
    type: "object",
    properties: {
      instanceId: {
        type: "string",
        description: "Optional Chrome instance ID.",
      },
      mode: {
        type: "string",
        enum: ["screenshot", "html"],
        description: "Capture mode: 'screenshot' (image representation) or 'html' (DOM snapshot). Defaults to 'screenshot'.",
      },
    },
  },
  execute: async ({ instanceId, mode = "screenshot" }: { instanceId?: string; mode?: string }) => {
    if (!browserControlHandler) {
      return "No active browser connection. Ensure `superagent --server` is running and Chrome Extension is active.";
    }

    try {
      const actionName = mode === "screenshot" ? "capture_pdf" : "html";
      const res = await browserControlHandler(actionName, "", "", instanceId);
      return res || `Captured ${mode} of current tab.`;
    } catch (err: any) {
      return `Failed to capture tab PDF/content: ${err.message || String(err)}`;
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
      const res = await browserControlHandler("errors", "", "", instanceId);
      return res || "No console logs recorded.";
    } catch (err: any) {
      return `Failed to retrieve browser console logs: ${err.message || String(err)}`;
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
      const res = await browserControlHandler("network_logs", filterPattern, "", instanceId);
      return res || "No network requests recorded.";
    } catch (err: any) {
      return `Failed to retrieve browser network logs: ${err.message || String(err)}`;
    }
  },
};

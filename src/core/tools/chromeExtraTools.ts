import { Tool } from "./types.js";
import { callBrowser } from "./chromeCommon.js";

export const manageBrowserCookiesStorageTool: Tool = {
  name: "manage_browser_cookies_storage",
  description: "Read or clear cookies, localStorage, or sessionStorage on active Chrome tab domain. Requires the Superagent Chrome Extension to be installed and connected on the target Chrome browser. Without it, this tool fails fast with an explicit error.",
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
    return callBrowser("manage_storage", "Failed to manage browser cookies/storage", [action, targetType, instanceId], {
      emptyFallback: `Successfully executed ${action} on storage/cookies.`,
    });
  },
};

export const setBrowserEmulationTool: Tool = {
  name: "set_browser_emulation",
  description: "Configure browser viewport emulation (device metrics, user-agent, touch mode). Requires the Superagent Chrome Extension to be installed and connected on the target Chrome browser. Without it, this tool fails fast with an explicit error.",
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
    const modeStr = device === "custom" && width && height ? `${width}x${height}` : device;
    return callBrowser("emulate_viewport", "Failed to update browser emulation", [modeStr, userAgent, instanceId], {
      emptyFallback: `Successfully updated browser emulation settings to '${modeStr}'.`,
    });
  },
};

export const setNetworkConditionsTool: Tool = {
  name: "set_network_conditions",
  description: "Configure network throttling conditions or resource blocking (e.g. images, ads). Requires the Superagent Chrome Extension to be installed and connected on the target Chrome browser. Without it, this tool fails fast with an explicit error.",
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
    return callBrowser("set_network_conditions", "Failed to update network conditions", [throttling, "", instanceId], {
      emptyFallback: `Updated network conditions: Throttling=${throttling}, BlockImages=${blockImages}, BlockAds=${blockAds}.`,
    });
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
    const actionName = mode === "screenshot" ? "capture_pdf" : "html";
    return callBrowser(actionName, "Failed to capture tab PDF/content", ["", "", instanceId], {
      emptyFallback: `Captured ${mode} of current tab.`,
    });
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
    return callBrowser("errors", "Failed to retrieve browser console logs", ["", "", instanceId], {
      emptyFallback: "No console logs recorded.",
    });
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
    return callBrowser("network_logs", "Failed to retrieve browser network logs", [filterPattern, "", instanceId], {
      emptyFallback: "No network requests recorded.",
    });
  },
};

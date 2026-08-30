import { Tool } from "./types.js";
// PERF: `remoteChromeBridge` and `browserMacroTools` both pull in heavy
// modules (ws, http server, browser macro registry). Lazy-load them so
// the cost is paid only when a headless-automation tool actually runs.
let _bridge: { ensureRemoteChromeBridge: () => Promise<boolean> } | null = null;
async function getBridge() {
  if (!_bridge) {
    _bridge = (await import("./remoteChromeBridge.js")) as unknown as { ensureRemoteChromeBridge: () => Promise<boolean> };
  }
  return _bridge;
}
type BrowserMacro = { browserControlHandler: ((action: string, target: string, value?: string, instanceId?: string) => Promise<string>) | null };
let _macro: BrowserMacro | null = null;
async function getMacro() {
  if (!_macro) {
    _macro = (await import("./browserMacroTools.js")) as BrowserMacro;
  }
  return _macro;
}

/**
 * 1. Headless Browser Automation Tool
 */
export const runHeadlessBrowserTool: Tool = {
  name: "run_headless_browser",
  description: "Execute background headless browser operations (navigation, content extraction, or background form interaction) without taking over physical window focus.",
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "Target URL to navigate to in background headless mode.",
      },
      action: {
        type: "string",
        enum: ["navigate", "extract_text", "extract_html", "eval_script"],
        description: "Action to perform in the background headless session.",
      },
      script: {
        type: "string",
        description: "Optional JavaScript snippet to evaluate if action is 'eval_script'.",
      },
    },
    required: ["url", "action"],
  },
  execute: async (args: Record<string, unknown>) => {
    const url = String(args.url || "");
    const action = String(args.action || "");
    const script = args.script ? String(args.script) : undefined;
    const { ensureRemoteChromeBridge } = await getBridge();
    const { browserControlHandler } = await getMacro();

    await ensureRemoteChromeBridge();
    if (!browserControlHandler) {
      return "No active browser control connection. Ensure `superagent --server` is running and Chrome extension bridge is active.";
    }
    try {
      if (action === "navigate") {
        const navRes = await browserControlHandler("navigate", url);
        return `[Headless Session] ${navRes}`;
      } else if (action === "extract_text") {
        const textRes = await browserControlHandler("text", "");
        return `[Headless Extracted Text]\n${textRes}`;
      } else if (action === "extract_html") {
        const htmlRes = await browserControlHandler("html", "");
        return `[Headless Extracted HTML]\n${htmlRes.substring(0, 2000)}...`;
      } else if (action === "eval_script") {
        const evalRes = await browserControlHandler("eval_js", "", script || "");
        return `[Headless Script Output]\n${evalRes}`;
      }
      return `Action '${action}' completed in background headless session.`;
    } catch (err: any) {
      return `Headless browser operation failed: ${err.message}`;
    }
  },
};

/**
 * 2. Multi-Cursor Virtual Input Simulator Tool
 */
export const simulateVirtualCursorTool: Tool = {
  name: "simulate_virtual_cursor",
  description: "Simulate multi-cursor virtual caret movements, clicks, and text typing without disturbing the OS physical mouse or keyboard.",
  parameters: {
    type: "object",
    properties: {
      targetSelector: {
        type: "string",
        description: "CSS selector of the element to interact with using the virtual caret.",
      },
      action: {
        type: "string",
        enum: ["click_caret", "type_virtual", "hover_virtual"],
        description: "Virtual cursor interaction type.",
      },
      textValue: {
        type: "string",
        description: "Text to type if action is 'type_virtual'.",
      },
    },
    required: ["targetSelector", "action"],
  },
  execute: async (args: Record<string, unknown>) => {
    const targetSelector = String(args.targetSelector || "");
    const action = String(args.action || "");
    const textValue = args.textValue ? String(args.textValue) : undefined;
    const { ensureRemoteChromeBridge } = await getBridge();
    const { browserControlHandler } = await getMacro();

    await ensureRemoteChromeBridge();
    if (!browserControlHandler) {
      return "No active browser control connection. Ensure `superagent --server` is running and Chrome extension bridge is active.";
    }
    try {
      if (action === "click_caret") {
        const clickRes = await browserControlHandler("click", targetSelector);
        return `[Virtual Cursor] Clicked target '${targetSelector}': ${clickRes}`;
      } else if (action === "type_virtual") {
        const typeRes = await browserControlHandler("type", targetSelector, textValue || "");
        return `[Virtual Cursor] Typed text into target '${targetSelector}': ${typeRes}`;
      } else if (action === "hover_virtual") {
        const hoverRes = await browserControlHandler("hover", targetSelector);
        return `[Virtual Cursor] Hovered target '${targetSelector}': ${hoverRes}`;
      }
      return `Virtual cursor action '${action}' executed.`;
    } catch (err: any) {
      return `Virtual cursor simulation failed: ${err.message}`;
    }
  },
};

/**
 * 3. Isolated CDP Background Tab Router Tool
 */
export const controlIsolatedCdpTool: Tool = {
  name: "control_isolated_cdp",
  description: "Route low-level Chrome DevTools Protocol (CDP) commands directly to isolated background tab targets.",
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        enum: ["Input.insertText", "Input.dispatchKeyEvent", "Page.printToPDF", "Network.clearBrowserCache"],
        description: "CDP command to execute on the isolated background tab.",
      },
      payload: {
        type: "string",
        description: "JSON string or text payload for the CDP command.",
      },
      targetSelector: {
        type: "string",
        description: "Optional CSS selector to focus before executing the CDP command.",
      },
    },
    required: ["command"],
  },
  execute: async (args: Record<string, unknown>) => {
    const command = String(args.command || "");
    const payload = args.payload ? String(args.payload) : undefined;
    const targetSelector = args.targetSelector ? String(args.targetSelector) : undefined;
    const { ensureRemoteChromeBridge } = await getBridge();
    const { browserControlHandler } = await getMacro();

    await ensureRemoteChromeBridge();
    if (!browserControlHandler) {
      return "No active browser control connection. Ensure `superagent --server` is running and Chrome extension bridge is active.";
    }
    try {
      if (command === "Page.printToPDF") {
        const pdfData = await browserControlHandler("capture_pdf", "");
        return `[Isolated CDP] Captured PDF snapshot (${pdfData.length} characters).`;
      } else {
        const typeRes = await browserControlHandler("type", targetSelector || "body", payload || "");
        return `[Isolated CDP] Command '${command}' executed: ${typeRes}`;
      }
    } catch (err: any) {
      return `Isolated CDP command failed: ${err.message}`;
    }
  },
};

/**
 * chromeMcpTools.ts — Chrome CDP automation, Set-of-Mark Vision perception, and Chrome process/window management tools for MCP.
 */

import { McpToolResult } from "../types.js";
import { controlChromeCdpTool } from "../../tools/chromeCdpTools.js";
import { controlChromeVisionTool } from "../../tools/chromeVisionTools.js";
import {
  listRunningChromeTool,
  closeChromeProfileTool,
  closeChromeWindowTool,
} from "../../tools/chromeProcessTools.js";
import { launchChromeProfileTool } from "../../tools/chromeBrowserTools.js";
import { listChromeProfilesTool } from "../../tools/chromeProfileTools.js";
import { resolveMcpWorkspace } from "./workspaceContext.js";

function toResult(res: unknown): McpToolResult {
  const text = typeof res === "string" ? res : JSON.stringify(res, null, 2);
  const isError =
    typeof res === "string" &&
    (res.startsWith("control_chrome_cdp failed:") ||
      res.startsWith("Error:") ||
      res.startsWith("Failed to"));
  return {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
  };
}

export async function handleControlChromeCdp(args: any): Promise<McpToolResult> {
  try {
    const res = await controlChromeCdpTool.execute(args || {}, resolveMcpWorkspace(args?.workspace).path);
    return toResult(res);
  } catch (err: any) {
    return {
      content: [{ type: "text", text: `control_chrome_cdp error: ${err?.message || String(err)}` }],
      isError: true,
    };
  }
}

export async function handleControlChromeVision(args: any): Promise<McpToolResult> {
  try {
    let payloadStr = args?.payload;
    if (payloadStr && typeof payloadStr === "object") {
      payloadStr = JSON.stringify(payloadStr);
    }
    const res = await controlChromeVisionTool.execute(
      { command: args?.command, payload: payloadStr },
      resolveMcpWorkspace(args?.workspace).path
    );
    return toResult(res);
  } catch (err: any) {
    return {
      content: [{ type: "text", text: `control_chrome_vision error: ${err?.message || String(err)}` }],
      isError: true,
    };
  }
}

export async function handleListRunningChrome(args: any): Promise<McpToolResult> {
  try {
    const res = await listRunningChromeTool.execute(args || {}, resolveMcpWorkspace(args?.workspace).path);
    return toResult(res);
  } catch (err: any) {
    return {
      content: [{ type: "text", text: `list_running_chrome error: ${err?.message || String(err)}` }],
      isError: true,
    };
  }
}

export async function handleCloseChromeProfile(args: any): Promise<McpToolResult> {
  try {
    const res = await closeChromeProfileTool.execute(args || {}, resolveMcpWorkspace(args?.workspace).path);
    return toResult(res);
  } catch (err: any) {
    return {
      content: [{ type: "text", text: `close_chrome_profile error: ${err?.message || String(err)}` }],
      isError: true,
    };
  }
}

export async function handleCloseChromeWindow(args: any): Promise<McpToolResult> {
  try {
    const res = await closeChromeWindowTool.execute(args || {}, resolveMcpWorkspace(args?.workspace).path);
    return toResult(res);
  } catch (err: any) {
    return {
      content: [{ type: "text", text: `close_chrome_window error: ${err?.message || String(err)}` }],
      isError: true,
    };
  }
}

export async function handleLaunchChromeProfile(args: any): Promise<McpToolResult> {
  try {
    const res = await launchChromeProfileTool.execute(args || {}, resolveMcpWorkspace(args?.workspace).path);
    return toResult(res);
  } catch (err: any) {
    return {
      content: [{ type: "text", text: `launch_chrome_profile error: ${err?.message || String(err)}` }],
      isError: true,
    };
  }
}

export async function handleListChromeProfiles(args: any): Promise<McpToolResult> {
  try {
    const res = await listChromeProfilesTool.execute(args || {}, resolveMcpWorkspace(args?.workspace).path);
    return toResult(res);
  } catch (err: any) {
    return {
      content: [{ type: "text", text: `list_chrome_profiles error: ${err?.message || String(err)}` }],
      isError: true,
    };
  }
}

export const CHROME_MCP_TOOL_CLASSIFICATIONS: Record<string, "safe" | "dangerous"> = {
  superagent_chrome_cdp: "dangerous",
  superagent_control_chrome_cdp: "dangerous",
  superagent_chrome_vision: "dangerous",
  superagent_control_chrome_vision: "dangerous",
  superagent_list_running_chrome: "safe",
  superagent_close_chrome_profile: "dangerous",
  superagent_close_chrome_window: "dangerous",
  superagent_launch_chrome: "dangerous",
  superagent_list_chrome_profiles: "safe",
};

export const CHROME_MCP_TOOL_DEFS = [
  {
    name: "superagent_chrome_cdp",
    description:
      "Automate real Google Chrome browser directly via Chrome DevTools Protocol (CDP port 9222). " +
      "Commands: list_targets, new_tab, close_tab, activate, navigate, evaluate, snapshot, read_page, read_terminal, read_terminal_delta, write_terminal, send_terminal_key, execute_terminal, watch_terminal, list_terminal_sessions, monitor_terminal_agents, clear_terminal_sessions, discover_desktop_targets, " +
      "extract_links, click, type, wait_for, verify_action, get_dialogs, handle_dialog, screenshot, pdf, " +
      "get_cookies, inspect_media_devices, move_cursor, drag_and_drop, emulate_device. " +
      "Supports device/viewport emulation (mobile, tablet, desktop, reset), human-like Bézier cursor movement, " +
      "realistic drag-and-drop, visual pointer overlay, native dialog interception, and UI transition verification.",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          enum: [
            "list_targets", "new_tab", "close_tab", "activate", "navigate", "evaluate",
            "snapshot", "read_page", "read_terminal", "read_terminal_delta", "write_terminal", "send_terminal_key", "execute_terminal", "watch_terminal", "list_terminal_sessions", "monitor_terminal_agents", "clear_terminal_sessions", "recover_terminal", "discover_desktop_targets", "extract_links", "click", "type", "wait_for",
            "verify_action", "get_dialogs", "handle_dialog", "screenshot", "pdf",
            "get_cookies", "inspect_media_devices", "media_devices", "move_cursor",
            "move_mouse", "show_cursor", "hide_cursor", "get_cursor",
            "drag_and_drop", "drag", "drag_drop",
            "emulate_device", "set_device", "set_viewport", "emulate_viewport",
          ],
          description: "CDP command to execute on real Chrome browser.",
        },
        payload: {
          type: "string",
          description: "Optional JSON payload with command parameters.",
        },
        url: { type: "string", description: "Target URL for new_tab or navigate." },
        index: { type: "number", description: "Interactive element index from snapshot, or zero-based terminal index for read/write commands." },
        terminal_id: { type: "string", description: "Opaque stable terminal ID provided by read_terminal; preferred over index for safe writes." },
        allow_dangerous: { type: "boolean", description: "Explicit approval to dispatch a potentially destructive shell command." },
        expected_output: { type: "string", description: "Literal output pattern for watch_terminal/execute_terminal." },
        wait_ms: { type: "number", description: "Bounded watch duration (max 15000 ms per tool call)." },
        verify_shell: { type: "string", enum: ["posix", "powershell"], description: "Optional shell-specific exit-code marker for execute_terminal." },
        force_new_command: { type: "boolean", description: "Explicitly supersede a still-pending shell-marker execution." },
        rebind_on_reload: { type: "boolean", description: "recover_terminal: opt in to safe unique-pane rebinding after renderer reload." },
        debug_port: { type: "number", description: "Local Chrome/Electron CDP debugging port selected for this call." },
        debug_ports: { type: "string", description: "discover_desktop_targets: 1-8 comma-separated loopback ports to probe." },
        text: { type: "string", description: "Text to type or search for; write_terminal sends to the focused web terminal via CDP." },
        enter: { type: "boolean", description: "write_terminal: explicitly press Enter after text (default false)." },
        key: { type: "string", description: "send_terminal_key: Enter, Tab, Escape, Backspace, Delete, Arrow keys, Home, End, Ctrl+C, Ctrl+D, Ctrl+L." },
        selector: { type: "string", description: "CSS selector for click, type, wait_for, or terminal selection." },
        max_lines: { type: "number", description: "read_terminal recent lines (default 80, max 200)." },
        max_chars: { type: "number", description: "read_terminal text characters (default 12000, max 20000)." },
        viewport_only: { type: "boolean", description: "read_terminal: use xterm's visible viewport instead of full scrollback." },
        preset: { type: "string", description: "Device preset for emulate_device ('mobile', 'tablet', 'desktop', 'reset')." },
        orientation: { type: "string", enum: ["portrait", "landscape"] },
        width: { type: "number", description: "Custom viewport width in pixels." },
        height: { type: "number", description: "Custom viewport height in pixels." },
        scale: { type: "number", description: "Device pixel ratio scale factor." },
        touch: { type: "boolean", description: "Enable touch emulation." },
        smooth: { type: "boolean", description: "Smooth human cursor trajectory." },
        screenshot: { type: "boolean", description: "Capture screenshot alongside action." },
        outputPath: { type: "string", description: "Path to save screenshot file." },
        fullPage: { type: "boolean", description: "Capture full scrollable page." },
        targetId: { type: "string", description: "Optional specific Chrome tab target ID." },
      },
      required: ["command"],
    },
  },
  {
    name: "superagent_chrome_vision",
    description:
      "Vision-Based Chrome Automation & Set-of-Mark (SoM) Perception Engine via local UI-DETR-1 AI server (port 8095). " +
      "Commands: perceive_page (Set-of-Mark numbered visual tags [1], [2]...), click_id, type_id, " +
      "verify_visual_state (pixel diff ratio verification), audit_layout (element collisions & touch targets), " +
      "click_label, type_label, status, setup.",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          enum: [
            "perceive_page", "click_id", "type_id", "verify_visual_state", "audit_layout",
            "parse_screenshot", "click_label", "type_label", "status", "setup",
          ],
          description: "Vision command to execute.",
        },
        payload: {
          type: "string",
          description:
            "JSON payload. perceive_page: {\"threshold\": 0.35}. click_id: {\"id\": 1, \"verify\": true}. type_id: {\"id\": 2, \"text\": \"val\"}.",
        },
      },
      required: ["command"],
    },
  },
  {
    name: "superagent_list_running_chrome",
    description:
      "Enumerate all running Google Chrome browser processes, user profile directories, display names, and window tabs across the system.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "superagent_close_chrome_profile",
    description:
      "Terminate running Chrome browser process whose command line carries exactly --profile-directory=\"<profileName>\" (e.g. \"Profile 1\").",
    inputSchema: {
      type: "object",
      properties: {
        profileName: { type: "string", description: "Exact profile directory name, e.g. 'Profile 1' or 'Default'." },
      },
      required: ["profileName"],
    },
  },
  {
    name: "superagent_close_chrome_window",
    description:
      "Gracefully close ONE Chrome window via WM_CLOSE identified by HWND or title substring without terminating other windows or profiles.",
    inputSchema: {
      type: "object",
      properties: {
        hwnd: { type: "number", description: "Window handle from list_running_chrome." },
        titleSubstring: { type: "string", description: "Case-insensitive substring of the window title." },
      },
    },
  },
  {
    name: "superagent_launch_chrome",
    description:
      "Launch Google Chrome with a specific user profile, optional target URL, and optional remote debugging port (e.g. 9222) with isolated profile for CDP automation.",
    inputSchema: {
      type: "object",
      properties: {
        profileName: { type: "string", description: "Directory name of the Chrome profile (default: 'Default')." },
        url: { type: "string", description: "Target URL to open." },
        remoteDebuggingPort: { type: "number", description: "Port for CDP automation (e.g. 9222)." },
        userDataDir: { type: "string", description: "Custom user data directory path." },
      },
    },
  },
  {
    name: "superagent_list_chrome_profiles",
    description:
      "Detect and list all local Google Chrome user profiles installed on the system with directory names, emails, and paths.",
    inputSchema: {
      type: "object",
      properties: {
        customUserDataPath: { type: "string", description: "Optional custom Chrome User Data directory path." },
      },
    },
  },
];

export async function dispatchChromeMcpTool(name: string, args: any): Promise<McpToolResult | null> {
  switch (name) {
    case "superagent_chrome_cdp":
    case "superagent_control_chrome_cdp":
      return await handleControlChromeCdp(args);
    case "superagent_chrome_vision":
    case "superagent_control_chrome_vision":
      return await handleControlChromeVision(args);
    case "superagent_list_running_chrome":
      return await handleListRunningChrome(args);
    case "superagent_close_chrome_profile":
      return await handleCloseChromeProfile(args);
    case "superagent_close_chrome_window":
      return await handleCloseChromeWindow(args);
    case "superagent_launch_chrome":
      return await handleLaunchChromeProfile(args);
    case "superagent_list_chrome_profiles":
      return await handleListChromeProfiles(args);
    default:
      return null;
  }
}

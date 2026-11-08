import type { McpToolResult } from "../types.js";
import {
  DEFAULT_MAX_IMAGE_BYTES,
  DESKTOP_UI_DISCOVERY_COMMANDS,
  MAX_SESSION_TTL_MS,
  MIN_SESSION_TTL_MS,
  assertDesktopUiDiscoveryCommandFields,
  assertNoDesktopUiRawCoordinates,
  desktopUiSessionManager,
  sanitizeDesktopUiLogText,
  type ActionParams,
} from "../../tools/desktopUiTools.js";
import {
  DesktopUiError,
  MAX_WINDOW_DISCOVERY_LIMIT,
  type DesktopKey,
  type DesktopModifier,
} from "../../desktopUi/index.js";

export const DESKTOP_UI_MCP_TOOL_CLASSIFICATIONS: Record<string, "safe" | "dangerous"> = {
  superagent_desktop_ui: "dangerous",
};

export interface DesktopUiMcpContext {
  principalId: string;
  workspace: string;
}

const actionKinds = ["click", "type", "key", "scroll"] as const;
const commands = ["probe", ...DESKTOP_UI_DISCOVERY_COMMANDS, "open", "snapshot", "action", "close"] as const;

const inputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    command: {
      type: "string",
      enum: commands,
      description: "Desktop UI command to execute.",
    },
    action: {
      type: "string",
      enum: [...commands, ...actionKinds],
      description: "Alternative command or action kind. command='action' with action='click' is supported.",
    },
    subAction: {
      type: "string",
      enum: actionKinds,
      description: "Explicit action kind when command='action'.",
    },
    limit: { type: "integer", minimum: 1, maximum: MAX_WINDOW_DISCOVERY_LIMIT, description: "Bounded discovery result limit; default 50, hard cap 100." },
    query: { type: "string", minLength: 1, maxLength: 256, description: "Case-insensitive application/title query for find_window." },
    pid: { type: "integer", minimum: 1, description: "Exact process ID for open/inspect_window or optional find_window filter." },
    nativeId: { type: "string", minLength: 1, maxLength: 256, description: "Exact native window ID for open/inspect_window." },
    title: { type: "string", minLength: 1, maxLength: 512, description: "Window title metadata; never authorization." },
    allowInput: {
      type: "boolean",
      description: "Request native input. Exact host consent is still required at dispatch time.",
    },
    enableVision: {
      type: "boolean",
      description: "Request local UI-DETR perception. Default false; trusted host upload opt-in or auth is required.",
    },
    visionEndpoint: {
      type: "string",
      maxLength: 2048,
      description: "Loopback UI-DETR endpoint. The host controls screenshot-upload authorization.",
    },
    ttlMs: {
      type: "integer",
      minimum: MIN_SESSION_TTL_MS,
      maximum: MAX_SESSION_TTL_MS,
      description: "Absolute session TTL; activity never extends it.",
    },
    sessionToken: {
      type: "string",
      minLength: 64,
      maxLength: 64,
      pattern: "^[a-fA-F0-9]{64}$",
      description: "Opaque token returned by open; bound to the authenticated MCP principal.",
    },
    includeScreenshotImage: {
      type: "boolean",
      description: "Include bounded base64 target-window screenshot bytes. Default false.",
    },
    maxImageBytes: {
      type: "integer",
      minimum: 1,
      maximum: DEFAULT_MAX_IMAGE_BYTES,
      description: "Hard screenshot response cap.",
    },
    expectedRevision: { type: "integer", minimum: 1, description: "Exact prior perception revision." },
    expectedHash: {
      type: "string",
      pattern: "^[a-fA-F0-9]{64}$",
      description: "Exact prior target-window screenshot SHA-256.",
    },
    elementId: {
      type: "string",
      minLength: 1,
      maxLength: 128,
      description: "Accessibility-backed semantic element ID. Raw coordinates are forbidden.",
    },
    text: { type: "string", maxLength: 32768, description: "Text for semantic type action." },
    key: {
      type: "string",
      enum: [
        "ENTER", "TAB", "ESCAPE", "BACKSPACE", "DELETE",
        "ARROW_UP", "ARROW_DOWN", "ARROW_LEFT", "ARROW_RIGHT",
        "HOME", "END", "PAGE_UP", "PAGE_DOWN", "SPACE",
      ],
    },
    modifiers: {
      type: "array",
      maxItems: 4,
      uniqueItems: true,
      items: { type: "string", enum: ["CTRL", "ALT", "SHIFT", "META"] },
    },
    deltaX: { type: "integer", minimum: -3, maximum: 3 },
    deltaY: { type: "integer", minimum: -3, maximum: 3 },
  },
} as const;

export const DESKTOP_UI_MCP_TOOL_DEFS = [
  {
    name: "superagent_desktop_ui",
    description:
      "Dangerous host-local native desktop perception and semantic input for Windows, macOS, and Linux, including read-only window discovery and inspection. "
      + "Discovery uses bounded exact native identities; sessions are scoped to an exact PID/nativeId and authenticated MCP principal. "
      + "Input additionally requires exact host consent, raw coordinates are forbidden, and every action requires the exact prior revision/SHA-256. "
      + "This tool is unavailable for SSH/chain workspaces. Chrome/Electron browser automation remains on the existing protected CDP tools.",
    inputSchema,
  },
];

function isRemoteWorkspace(workspace: string): boolean {
  return /^(?:ssh|chain):/i.test(workspace.trim());
}

function errorResult(code: string, error: string): McpToolResult {
  return {
    content: [{
      type: "text",
      text: JSON.stringify({ success: false, isError: true, code, error }, null, 2),
    }],
    isError: true,
  };
}

function resolveCommand(rawArgs: Record<string, unknown>): { command: string; rawAction: string } {
  let command = typeof rawArgs.command === "string" ? rawArgs.command.trim().toLowerCase() : "";
  const rawAction = typeof rawArgs.action === "string" ? rawArgs.action.trim().toLowerCase() : "";
  if (!command) {
    command = commands.includes(rawAction as (typeof commands)[number])
      ? rawAction
      : actionKinds.includes(rawAction as (typeof actionKinds)[number])
        ? "action"
        : "";
  }
  return { command, rawAction };
}

export async function dispatchDesktopUiMcpTool(
  name: string,
  args: unknown,
  context?: DesktopUiMcpContext,
): Promise<McpToolResult | null> {
  if (name !== "superagent_desktop_ui") return null;

  if (!context?.principalId?.trim()) {
    return errorResult("AUTH_REQUIRED", "An authenticated MCP principal is required for native desktop UI.");
  }
  if (!context.workspace || isRemoteWorkspace(context.workspace)) {
    return errorResult(
      "LOCAL_HOST_REQUIRED",
      "Native desktop UI is host-local and cannot run while an SSH or chain workspace is targeted.",
    );
  }

  const rawArgs = args && typeof args === "object" && !Array.isArray(args)
    ? args as Record<string, unknown>
    : {};

  try {
    assertNoDesktopUiRawCoordinates(rawArgs);
    const { command, rawAction } = resolveCommand(rawArgs);
    if (!command) {
      throw new DesktopUiError("INVALID_ACTION", "Missing desktop UI command.");
    }
    assertDesktopUiDiscoveryCommandFields(rawArgs, command);

    let result: unknown;
    switch (command) {
      case "probe":
        result = { success: true, capabilities: await desktopUiSessionManager.probe() };
        break;
      case "list_windows":
        result = { success: true, ...(await desktopUiSessionManager.listWindows({ limit: typeof rawArgs.limit === "number" ? rawArgs.limit : undefined })) };
        break;
      case "get_active_window":
        result = { success: true, window: await desktopUiSessionManager.getActiveWindow() };
        break;
      case "find_window":
        result = { success: true, ...(await desktopUiSessionManager.findWindow({ query: rawArgs.query, pid: typeof rawArgs.pid === "number" ? rawArgs.pid : undefined, limit: typeof rawArgs.limit === "number" ? rawArgs.limit : undefined })) };
        break;
      case "inspect_window":
        result = { success: true, ...(await desktopUiSessionManager.inspectWindow({ pid: Number(rawArgs.pid), nativeId: rawArgs.nativeId, ownerPrincipal: context.principalId, includeScreenshotImage: rawArgs.includeScreenshotImage === true, maxImageBytes: typeof rawArgs.maxImageBytes === "number" ? rawArgs.maxImageBytes : undefined })) };
        break;
      case "open": {
        const session = await desktopUiSessionManager.openSession({
          pid: Number(rawArgs.pid),
          nativeId: String(rawArgs.nativeId ?? ""),
          title: String(rawArgs.title ?? ""),
          ownerPrincipal: context.principalId,
          allowInput: rawArgs.allowInput === true,
          enableVision: rawArgs.enableVision === true,
          visionEndpoint: typeof rawArgs.visionEndpoint === "string" ? rawArgs.visionEndpoint : undefined,
          ttlMs: typeof rawArgs.ttlMs === "number" ? rawArgs.ttlMs : undefined,
        });
        result = { success: true, session };
        break;
      }
      case "snapshot": {
        const snapshot = await desktopUiSessionManager.snapshot({
          sessionToken: String(rawArgs.sessionToken ?? ""),
          ownerPrincipal: context.principalId,
          includeScreenshotImage: rawArgs.includeScreenshotImage === true,
          maxImageBytes: typeof rawArgs.maxImageBytes === "number" ? rawArgs.maxImageBytes : undefined,
        });
        result = { success: true, ...snapshot };
        break;
      }
      case "action": {
        const subAction = (
          actionKinds.includes(rawAction as (typeof actionKinds)[number])
            ? rawAction
            : rawArgs.subAction
        ) as ActionParams["action"];
        const receipt = await desktopUiSessionManager.action({
          sessionToken: String(rawArgs.sessionToken ?? ""),
          ownerPrincipal: context.principalId,
          action: subAction,
          expectedRevision: Number(rawArgs.expectedRevision),
          expectedHash: String(rawArgs.expectedHash ?? ""),
          elementId: typeof rawArgs.elementId === "string" ? rawArgs.elementId : undefined,
          text: typeof rawArgs.text === "string" ? rawArgs.text : undefined,
          key: rawArgs.key as DesktopKey | undefined,
          modifiers: Array.isArray(rawArgs.modifiers) ? rawArgs.modifiers as DesktopModifier[] : undefined,
          deltaX: typeof rawArgs.deltaX === "number" ? rawArgs.deltaX : undefined,
          deltaY: typeof rawArgs.deltaY === "number" ? rawArgs.deltaY : undefined,
        });
        result = { success: true, receipt };
        break;
      }
      case "close":
        result = {
          success: true,
          ...desktopUiSessionManager.closeSession(String(rawArgs.sessionToken ?? ""), context.principalId),
        };
        break;
      default:
        throw new DesktopUiError(
          "INVALID_ACTION",
          `Unknown desktop UI command '${command}'.`,
        );
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (error: any) {
    const code = error?.code || "DESKTOP_UI_ERROR";
    const message = sanitizeDesktopUiLogText(error?.message || String(error)) || "Desktop UI error";
    return errorResult(code, message);
  }
}

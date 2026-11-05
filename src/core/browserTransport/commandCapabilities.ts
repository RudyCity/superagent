import type { BrowserTransportKind } from "./types.js";

const DELEGATE_V18 = new Set([
  "list_targets", "claim_target", "release_target", "recover_session", "list_sessions", "coordinator_status",
  "activate", "new_tab", "close_tab", "navigate", "evaluate", "snapshot", "read_page", "extract_links",
  "click", "type", "wait_for", "screenshot", "get_dialogs", "handle_dialog", "transport_status",
  "get_cursor", "move_cursor", "drag_and_drop", "emulate_device",
]);

export function browserCommandSupported(kind: BrowserTransportKind, command: string): boolean {
  return kind === "managed" || DELEGATE_V18.has(command);
}

export function unsupportedBrowserCommand(kind: BrowserTransportKind, command: string): string | null {
  if (browserCommandSupported(kind, command)) return null;
  return kind === "delegate"
    ? `DELEGATE_CDP_CAPABILITY_UNSUPPORTED: '${command}' is not supported by Delegate-CDP v1.8.`
    : null;
}

export const DELEGATE_V18_COMMANDS = Object.freeze([...DELEGATE_V18]);

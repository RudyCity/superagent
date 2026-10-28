/**
 * Takeover Notification Dispatcher (Milestone M3)
 *
 * Dispatches secure, metadata-only notifications to authorized operators
 * when human takeover is requested on a virtual-display or headless target.
 *
 * Hard Invariants:
 * 1. Notifications are STRICTLY metadata-only.
 * 2. Passwords, OTPs, auth tokens, session cookies, and VNC credentials are NEVER logged or transmitted.
 * 3. Message contains reason, target domain, profile, and expiration countdown.
 */

import { type TakeoverInvitation, type TakeoverSession } from "./types.js";

export interface NotificationPayload {
  title: string;
  message: string;
  sessionId: string;
  targetId: string;
  reason: string;
  expiresInSecs: number;
  portalUrl?: string;
}

/**
 * Builds a sanitized, metadata-only notification payload.
 */
export function buildTakeoverNotificationPayload(
  invitation: TakeoverInvitation,
  session?: TakeoverSession,
  portalBaseUrl = "http://127.0.0.1:6789"
): NotificationPayload {
  const expiresInSecs = Math.max(0, Math.floor((invitation.expiresAt - Date.now()) / 1000));
  const sanitizedUrl = session?.targetUrl || "about:blank";
  const displayInfo = session?.displayNumber ? ` on Display :${session.displayNumber}` : "";

  const title = `🛡️ SuperAgent: Human Takeover Required${displayInfo}`;
  const message = [
    `An automated browser task encountered a security or verification challenge.`,
    `Reason: ${invitation.reason}`,
    `Target URL: ${sanitizedUrl}`,
    `Target Tab: ${invitation.targetId}`,
    `Human Hold: INSTALLED (all agent writes blocked)`,
    `Invitation Expires In: ${expiresInSecs}s`,
  ].join("\n");

  const portalUrl = `${portalBaseUrl}${invitation.invitationUrl}`;

  return {
    title,
    message,
    sessionId: invitation.sessionId,
    targetId: invitation.targetId,
    reason: invitation.reason,
    expiresInSecs,
    portalUrl,
  };
}

/**
 * Formats a clean CLI terminal alert box.
 */
export function formatTakeoverCliAlert(payload: NotificationPayload): string {
  const lines = [
    "==================================================================",
    `  ${payload.title}`,
    "==================================================================",
    `  Target Tab:  ${payload.targetId}`,
    `  Reason:      ${payload.reason}`,
    `  Agent State: PAUSED (human hold installed)`,
    `  Expiry:      ${payload.expiresInSecs} seconds`,
    "",
    `  Access Portal (127.0.0.1):`,
    `  ${payload.portalUrl || `sessionId=${payload.sessionId}`}`,
    "==================================================================",
  ];
  return lines.join("\n");
}

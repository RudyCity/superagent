/**
 * Takeover UI (Milestone M3)
 *
 * Generates the responsive, anti-slop Human Takeover landing page.
 * Provides live session state observation, one-time invitation redemption,
 * noVNC interactive canvas, live countdown timer, and explicit Return to Agent controls.
 *
 * Design Guidelines:
 * - Anti-slop / Design Taste: High-contrast utilitarian dark theme, purposeful typography,
 *   crisp status badges, responsive mobile/desktop layout, zero external unvetted CDN dependencies.
 * - Security: Strict escaping of all session attributes to eliminate XSS.
 */

import { type TakeoverSession } from "./types.js";

function escapeHtml(str?: string): string {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function renderTakeoverHtml(session: TakeoverSession, token?: string): string {
  const safeSessionId = escapeHtml(session.sessionId);
  const safeTargetId = escapeHtml(session.targetId);
  const safeReason = escapeHtml(session.reason);
  const safeTargetUrl = escapeHtml(session.targetUrl || "about:blank");
  const safeProfile = escapeHtml(session.profileId);
  const safeState = escapeHtml(session.state);
  const safeToken = escapeHtml(token || "");
  const remainingSecs = Math.max(0, Math.floor((session.invitationExpiresAt - Date.now()) / 1000));

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SuperAgent // Secure Human Takeover</title>
  <style>
    :root {
      --bg: #0b0f19;
      --card-bg: #111827;
      --border: #1f2937;
      --border-focus: #374151;
      --text: #f3f4f6;
      --text-muted: #9ca3af;
      --accent: #10b981;
      --accent-hover: #059669;
      --danger: #ef4444;
      --danger-hover: #dc2626;
      --warning: #f59e0b;
      --warning-bg: rgba(245, 158, 11, 0.1);
      --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      --font-sans: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: var(--bg);
      color: var(--text);
      font-family: var(--font-sans);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }
    header {
      background-color: var(--card-bg);
      border-bottom: 1px solid var(--border);
      padding: 0.75rem 1.25rem;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 0.75rem;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      font-weight: 600;
      letter-spacing: -0.02em;
    }
    .brand-tag {
      background-color: #1e293b;
      color: #38bdf8;
      font-family: var(--font-mono);
      font-size: 0.75rem;
      padding: 0.15rem 0.4rem;
      border-radius: 4px;
      font-weight: 500;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      font-family: var(--font-mono);
      font-size: 0.75rem;
      padding: 0.2rem 0.6rem;
      border-radius: 9999px;
      font-weight: 600;
      background: var(--warning-bg);
      color: var(--warning);
      border: 1px solid rgba(245, 158, 11, 0.3);
    }
    .badge.active {
      background: rgba(16, 185, 129, 0.1);
      color: var(--accent);
      border-color: rgba(16, 185, 129, 0.3);
    }
    .badge.verifying {
      background: rgba(56, 189, 248, 0.1);
      color: #38bdf8;
      border-color: rgba(56, 189, 248, 0.3);
    }
    .meta-bar {
      background-color: #0d1322;
      border-bottom: 1px solid var(--border);
      padding: 0.5rem 1.25rem;
      display: flex;
      gap: 1.5rem;
      font-size: 0.825rem;
      color: var(--text-muted);
      overflow-x: auto;
      white-space: nowrap;
    }
    .meta-item strong {
      color: var(--text);
      font-weight: 500;
    }
    main {
      flex: 1;
      display: flex;
      flex-direction: column;
      position: relative;
      background: #000;
    }
    #viewport-container {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      position: relative;
      min-height: 480px;
    }
    #vnc-screen {
      width: 100%;
      height: 100%;
      min-height: 480px;
      overflow: hidden;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
    }
    .overlay {
      position: absolute;
      inset: 0;
      background: rgba(11, 15, 25, 0.88);
      backdrop-filter: blur(4px);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 1.5rem;
      text-align: center;
      z-index: 20;
    }
    .overlay.hidden { display: none; }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 1.75rem;
      max-width: 480px;
      width: 100%;
    }
    .card h2 {
      font-size: 1.25rem;
      margin-bottom: 0.5rem;
      letter-spacing: -0.02em;
    }
    .card p {
      color: var(--text-muted);
      font-size: 0.875rem;
      line-height: 1.5;
      margin-bottom: 1.25rem;
    }
    .controls-bar {
      background: var(--card-bg);
      border-top: 1px solid var(--border);
      padding: 0.75rem 1.25rem;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
      flex-wrap: wrap;
    }
    .timer {
      font-family: var(--font-mono);
      font-size: 0.875rem;
      color: var(--text-muted);
      display: flex;
      align-items: center;
      gap: 0.4rem;
    }
    .btn-group {
      display: flex;
      gap: 0.5rem;
    }
    button {
      font-family: var(--font-sans);
      font-size: 0.875rem;
      font-weight: 500;
      padding: 0.5rem 1rem;
      border-radius: 6px;
      border: 1px solid transparent;
      cursor: pointer;
      transition: background 0.15s, border-color 0.15s;
    }
    button.btn-primary {
      background-color: var(--accent);
      color: #fff;
    }
    button.btn-primary:hover {
      background-color: var(--accent-hover);
    }
    button.btn-danger {
      background-color: transparent;
      border-color: rgba(239, 68, 68, 0.4);
      color: var(--danger);
    }
    button.btn-danger:hover {
      background-color: rgba(239, 68, 68, 0.1);
      border-color: var(--danger);
    }
    button.btn-secondary {
      background-color: #1e293b;
      border-color: var(--border);
      color: var(--text);
    }
    button.btn-secondary:hover {
      background-color: #334155;
    }
    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <span>🛡️ SuperAgent</span>
      <span class="brand-tag">M3 HITL</span>
    </div>
    <div style="display:flex; align-items:center; gap:0.75rem;">
      <span id="session-badge" class="badge ${session.state === "HUMAN_ACTIVE" ? "active" : session.state === "VERIFYING" ? "verifying" : ""}">
        ● ${safeState}
      </span>
      <span class="timer" id="timer-display">⏱️ Exp: ${remainingSecs}s</span>
    </div>
  </header>

  <div class="meta-bar">
    <div class="meta-item">Target: <strong>${safeTargetUrl}</strong></div>
    <div class="meta-item">Reason: <strong>${safeReason}</strong></div>
    <div class="meta-item">Profile: <strong>${safeProfile}</strong></div>
    <div class="meta-item">Tab ID: <strong style="font-family:var(--font-mono);">${safeTargetId}</strong></div>
  </div>

  <main>
    <div id="viewport-container">
      <div id="state-overlay" class="overlay ${session.state === "HUMAN_ACTIVE" ? "hidden" : ""}">
        <div class="card">
          <h2 id="overlay-title">Human Verification Required</h2>
          <p id="overlay-desc">
            An automated agent was paused on a security challenge (e.g. login, OTP, CAPTCHA).
            A verified human hold has fenced all agent mutations on this browser target.
          </p>
          <div style="display:flex; flex-direction:column; gap:0.5rem;">
            ${session.state === "HUMAN_READY" ? `
              <button id="btn-redeem" class="btn-primary" onclick="redeemSession()">Start Takeover Session</button>
            ` : session.state === "VERIFYING" ? `
              <button disabled class="btn-secondary">Verifying Return State...</button>
            ` : session.state === "AGENT_ACTIVE" ? `
              <button disabled class="btn-primary">Takeover Complete — Agent Resumed</button>
            ` : `
              <button disabled class="btn-secondary">Session ${safeState}</button>
            `}
          </div>
        </div>
      </div>
      <div id="vnc-screen" role="application" aria-label="Remote browser display"></div>
    </div>

    <div class="controls-bar">
      <div style="font-size:0.825rem; color:var(--text-muted);">
        🔒 Agent mutations are frozen until explicit Return to Agent.
      </div>
      <div class="btn-group">
        <button id="btn-return" class="btn-primary" onclick="returnToAgent()" ${session.state !== "HUMAN_ACTIVE" ? "disabled" : ""}>
          Return to Agent
        </button>
        <button id="btn-cancel" class="btn-danger" onclick="cancelTakeover()">
          Cancel / Pause
        </button>
      </div>
    </div>
  </main>

  <script>
    const sessionId = "${safeSessionId}";
    const token = "${safeToken}";
    let currentState = "${safeState}";
    let operatorToken = null;
    let vncPassword = null;
    let rfbClient = null;
    let countdownSecs = ${remainingSecs};

    // Countdown Timer
    const timerInterval = setInterval(() => {
      if (countdownSecs > 0) {
        countdownSecs--;
        document.getElementById("timer-display").innerText = "⏱️ Exp: " + countdownSecs + "s";
      } else {
        clearInterval(timerInterval);
        document.getElementById("timer-display").innerText = "⏱️ Expired";
        if (currentState !== "AGENT_ACTIVE") {
          showOverlay("Session Expired", "The session or invitation TTL has elapsed. The browser target remains paused for security.");
        }
      }
    }, 1000);

    function showOverlay(title, desc) {
      document.getElementById("overlay-title").innerText = title;
      document.getElementById("overlay-desc").innerText = desc;
      document.getElementById("state-overlay").classList.remove("hidden");
    }

    async function redeemSession() {
      const btn = document.getElementById("btn-redeem");
      if (btn) btn.disabled = true;
      try {
        const res = await fetch("/api/browser/takeover/redeem", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, invitationToken: token })
        });
        const data = await res.json();
        if (data.success && data.operatorToken) {
          operatorToken = data.operatorToken;
          vncPassword = data.vncPassword || null;
          // Clear the invitation secret from address bar/history immediately.
          window.history.replaceState({}, document.title, "/api/browser/takeover/ui");
          currentState = "HUMAN_ACTIVE";
          document.getElementById("state-overlay").classList.add("hidden");
          document.getElementById("session-badge").className = "badge active";
          document.getElementById("session-badge").innerText = "● HUMAN_ACTIVE";
          document.getElementById("btn-return").disabled = false;
          initVncStream();
        } else {
          alert("Failed to redeem invitation: " + (data.error || "Unknown error"));
          if (btn) btn.disabled = false;
        }
      } catch (err) {
        alert("Network error: " + err.message);
        if (btn) btn.disabled = false;
      }
    }

    async function returnToAgent() {
      if (!confirm("Are you ready to return control to the agent? Remote input will be revoked immediately.")) return;
      document.getElementById("btn-return").disabled = true;
      if (rfbClient) { try { rfbClient.disconnect(); } catch {} rfbClient = null; }
      showOverlay("Returning Control...", "Revoking remote input and verifying live browser identity.");
      try {
        const res = await fetch("/api/browser/takeover/return", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, operatorToken })
        });
        const data = await res.json();
        if (data.success) {
          currentState = "AGENT_ACTIVE";
          showOverlay("Takeover Complete", "Target identity verified. Human hold released. Agent has resumed execution.");
          document.getElementById("session-badge").className = "badge";
          document.getElementById("session-badge").innerText = "● AGENT_ACTIVE";
        } else {
          showOverlay("Review Required", "Handoff paused: " + (data.error || "Verification flagged for review."));
        }
      } catch (err) {
        showOverlay("Error", "Return failed: " + err.message);
      }
    }

    async function cancelTakeover() {
      if (!confirm("Cancel this takeover session? The browser target will remain safely paused.")) return;
      try {
        await fetch("/api/browser/takeover/cancel", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, operatorToken, invitationToken: token, reason: "Cancelled by user" })
        });
        showOverlay("Takeover Cancelled", "Session cancelled. The browser target remains paused.");
        document.getElementById("session-badge").innerText = "● CANCELLED";
        document.getElementById("btn-return").disabled = true;
      } catch (err) {
        alert("Failed to cancel: " + err.message);
      }
    }

    async function initVncStream() {
      try {
        if (!operatorToken) throw new Error("Operator session capability missing.");
        const module = await import("/api/browser/takeover/vendor/core/rfb.js");
        const RFB = module.default;
        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        const wsUrl = protocol + "//" + window.location.host +
          "/api/browser/takeover/ws?sessionId=" + encodeURIComponent(sessionId);
        const viewport = document.getElementById("vnc-screen");
        rfbClient = new RFB(viewport, wsUrl, { wsProtocols: ["binary", "operator." + operatorToken] });
        rfbClient.addEventListener("credentialsrequired", () => {
          if (vncPassword) rfbClient.sendCredentials({ password: vncPassword });
          else showOverlay("VNC Credentials Unavailable", "An authorized local VNC credential is required.");
        });
        rfbClient.scaleViewport = true;
        rfbClient.resizeSession = false;
        rfbClient.viewOnly = false;
        rfbClient.clipViewport = true;
        rfbClient.addEventListener("disconnect", () => {
          if (currentState === "HUMAN_ACTIVE") {
            showOverlay("Connection Interrupted", "Browser input disconnected. Agent remains paused.");
          }
        });
      } catch (err) {
        showOverlay("Viewer Unavailable", "Unable to initialize noVNC: " + (err.message || String(err)));
      }
    }
  </script>
</body>
</html>`;
}

"use strict";

/**
 * SuperAgent Chrome Delegate Controller for SuperAgent Tray.
 * Manages WebSocket bridge listener (ws://127.0.0.1:17341), pairing code generation,
 * active Chrome extension profiles, and manual client disconnections.
 */

(function () {
  const $ = (id) => document.getElementById(id);

  const delegateState = {
    running: false,
    port: 17341,
    endpoint: "ws://127.0.0.1:17341",
    activeProfiles: [],
    openSockets: 0,
    pairingCode: null,
    pairingExpiresAt: null,
    pairingTtlMs: null,
    authMode: "pairing_required",
    loading: false,
    pollTimer: null,
    countdownTimer: null,
  };

  const escapeHtml = (str) =>
    String(str ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[char]));

  const timeFormat = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  function formatTime(ms) {
    if (!ms) return "-";
    try {
      return timeFormat.format(new Date(ms));
    } catch {
      return String(ms);
    }
  }

  function formatDuration(ms) {
    if (!ms) return "just now";
    const sec = Math.floor(ms / 1000);
    if (sec < 60) return `${sec}s ago`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hrs = Math.floor(min / 60);
    return `${hrs}h ${min % 60}m ago`;
  }

  async function invokeDelegate(action, payload) {
    const invoke = window.__TAURI__?.core?.invoke;
    if (typeof invoke === "function") {
      if (action === "status") {
        return invoke("get_delegate_status");
      }
      return invoke("delegate_action", { action, payload: payload ?? null });
    }

    // HTTP loopback fallback
    let url = "/api/desktop/delegate/status";
    let method = "GET";
    let body = undefined;

    if (action === "renew-code") {
      url = "/api/desktop/delegate/renew-pair-code";
      method = "POST";
    } else if (action === "disconnect") {
      url = "/api/desktop/delegate/disconnect";
      method = "POST";
      body = JSON.stringify(payload);
    } else if (action === "start" || action === "stop") {
      url = "/api/desktop/delegate/lifecycle";
      method = "POST";
      body = JSON.stringify({ action });
    }

    const res = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body,
    });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || `HTTP ${res.status}`);
    }
    return res.json();
  }

  async function fetchDelegateStatus() {
    if (delegateState.loading) return;
    delegateState.loading = true;

    const refreshBtn = $("delegate-refresh-btn");
    if (refreshBtn) refreshBtn.disabled = true;

    try {
      const data = await invokeDelegate("status");
      if (data) {
        delegateState.running = data.running === true;
        delegateState.port = data.port || 17341;
        delegateState.endpoint = data.endpoint || `ws://127.0.0.1:${delegateState.port}`;
        delegateState.activeProfiles = data.activeProfiles || [];
        delegateState.openSockets = data.openSockets || 0;
        delegateState.pairingCode = data.pairingCode || null;
        delegateState.pairingExpiresAt = data.pairingExpiresAt || null;
        delegateState.pairingTtlMs = data.pairingTtlMs || null;
        delegateState.authMode = data.authMode || "pairing_required";

        renderDelegateUI();
      }
    } catch (err) {
      console.warn("[Delegate] Failed to fetch status:", err);
      delegateState.running = false;
      renderDelegateUI();
    } finally {
      delegateState.loading = false;
      if (refreshBtn) refreshBtn.disabled = false;
    }
  }

  function startCountdown() {
    if (delegateState.countdownTimer) {
      clearInterval(delegateState.countdownTimer);
      delegateState.countdownTimer = null;
    }

    function update() {
      const countdownEl = $("delegate-pair-countdown");
      if (!countdownEl) return;

      if (!delegateState.pairingExpiresAt || !delegateState.pairingCode) {
        countdownEl.textContent = "No active pairing code";
        countdownEl.className = "pair-countdown-chip expired";
        return;
      }

      const remMs = delegateState.pairingExpiresAt - Date.now();
      if (remMs <= 0) {
        countdownEl.textContent = "Expired";
        countdownEl.className = "pair-countdown-chip expired";
        delegateState.pairingCode = null;
        renderPairingCodeBox();
        return;
      }

      const sec = Math.floor(remMs / 1000) % 60;
      const min = Math.floor(remMs / 60000);
      countdownEl.textContent = `Valid for ${min}m ${sec < 10 ? "0" : ""}${sec}s`;
      countdownEl.className = "pair-countdown-chip active";
    }

    update();
    delegateState.countdownTimer = setInterval(update, 1000);
  }

  function renderPairingCodeBox() {
    const codeEl = $("delegate-pair-code");
    const copyBtn = $("delegate-pair-copy");
    if (!codeEl) return;

    if (delegateState.pairingCode) {
      codeEl.textContent = delegateState.pairingCode;
      codeEl.classList.remove("empty");
      if (copyBtn) copyBtn.disabled = false;
    } else {
      codeEl.textContent = "---- ----";
      codeEl.classList.add("empty");
      if (copyBtn) copyBtn.disabled = true;
    }
  }

  function renderDelegateUI() {
    // 1. Header / Listener Status
    const statusDot = $("delegate-status-dot");
    const statusText = $("delegate-status-text");
    const toggleBtn = $("delegate-listener-toggle");
    const endpointEl = $("delegate-endpoint-val");

    if (statusDot) {
      statusDot.className = delegateState.running ? "status-dot online" : "status-dot offline";
    }
    if (statusText) {
      statusText.textContent = delegateState.running ? "Listener Active" : "Listener Stopped";
    }
    if (endpointEl) {
      endpointEl.textContent = delegateState.endpoint;
    }
    if (toggleBtn) {
      toggleBtn.textContent = delegateState.running ? "Stop Listener" : "Start Listener";
      toggleBtn.className = delegateState.running ? "button ghost danger" : "button primary";
    }

    // 2. Summary stats
    const totalClientsEl = $("delegate-stat-clients");
    const openSocketsEl = $("delegate-stat-sockets");
    const authModeEl = $("delegate-stat-authmode");

    if (totalClientsEl) totalClientsEl.textContent = String(delegateState.activeProfiles.length);
    if (openSocketsEl) openSocketsEl.textContent = String(delegateState.openSockets);
    if (authModeEl) {
      authModeEl.textContent = delegateState.authMode === "pairing_required" ? "Pairing Protected" : "Development";
    }

    // 3. Pairing Code & Countdown
    renderPairingCodeBox();
    startCountdown();

    // 4. Profiles Table
    const tbody = $("delegate-profiles-tbody");
    if (!tbody) return;

    if (!delegateState.activeProfiles.length) {
      tbody.innerHTML = `<tr>
        <td colspan="5" class="empty-state">
          No Chrome extensions currently connected.<br />
          <small class="text-secondary">Open your Chrome extension popup and enter the pairing code above.</small>
        </td>
      </tr>`;
      return;
    }

    const now = Date.now();
    tbody.innerHTML = delegateState.activeProfiles
      .map((client) => {
        const connectedSince = formatDuration(now - client.connectedAt);
        const exactTime = formatTime(client.connectedAt);
        return `<tr class="delegate-client-row" data-client-id="${escapeHtml(client.clientId)}">
          <td>
            <div class="client-name-cell">
              <strong class="client-label">${escapeHtml(client.label || "Chrome Delegate")}</strong>
              <small class="client-id font-mono">${escapeHtml(client.clientId)}</small>
            </div>
          </td>
          <td>
            <code class="extension-id-badge font-mono" title="${escapeHtml(client.extensionId)}">${escapeHtml(client.extensionId)}</code>
          </td>
          <td>
            <span class="pill">
              <span class="pill-dot"></span>
              Connected
            </span>
          </td>
          <td>
            <span class="connect-time" title="${escapeHtml(exactTime)}">${escapeHtml(connectedSince)}</span>
          </td>
          <td class="text-right">
            <button type="button" class="button ghost sm danger client-disconnect-btn" data-client-id="${escapeHtml(client.clientId)}" title="Disconnect and unpair this Chrome extension">Disconnect</button>
          </td>
        </tr>`;
      })
      .join("");
  }

  function setupEventListeners() {
    // Refresh button
    $("delegate-refresh-btn")?.addEventListener("click", fetchDelegateStatus);

    // Toggle Listener Start / Stop
    $("delegate-listener-toggle")?.addEventListener("click", async () => {
      const btn = $("delegate-listener-toggle");
      if (btn) btn.disabled = true;
      try {
        const action = delegateState.running ? "stop" : "start";
        await invokeDelegate(action);
        await fetchDelegateStatus();
      } catch (err) {
        alert(`Failed to ${delegateState.running ? "stop" : "start"} delegate bridge: ${err.message || err}`);
      } finally {
        if (btn) btn.disabled = false;
      }
    });

    // Renew Pairing Code
    $("delegate-pair-renew")?.addEventListener("click", async () => {
      const btn = $("delegate-pair-renew");
      if (btn) btn.disabled = true;
      try {
        const res = await invokeDelegate("renew-code");
        if (res?.code) {
          delegateState.pairingCode = res.code;
          delegateState.pairingExpiresAt = res.expiresAt;
          delegateState.pairingTtlMs = res.ttlRemainingMs;
          renderPairingCodeBox();
          startCountdown();
        } else {
          await fetchDelegateStatus();
        }
      } catch (err) {
        alert(`Failed to renew pairing code: ${err.message || err}`);
      } finally {
        if (btn) btn.disabled = false;
      }
    });

    // Copy Pairing Code
    $("delegate-pair-copy")?.addEventListener("click", async () => {
      if (!delegateState.pairingCode) return;
      try {
        await navigator.clipboard.writeText(delegateState.pairingCode);
        const copyBtn = $("delegate-pair-copy");
        const origText = copyBtn.textContent;
        copyBtn.textContent = "Copied!";
        setTimeout(() => {
          copyBtn.textContent = origText;
        }, 2000);
      } catch {
        alert("Failed to copy pairing code to clipboard.");
      }
    });

    // Disconnect button in client rows
    $("delegate-profiles-tbody")?.addEventListener("click", async (e) => {
      const btn = e.target.closest(".client-disconnect-btn");
      if (btn) {
        const clientId = btn.dataset.clientId;
        if (!clientId) return;
        if (!confirm(`Disconnect Chrome extension client ${clientId}?`)) return;
        btn.disabled = true;
        try {
          await invokeDelegate("disconnect", { clientId });
          await fetchDelegateStatus();
        } catch (err) {
          alert(`Failed to disconnect client: ${err.message || err}`);
          btn.disabled = false;
        }
      }
    });

    // View Delegate Logs button
    $("delegate-view-logs-btn")?.addEventListener("click", () => {
      if (typeof window.navigateToPage === "function") {
        window.navigateToPage("logs");
        const sourceFilter = $("logs-filter-source");
        if (sourceFilter) {
          sourceFilter.value = "delegate";
          sourceFilter.dispatchEvent(new Event("change"));
        }
      }
    });
  }

  function startPolling() {
    if (delegateState.pollTimer) clearInterval(delegateState.pollTimer);
    delegateState.pollTimer = setInterval(() => {
      const pageDelegate = $("page-delegate");
      if (pageDelegate && !pageDelegate.hidden) {
        fetchDelegateStatus();
      }
    }, 5000);
  }

  window.__superagentDelegateRefresh = fetchDelegateStatus;
  window.__superagentDelegateState = delegateState;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      setupEventListeners();
      startPolling();
    });
  } else {
    setupEventListeners();
    startPolling();
  }
})();

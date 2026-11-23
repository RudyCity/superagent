"use strict";

/**
 * SuperAgent Tray · Close Confirmation & Exit Options Controller
 *
 * Provides a modal dialog on close request with two explicit choices:
 * 1. Close Tray Only (Keep Core, tunnels, MCP, and daemons running in background)
 * 2. Close Complete All Daemon (Full drain & kill of all background daemons, MCP, Core, and app exit)
 */
(() => {
  const byId = (id) => document.getElementById(id);

  const dialog = byId("close-options-dialog");
  const dismissBtn = byId("close-options-dismiss");
  const cancelBtn = byId("close-options-cancel");
  const closeTrayBtn = byId("btn-close-tray");
  const closeCompleteDaemonBtn = byId("btn-close-complete-daemon");
  const cardTray = byId("close-option-tray-card");
  const cardDaemon = byId("close-option-daemon-card");
  const progressBox = byId("close-options-progress");
  const statusText = byId("close-options-status-text");

  let isBusy = false;

  const invoke = (action, payload = {}) => {
    const tauriInvoke = window.__TAURI__?.core?.invoke;
    if (!tauriInvoke) {
      console.warn("[close-modal] Tauri core invoke unavailable, using web fallback");
      return Promise.resolve({ fallback: true });
    }
    return tauriInvoke(action, payload);
  };

  const setBusy = (busy, message = "") => {
    isBusy = busy;
    if (closeTrayBtn) closeTrayBtn.disabled = busy;
    if (closeCompleteDaemonBtn) closeCompleteDaemonBtn.disabled = busy;
    if (dismissBtn) dismissBtn.disabled = busy;
    if (cancelBtn) cancelBtn.disabled = busy;
    if (cardTray) {
      cardTray.style.pointerEvents = busy ? "none" : "auto";
      cardTray.style.opacity = busy ? "0.5" : "1";
    }
    if (cardDaemon) {
      cardDaemon.style.pointerEvents = busy ? "none" : "auto";
    }
    if (progressBox) progressBox.hidden = !busy;
    if (statusText && message) statusText.textContent = message;
  };

  const open = () => {
    if (!dialog) return;
    setBusy(false);
    dialog.hidden = false;
    // Focus secondary action by default for safe keyboard interaction
    if (closeTrayBtn) closeTrayBtn.focus();
  };

  const close = () => {
    if (isBusy || !dialog) return;
    dialog.hidden = true;
  };

  const executeCloseTray = async () => {
    if (isBusy) return;
    setBusy(true, "Closing SuperAgent Tray...");
    try {
      await invoke("tray_window_action", { action: "close" });
    } catch (err) {
      console.error("[close-modal] Close tray action failed:", err);
      // Fallback: try hide or window close
      try {
        await invoke("tray_window_action", { action: "hide" });
      } catch (_) {
        window.close();
      }
    } finally {
      if (dialog) dialog.hidden = true;
      setBusy(false);
    }
  };

  const executeCloseCompleteDaemon = async () => {
    if (isBusy) return;
    setBusy(true, "Stopping all background daemons, Core supervisor, and MCP services...");

    try {
      let drainSuccess = false;
      // 1. Attempt native drain_all_services
      try {
        const drainRes = await invoke("drain_all_services", {});
        if (drainRes?.success) drainSuccess = true;
      } catch (err) {
        console.warn("[close-modal] Native drain_all_services invoke failed, trying HTTP fallback:", err);
      }

      // 2. Fallback to Core HTTP drain endpoint if native failed
      if (!drainSuccess) {
        try {
          const res = await fetch("/api/desktop/drain-all", { method: "POST" });
          if (res.ok) drainSuccess = true;
        } catch (_) {}
      }

      setBusy(true, "All services stopped. Exiting SuperAgent...");

      // Small pause to allow process release
      await new Promise((r) => setTimeout(r, 450));

      // 3. Complete termination of Tray app
      try {
        await invoke("tray_window_action", { action: "quit-app" });
      } catch (_) {
        try {
          await invoke("tray_window_action", { action: "close" });
        } catch (_) {
          window.close();
        }
      }
    } catch (err) {
      console.error("[close-modal] Complete daemon drain failed:", err);
      setBusy(false);
      alert("Failed to drain all daemons cleanly: " + String(err?.message || err));
    }
  };

  // Event Listeners
  if (dismissBtn) dismissBtn.addEventListener("click", close);
  if (cancelBtn) cancelBtn.addEventListener("click", close);

  if (closeTrayBtn) {
    closeTrayBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      void executeCloseTray();
    });
  }

  if (cardTray) {
    cardTray.addEventListener("click", () => {
      void executeCloseTray();
    });
    cardTray.addEventListener("keydown", (e) => {
      if ((e.key === "Enter" || e.key === " ") && e.target === cardTray) {
        e.preventDefault();
        void executeCloseTray();
      }
    });
  }

  if (closeCompleteDaemonBtn) {
    closeCompleteDaemonBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      void executeCloseCompleteDaemon();
    });
  }

  if (cardDaemon) {
    cardDaemon.addEventListener("click", () => {
      void executeCloseCompleteDaemon();
    });
    cardDaemon.addEventListener("keydown", (e) => {
      if ((e.key === "Enter" || e.key === " ") && e.target === cardDaemon) {
        e.preventDefault();
        void executeCloseCompleteDaemon();
      }
    });
  }

  if (dialog) {
    dialog.addEventListener("click", (e) => {
      if (e.target === dialog && !isBusy) close();
    });

    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !dialog.hidden && !isBusy) {
        close();
      }
    });
  }

  // Global exports & Tauri event listener
  window.__superagentOpenCloseModal = open;
  window.__superagentCloseCloseModal = close;

  window.__TAURI__?.event?.listen?.("desktop-request-close-modal", () => {
    open();
  });
})();

"use strict";

/**
 * Frameless SuperAgent Tray window chrome.
 *
 * All native calls are narrow, allowlisted commands on this Tauri WebView's
 * own main window. No filesystem, process or Core capability is exposed.
 * Drag starts ONLY after a physical pointer move, preserving double-click
 * maximize and preventing a click on window controls from starting a drag.
 */
(() => {
  const byId = (id) => document.getElementById(id);
  const dragArea = byId("tray-titlebar-drag");
  const minimizeButton = byId("tray-window-minimize");
  const maximizeButton = byId("tray-window-maximize");
  const closeButton = byId("tray-window-close");
  const feedback = byId("tray-window-action-feedback");
  if (!dragArea || !minimizeButton || !maximizeButton || !closeButton) return;

  const invoke = (action) => {
    const tauriInvoke = window.__TAURI__?.core?.invoke;
    if (!tauriInvoke) throw new Error("Native SuperAgent Tray window is unavailable");
    return tauriInvoke("tray_window_action", { action });
  };

  let maximized = false;
  let actionBusy = false;
  let pendingDrag = null;
  let stateBusy = false;

  const report = (message) => {
    if (feedback) feedback.textContent = message;
  };

  function drawMaximized(state) {
    maximized = state === true;
    const label = maximized ? "Restore window" : "Maximize window";
    maximizeButton.setAttribute("aria-label", label);
    maximizeButton.setAttribute("title", label);
    maximizeButton.setAttribute("aria-pressed", String(maximized));
    const iconMax = maximizeButton.querySelector(".tray-icon-maximize");
    const iconRestore = maximizeButton.querySelector(".tray-icon-restore");
    if (iconMax) iconMax.hidden = maximized;
    if (iconRestore) iconRestore.hidden = !maximized;
    document.documentElement.classList.toggle("tray-window-maximized", maximized);
  }

  async function syncWindowState() {
    if (stateBusy || actionBusy) return;
    stateBusy = true;
    try {
      const next = await invoke("state");
      if (typeof next?.maximized === "boolean") drawMaximized(next.maximized);
    } catch (error) {
      report("Window status unavailable: " + String(error));
    } finally {
      stateBusy = false;
    }
  }

  async function controlWindow(action) {
    if (actionBusy || !["minimize", "toggle-maximize", "close"].includes(action)) return;
    actionBusy = true;
    try {
      const next = await invoke(action);
      if (typeof next?.maximized === "boolean") drawMaximized(next.maximized);
      report("");
    } catch (error) {
      report("Window " + action + " failed: " + String(error));
    } finally {
      actionBusy = false;
    }
  }

  function handlePointerDown(event) {
    // Mouse primary button only. Never treat right click, touch or keyboard
    // generated events as a native OS drag.
    if (event.button !== 0 || event.pointerType !== "mouse") return;
    if (!event.target?.closest?.("#tray-titlebar-drag")) return;
    pendingDrag = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
    };
  }

  function handlePointerMove(event) {
    if (!pendingDrag || event.pointerId !== pendingDrag.id) return;
    const deltaX = event.clientX - pendingDrag.x;
    const deltaY = event.clientY - pendingDrag.y;
    if (deltaX * deltaX + deltaY * deltaY < 25) return;
    pendingDrag = null;
    if (maximized || actionBusy) return;
    try {
      void invoke("start-drag").catch((error) => {
        report("Dragging is unavailable: " + String(error));
      });
    } catch (error) {
      report("Dragging is unavailable: " + String(error));
    }
  }

  function handlePointerUp(event) {
    if (!pendingDrag || event.pointerId === pendingDrag.id) pendingDrag = null;
  }

  dragArea.addEventListener("pointerdown", handlePointerDown);
  document.addEventListener("pointermove", handlePointerMove);
  document.addEventListener("pointerup", handlePointerUp);
  document.addEventListener("pointercancel", handlePointerUp);
  window.addEventListener("blur", () => { pendingDrag = null; });

  dragArea.addEventListener("dblclick", (event) => {
    if (event.button !== 0 || !event.target?.closest?.("#tray-titlebar-drag")) return;
    pendingDrag = null;
    void controlWindow("toggle-maximize");
  });

  minimizeButton.addEventListener("click", () => {
    pendingDrag = null;
    void controlWindow("minimize");
  });
  maximizeButton.addEventListener("click", () => {
    pendingDrag = null;
    void controlWindow("toggle-maximize");
  });
  closeButton.addEventListener("click", () => {
    pendingDrag = null;
    // This triggers Rust WindowEvent::CloseRequested: hide-to-tray when on,
    // otherwise exit ONLY Tray, never stop Core/tunnels/Muse.
    void controlWindow("close");
  });

  window.addEventListener("focus", () => { void syncWindowState(); });
  window.addEventListener("resize", () => { void syncWindowState(); });
  void syncWindowState();
})();

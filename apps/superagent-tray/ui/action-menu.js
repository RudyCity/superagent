"use strict";

/**
 * Reusable, dependency-free row action menu for the Tauri WebView.
 *
 * Rendering is pure and escapes all dynamic text. The controller portals the
 * viewport-fixed popup to document.body so scrollable tables and panel overflow
 * cannot clip it. Action buttons retain their caller-supplied class names
 * and data attributes so the owning feature can delegate their behavior.
 */
(function () {
  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[char]);
  }

  function render(options) {
    const taskId = String(options.id || "");
    const name = String(options.label || "Process");
    const menuId = "sa-process-menu-" + taskId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const triggerId = menuId + "-trigger";
    const entries = (options.items || []).map((item) => {
      if (item.separator) {
        return '<div class="sa-action-menu-separator" role="separator"></div>';
      }
      const attrs = Object.entries(item.data || {})
        .map(([key, value]) => {
          if (!/^[a-z][a-z0-9-]*$/.test(key)) return "";
          return ' data-' + key + '="' + escapeHtml(value) + '"';
        }).join("");
      const classes = String(item.className || "")
        .split(/\s+/).filter((cls) => /^[a-z][a-z0-9_-]*$/i.test(cls)).join(" ");
      return '<button type="button" role="menuitem" class="sa-action-menu-item ' +
        classes + (item.danger ? ' is-danger' : '') + '"' + attrs +
        (item.disabled ? ' disabled aria-disabled="true"' : '') +
        (item.title ? ' title="' + escapeHtml(item.title) + '"' : "") +
        '>' + escapeHtml(item.label) + '</button>';
    }).join("");
    return '<div class="sa-action-menu" data-menu-owner="' + escapeHtml(taskId) + '">' +
      '<button type="button" class="sa-action-menu-trigger" id="' + triggerId +
      '" aria-haspopup="menu" aria-controls="' + menuId +
      '" aria-expanded="false" aria-label="Actions for ' + escapeHtml(name) + '"' +
      ' title="Process actions">' +
      '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="currentColor">' +
      '<circle cx="5" cy="12" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="19" cy="12" r="1.9"/></svg>' +
      '</button>' +
      '<div class="sa-action-menu-popover" id="' + menuId +
      '" role="menu" aria-labelledby="' + triggerId + '" hidden>' +
      entries +
      (options.note ? '<p class="sa-action-menu-note">' + escapeHtml(options.note) + '</p>' : '') +
      '</div></div>';
  }

  function createController(doc, win) {
    let opened = null;

    function close(restoreFocus = false) {
      if (!opened) return;
      const { trigger, menu, owner, portaled } = opened;
      menu.hidden = true;
      menu.style.left = "";
      menu.style.top = "";
      if (portaled) owner.appendChild(menu);
      trigger.setAttribute("aria-expanded", "false");
      opened = null;
      if (restoreFocus) trigger.focus();
    }

    function open(trigger) {
      if (opened && opened.trigger === trigger) {
        close(true);
        return;
      }
      const owner = trigger.closest(".sa-action-menu");
      const menu = owner && owner.querySelector(".sa-action-menu-popover");
      if (!menu) return;
      close();
      const portaled = Boolean(doc.body?.appendChild && owner.appendChild);
      if (portaled) doc.body.appendChild(menu);
      trigger.setAttribute("aria-expanded", "true");
      menu.hidden = false;
      const rect = trigger.getBoundingClientRect();
      const width = menu.offsetWidth || 222;
      const height = menu.offsetHeight || 200;
      const viewportWidth = win.innerWidth || doc.documentElement?.clientWidth || 1024;
      const viewportHeight = win.innerHeight || doc.documentElement?.clientHeight || 768;
      const pad = 8;
      const left = Math.max(pad, Math.min(rect.right - width, viewportWidth - width - pad));
      const top = rect.bottom + height + pad <= viewportHeight
        ? rect.bottom + 5
        : Math.max(pad, rect.top - height - 5);
      menu.style.left = left + "px";
      menu.style.top = top + "px";
      opened = { trigger, menu, owner, portaled };
      const first = menu.querySelector('.sa-action-menu-item:not(:disabled)');
      first?.focus();
    }

    function handleClick(event) {
      const trigger = event.target?.closest?.(".sa-action-menu-trigger");
      if (trigger) {
        event.preventDefault?.();
        open(trigger);
        return true;
      }
      if (event.target?.closest?.(".sa-action-menu-item")) {
        close(true);
        return false; // Let the caller's existing delegated action handler run.
      }
      return false;
    }

    function onDocumentClick(event) {
      if (opened && !event.target?.closest?.(".sa-action-menu") &&
          !event.target?.closest?.(".sa-action-menu-popover")) close();
    }

    function onKeydown(event) {
      const trigger = event.target?.closest?.(".sa-action-menu-trigger");
      if (trigger && ["ArrowDown", "ArrowUp"].includes(event.key)) {
        event.preventDefault?.();
        if (!opened || opened.trigger !== trigger) open(trigger);
        return;
      }
      if (!opened) return;
      if (event.key === "Escape") {
        event.preventDefault?.();
        close(true);
      } else if (event.key === "Tab") {
        close();
      } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        const items = Array.from(opened.menu.querySelectorAll(".sa-action-menu-item:not(:disabled)"));
        if (!items.length) return;
        const focused = items.indexOf(doc.activeElement);
        const index = event.key === "Home" ? 0
          : event.key === "End" ? items.length - 1
            : event.key === "ArrowDown" ? (focused + 1) % items.length
              : (focused < 0 ? 0 : focused + items.length - 1) % items.length;
        event.preventDefault?.();
        items[index].focus();
      }
    }

    doc.addEventListener("click", onDocumentClick);
    doc.addEventListener("keydown", onKeydown);
    // Scrolling the table or page invalidates its viewport-relative anchor.
    win.addEventListener("scroll", (event) => {
      if (event.target?.closest?.(".sa-action-menu-popover")) return;
      close();
    }, true);
    win.addEventListener("resize", () => close());

    return { handleClick, close, onKeydown, isOpen: () => Boolean(opened) };
  }

  window.SuperAgentActionMenu = Object.freeze({ render, createController });
})();

"use strict";

(() => {
  function makeError(code, message) {
    const e = new Error(message);
    e.code = code;
    return e;
  }

  function chromeCall(fn, ...args) {
    return new Promise((resolve, reject) => {
      try {
        fn(...args, (value) => {
          const err = chrome.runtime.lastError;
          if (err) reject(new Error(err.message || String(err)));
          else resolve(value);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  function normalizeChromeError(error, fallback) {
    const message = String(error?.message || error || fallback);
    if (/another debugger|already attached|debugger is already/i.test(message)) {
      return makeError("DELEGATE_CDP_DEBUGGER_CONFLICT",
        "Another debugger/DevTools owner is already attached. SuperAgent will not take it over.");
    }
    return makeError("DELEGATE_CDP_CHROME_ERROR", message);
  }

  globalThis.createDelegateCdpBridge = function createDelegateCdpBridge(options = {}) {
    const attachments = new Map();
    const events = new Map();
    const MAX_EVENTS_PER_TAB = 64;
    const CDP_TAB_PREFIX = "🔴 CDP · ";
    const tabScriptIds = new Map();
    const indicatorRefreshing = new Set();
    const INDICATOR_REFRESH_MS = 60_000;
    const now = typeof options.now === "function" ? options.now : () => Date.now();

    // Native Chrome tabs do not expose an arbitrary per-tab decoration API.
    // An unobtrusive title prefix identifies the exact tab being debugged,
    // while chrome.action adds a per-tab extension badge in the toolbar,
    // and an in-page floating status pill shows the agent status and cancel control.
    function indicatorSource(active, ttlMs = 120000) {
      const prefix = JSON.stringify(CDP_TAB_PREFIX);
      const expiry = Date.now() + Math.max(1000, Math.min(120000, ttlMs));
      const pillHostId = JSON.stringify("__superagent_delegate_floating_pill_host__");
      return [
        "(() => {",
        "if (window !== window.top) return false;",
        "const key = '__superagent_delegate_cdp_title_v1__';",
        "const prefix = " + prefix + ";",
        "const pillHostId = " + pillHostId + ";",
        "const prior = window[key];",
        "const removePill = () => {",
        " try {",
        "  const el = typeof document !== 'undefined' && typeof document.getElementById === 'function' ? document.getElementById(pillHostId) : null;",
        "  if (el && el.parentNode) el.parentNode.removeChild(el);",
        " } catch {}",
        "};",
        "const mountPill = () => {",
        " try {",
        "  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return;",
        "  if (document.getElementById(pillHostId)) return;",
        "  const parent = document.body || document.documentElement;",
        "  if (!parent) return;",
        "  const host = document.createElement('div');",
        "  host.id = pillHostId;",
        "  host.style.cssText = 'all:initial;position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:2147483646;pointer-events:none;font-family:-apple-system,BlinkMacSystemFont,\"Segoe UI\",Roboto,sans-serif;';",
        "  let root = host;",
        "  if (typeof host.attachShadow === 'function') {",
        "   try { root = host.attachShadow({ mode: 'open' }); } catch {}",
        "  }",
        "  root.innerHTML = '<style>' +",
        "   '.sa-pill{pointer-events:auto;display:inline-flex;align-items:center;gap:9px;height:36px;padding:3px 10px 3px 6px;background:rgba(15,23,42,0.88);backdrop-filter:blur(14px) saturate(180%);-webkit-backdrop-filter:blur(14px) saturate(180%);border:1px solid rgba(255,255,255,0.15);border-radius:9999px;box-shadow:0 8px 24px -4px rgba(0,0,0,0.4),0 2px 6px rgba(0,0,0,0.25),inset 0 1px 0 rgba(255,255,255,0.2);color:#f8fafc;font-size:13px;font-weight:500;letter-spacing:-0.01em;user-select:none;animation:saSlideDown 0.24s cubic-bezier(0.16,1,0.3,1) forwards;box-sizing:border-box;}' +",
        "   '@keyframes saSlideDown{from{opacity:0;transform:translateY(-10px) scale(0.96);}to{opacity:1;transform:translateY(0) scale(1);}}' +",
        "   '.sa-avatar{width:26px;height:26px;border-radius:50%;background:linear-gradient(135deg,#06b6d4 0%,#3b82f6 50%,#6366f1 100%);display:flex;align-items:center;justify-content:center;flex-shrink:0;box-shadow:0 0 10px rgba(6,182,212,0.45);border:1px solid rgba(255,255,255,0.6);}' +",
        "   '.sa-avatar svg{width:15px;height:15px;fill:#ffffff;}' +",
        "   '.sa-pulse-dot{width:7px;height:7px;border-radius:50%;background:#10b981;box-shadow:0 0 8px #10b981;animation:saPulse 1.6s ease-in-out infinite;flex-shrink:0;}' +",
        "   '@keyframes saPulse{0%,100%{opacity:1;transform:scale(1);}50%{opacity:0.4;transform:scale(0.85);}}' +",
        "   '.sa-status-text{display:inline-flex;align-items:center;gap:6px;color:#f1f5f9;white-space:nowrap;line-height:1;}' +",
        "   '.sa-close-btn{display:flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;background:rgba(255,255,255,0.08);border:none;color:#94a3b8;cursor:pointer;padding:0;margin-left:2px;transition:all 0.15s ease;flex-shrink:0;}' +",
        "   '.sa-close-btn:hover{background:rgba(239,68,68,0.25);color:#fca5a5;}' +",
        "   '.sa-close-btn svg{width:11px;height:11px;stroke:currentColor;stroke-width:2.2;stroke-linecap:round;}' +",
        "   '</style>' +",
        "   '<div class=\"sa-pill\">' +",
        "   '<div class=\"sa-avatar\"><svg viewBox=\"0 0 24 24\"><path d=\"M12 2L14.4 9.6L22 12L14.4 14.4L12 22L9.6 14.4L2 12L9.6 9.6L12 2Z\"/></svg></div>' +",
        "   '<span class=\"sa-pulse-dot\"></span>' +",
        "   '<span class=\"sa-status-text\">SuperAgent Working...</span>' +",
        "   '<button class=\"sa-close-btn\" aria-label=\"Dismiss status\" title=\"Dismiss status\"><svg viewBox=\"0 0 12 12\"><line x1=\"2\" y1=\"2\" x2=\"10\" y2=\"10\"/><line x1=\"10\" y1=\"2\" x2=\"2\" y2=\"10\"/></svg></button>' +",
        "   '</div>';",
        "  const btn = root.querySelector('.sa-close-btn');",
        "  if (btn) {",
        "   btn.addEventListener('click', function(e) {",
        "    e.stopPropagation();",
        "    const pill = root.querySelector('.sa-pill');",
        "    if (pill) {",
        "     pill.style.transition = 'opacity 0.15s ease, transform 0.15s ease';",
        "     pill.style.opacity = '0';",
        "     pill.style.transform = 'translateY(-10px) scale(0.96)';",
        "    }",
        "    setTimeout(removePill, 160);",
        "    try {",
        "     window.__superagent_user_dismissed__ = true;",
        "     window.dispatchEvent(new CustomEvent('__superagent_cancel__', { detail: { action: 'dismiss_pill' } }));",
        "    } catch {}",
        "   });",
        "  }",
        "  parent.appendChild(host);",
        " } catch {}",
        "};",
        "if (prior && typeof prior.stop === 'function') prior.stop();",
        "if (!" + JSON.stringify(active) + ") {",
        " if (document.title.startsWith(prefix)) document.title = document.title.slice(prefix.length);",
        " removePill();",
        " return true;",
        "}",
        "const expiresAt = " + expiry + ";",
        "let closed = false, queued = false, timer = null;",
        "const observer = new MutationObserver(() => {",
        " if (queued || closed) return;",
        " queued = true;",
        " queueMicrotask(() => { queued = false; update(); });",
        "});",
        "const stop = () => {",
        " if (closed) return;",
        " closed = true; observer.disconnect(); clearTimeout(timer);",
        " if (document.title.startsWith(prefix)) document.title = document.title.slice(prefix.length);",
        " removePill();",
        " if (window[key] === state) delete window[key];",
        "};",
        "const state = { stop };",
        "const update = () => {",
        " if (closed) return;",
        " if (Date.now() >= expiresAt) return stop();",
        " if (!document.title.startsWith(prefix)) document.title = prefix + document.title;",
        " mountPill();",
        "};",
        "window[key] = state;",
        "if (document.head || document.body) {",
        " if (document.head) observer.observe(document.head, { subtree: true, childList: true, characterData: true });",
        " update();",
        "} else document.addEventListener('DOMContentLoaded', () => {",
        " if (!closed && document.head) {",
        "  observer.observe(document.head, { subtree: true, childList: true, characterData: true });",
        " }",
        " update();",
        "}, { once: true });",
        "timer = setTimeout(stop, Math.max(1, expiresAt - Date.now()));",
        "return true;",
        "})()",
      ].join("\n");
    }

    async function setTabBadge(tabId, marked) {
      try {
        if (typeof chrome.action?.setBadgeText === "function") {
          await chrome.action.setBadgeText({ tabId, text: marked ? "CDP" : "" });
          if (marked) {
            await chrome.action.setBadgeBackgroundColor?.({ tabId, color: "#c2410c" });
            await chrome.action.setTitle?.({ tabId, title: "🔴 SuperAgent CDP sedang memakai tab ini" });
          } else {
            await chrome.action.setTitle?.({ tabId, title: "SuperAgent Delegate — koneksi Chrome" });
          }
        }
      } catch { /* Cosmetic only; never change debugger ownership. */ }
    }

    async function displayTabIndicator(tabId) {
      try {
        // A repeated navigation must not accumulate stale document-init scripts.
        const prior = tabScriptIds.get(tabId);
        if (prior) {
          await chromeCall(chrome.debugger.sendCommand.bind(chrome.debugger),
            { tabId }, "Page.removeScriptToEvaluateOnNewDocument", { identifier: prior });
          tabScriptIds.delete(tabId);
        }
        const entry = await chromeCall(chrome.debugger.sendCommand.bind(chrome.debugger),
          { tabId }, "Page.addScriptToEvaluateOnNewDocument", { source: indicatorSource(true) });
        if (typeof entry?.identifier === "string" && entry.identifier) tabScriptIds.set(tabId, entry.identifier);
        await chromeCall(chrome.debugger.sendCommand.bind(chrome.debugger),
          { tabId }, "Runtime.evaluate", { expression: indicatorSource(true) });
      } catch { /* Cosmetic failure: keep the authorized debugger session. */ }
      await setTabBadge(tabId, true);
      const owned = attachments.get(tabId);
      if (owned) owned.lastIndicatorAt = now();
    }

    async function refreshIndicators() {
      if (!isEnabled()) return;
      for (const [tabId, owned] of attachments) {
        if (indicatorRefreshing.has(tabId)
            || now() - (owned.lastIndicatorAt || 0) < INDICATOR_REFRESH_MS) continue;
        indicatorRefreshing.add(tabId);
        try {
          // A live, already-owned debugger session can refresh its own cosmetic
          // label. No new tabs/debugger ownership or page interactions.
          await displayTabIndicator(tabId);
        } finally {
          indicatorRefreshing.delete(tabId);
        }
      }
    }

    async function clearTabIndicator(tabId) {
      const identifier = tabScriptIds.get(tabId);
      tabScriptIds.delete(tabId);
      if (identifier) {
        try {
          await chromeCall(chrome.debugger.sendCommand.bind(chrome.debugger),
            { tabId }, "Page.removeScriptToEvaluateOnNewDocument", { identifier });
        } catch { /* Expiry in page handles disconnected debugger cleanup. */ }
      }
      try {
        await chromeCall(chrome.debugger.sendCommand.bind(chrome.debugger),
          { tabId }, "Runtime.evaluate", { expression: indicatorSource(false) });
      } catch { /* Tab may have closed or navigated to a restricted page. */ }
      await setTabBadge(tabId, false);
    }

    const isEnabled = typeof options.enabled === "function" ? options.enabled : () => false;
    const clientId = typeof options.clientId === "function" ? options.clientId : () => "";
    const policy = globalThis.DelegateCdpPolicy;
    if (!policy) throw new Error("DelegateCdpPolicy must load before cdpBridge.js");

    function requireEnabled() {
      if (!isEnabled()) throw makeError("DELEGATE_CDP_DISABLED", "Delegate-CDP is disabled in this Chrome profile.");
    }

    async function getTab(tabId) {
      if (!Number.isSafeInteger(tabId) || tabId < 1) {
        throw makeError("DELEGATE_CDP_INVALID_TAB", "A positive Chrome tabId is required.");
      }
      let tab;
      try { tab = await chromeCall(chrome.tabs.get.bind(chrome.tabs), tabId); }
      catch (error) { throw makeError("DELEGATE_CDP_TAB_NOT_FOUND", String(error?.message || error)); }
      policy.assertUrl(tab?.url || "");
      return tab;
    }

    async function listTargets() {
      requireEnabled();
      const [debugTargets, tabs] = await Promise.all([
        chromeCall(chrome.debugger.getTargets.bind(chrome.debugger)),
        chromeCall(chrome.tabs.query.bind(chrome.tabs), {}),
      ]);
      const targetByTab = new Map((debugTargets || [])
        .filter((target) => Number.isSafeInteger(target.tabId))
        .map((target) => [target.tabId, target]));
      return (tabs || [])
        .filter((tab) => Number.isSafeInteger(tab.id) && !policy.privileged(tab.url || ""))
        .map((tab) => {
          const target = targetByTab.get(tab.id);
          return {
            transport: "delegate",
            clientId: clientId(),
            tabId: tab.id,
            targetId: "delegate:" + clientId() + ":" + tab.id,
            title: String(tab.title || target?.title || ""),
            url: String(tab.url || target?.url || ""),
            active: !!tab.active,
            attached: attachments.has(tab.id),
            debuggerAttached: !!target?.attached,
          };
        });
    }

    async function attach(tabId) {
      requireEnabled();
      const tab = await getTab(tabId);
      if (attachments.has(tabId)) return { attached: true, alreadyOwned: true, tabId };
      try {
        await chromeCall(chrome.debugger.attach.bind(chrome.debugger), { tabId }, "1.3");
      } catch (error) {
        throw normalizeChromeError(error, "Could not attach chrome.debugger.");
      }
      attachments.set(tabId, { tabId, attachedAt: Date.now(), lastUsedAt: Date.now(), url: tab.url || "" });
      await displayTabIndicator(tabId);
      return { attached: true, tabId };
    }

    async function detach(tabId) {
      const owned = attachments.get(tabId);
      if (!owned) return { detached: false, owned: false, tabId };
      try {
        await clearTabIndicator(tabId);
        await chromeCall(chrome.debugger.detach.bind(chrome.debugger), { tabId });
      } catch (error) {
        const message = String(error?.message || error);
        if (!/not attached|target closed|no tab/i.test(message)) throw normalizeChromeError(error, "Could not detach chrome.debugger.");
      } finally {
        attachments.delete(tabId);
      }
      return { detached: true, owned: true, tabId };
    }

    async function command(params = {}) {
      requireEnabled();
      const tabId = Number(params.tabId);
      if (!attachments.has(tabId)) {
        throw makeError("DELEGATE_CDP_NOT_ATTACHED", "Attach this Delegate tab before dispatching a CDP command.");
      }
      const tab = await getTab(tabId);
      const method = String(params.method || "");
      const meta = params.meta && typeof params.meta === "object" ? params.meta : {};
      policy.classify(method, meta);
      if (method === "Page.navigate") policy.assertUrl(String(params.params?.url || ""));
      try {
        const result = await chromeCall(
          chrome.debugger.sendCommand.bind(chrome.debugger),
          { tabId }, method, params.params && typeof params.params === "object" ? params.params : {}
        );
        const owned = attachments.get(tabId);
        if (owned) {
          owned.lastUsedAt = Date.now();
          // Reapply after site navigation or aggressive title rewrites.
          // One-time read errors must not change the result of the original command.
          if (method === "Page.navigate") await displayTabIndicator(tabId);
        }
        return result ?? {};
      } catch (error) {
        throw normalizeChromeError(error, "CDP command failed.");
      }
    }

    async function tabAction(params = {}) {
      requireEnabled();
      const action = String(params.action || "");
      if (action === "new_tab") {
        const url = String(params.url || "https://example.com/");
        policy.assertUrl(url);
        const tab = await chromeCall(chrome.tabs.create.bind(chrome.tabs), { url, active: params.active !== false });
        return { tabId: tab.id, title: tab.title || "", url: tab.url || url, targetId: "delegate:" + clientId() + ":" + tab.id };
      }
      const tabId = Number(params.tabId);
      await getTab(tabId);
      if (action === "activate") {
        const tab = await chromeCall(chrome.tabs.update.bind(chrome.tabs), tabId, { active: true });
        if (Number.isSafeInteger(tab.windowId)) {
          try { await chromeCall(chrome.windows.update.bind(chrome.windows), tab.windowId, { focused: true }); } catch {}
        }
        return { activated: true, tabId };
      }
      if (action === "close_tab") {
        if (attachments.has(tabId)) await detach(tabId);
        await chromeCall(chrome.tabs.remove.bind(chrome.tabs), tabId);
        return { closed: true, tabId };
      }
      throw makeError("DELEGATE_CDP_TAB_ACTION_UNSUPPORTED", "Unsupported Delegate tab action.");
    }

    async function health() {
      return {
        enabled: !!isEnabled(),
        capability: "delegate-cdp-v1",
        protocolVersion: "1.3",
        attachments: attachments.size,
        clientId: clientId(),
      };
    }

    function listAttachments() {
      return [...attachments.values()].map((entry) => ({
        tabId: entry.tabId, attachedAt: entry.attachedAt, lastUsedAt: entry.lastUsedAt,
      }));
    }

    function listEvents(tabId, clear = false) {
      if (!Number.isSafeInteger(tabId) || tabId < 1) {
        throw makeError("DELEGATE_CDP_INVALID_TAB", "A positive Chrome tabId is required.");
      }
      const rows = [...(events.get(tabId) || [])];
      if (clear) events.delete(tabId);
      return rows;
    }

    function recordEvent(tabId, method, params) {
      if (!attachments.has(tabId)) return;
      const rows = events.get(tabId) || [];
      const safe = method === "Page.javascriptDialogOpening"
        ? {
            type: String(params?.type || "").slice(0, 40),
            hasBrowserHandler: params?.hasBrowserHandler === true,
            defaultPromptLength: String(params?.defaultPrompt || "").length,
            messageLength: String(params?.message || "").length,
          }
        : method === "Page.fileChooserOpened"
          ? { backendNodeId: Number(params?.backendNodeId) || 0, mode: String(params?.mode || "").slice(0, 30) }
          : {};
      rows.push({ method, at: Date.now(), ...safe });
      if (rows.length > MAX_EVENTS_PER_TAB) rows.splice(0, rows.length - MAX_EVENTS_PER_TAB);
      events.set(tabId, rows);
    }

    async function cleanup() {
      const owned = [...attachments.keys()];
      for (const tabId of owned) {
        try { await detach(tabId); } catch { attachments.delete(tabId); }
      }
    }

    if (chrome.debugger?.onEvent?.addListener) {
      chrome.debugger.onEvent.addListener((source, method, params) => {
        if (Number.isSafeInteger(source?.tabId)) recordEvent(source.tabId, String(method || ""), params || {});
      });
    }

    if (chrome.debugger?.onDetach?.addListener) {
      chrome.debugger.onDetach.addListener((source) => {
        if (Number.isSafeInteger(source?.tabId)) {
          attachments.delete(source.tabId);
          tabScriptIds.delete(source.tabId);
          void setTabBadge(source.tabId, false);
        }
      });
    }

    return Object.freeze({
      async dispatch(method, params = {}) {
        if (method === "delegate.cdp.list_targets") return listTargets();
        if (method === "delegate.cdp.attach") return attach(Number(params.tabId));
        if (method === "delegate.cdp.detach") return detach(Number(params.tabId));
        if (method === "delegate.cdp.command") return command(params);
        if (method === "delegate.cdp.health") return health();
        if (method === "delegate.cdp.attachments") return listAttachments();
        if (method === "delegate.cdp.events") return listEvents(Number(params.tabId), params.clear === true);
        if (method === "delegate.cdp.tab_action") return tabAction(params);
        throw makeError("DELEGATE_CDP_UNKNOWN_METHOD", "Unknown Delegate-CDP bridge method.");
      },
      cleanup,
      health,
      listTargets,
      listAttachments,
      listEvents,
      refreshIndicators,
    });
  };
})();

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
      return { attached: true, tabId };
    }

    async function detach(tabId) {
      const owned = attachments.get(tabId);
      if (!owned) return { detached: false, owned: false, tabId };
      try {
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
        if (owned) owned.lastUsedAt = Date.now();
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
        if (Number.isSafeInteger(source?.tabId)) attachments.delete(source.tabId);
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
    });
  };
})();

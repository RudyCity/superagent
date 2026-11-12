if (typeof importScripts === "function") importScripts("cdpPolicy.js", "cdpBridge.js");
importScripts("tabSingleton.js");
/* Dedicated ChatGPT Delegate service worker: fixed localhost RPC only. */
const ENDPOINT = "ws://127.0.0.1:17341";
const PROTOCOL = "superagent-delegate-v1";
const METHODS = new Set([
  "delegate.create_chat",
  "delegate.read_chat",
  "delegate.peek_chat",
  "delegate.list_tabs",
  "delegate.list_chats",
  "delegate.read_chat_full",
  "delegate.search_history",
  "delegate.doctor",
  "delegate.set_timeout_recovery",
  "delegate.send_message",
  "delegate.stop_generation",
  "delegate.cdp.list_targets",
  "delegate.cdp.attach",
  "delegate.cdp.detach",
  "delegate.cdp.command",
  "delegate.cdp.health",
  "delegate.cdp.attachments",
  "delegate.cdp.events",
  "delegate.cdp.tab_action",
]);
const HISTORY_METHODS = new Set([
  "delegate.list_chats",
  "delegate.read_chat_full",
  "delegate.search_history",
]);

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const RECONNECT_ALARM = "delegate-local-bridge-reconnect";

let socket = null;
let reconnectTimer = null;
let handshakeTimer = null;
let isReady = false;
let failures = 0;
let connectionStatus = "connecting";
let lastConnectedAt = null;
let lastDisconnectedAt = null;
let nextRetryAt = null;
let lastError = null;
let enabled = true;
let initialized = false;
let clientId = null;
let profileLabel = "Chrome Delegate";
let authToken = "";
let pairingCode = "";
let authBlocked = false;
let connectedClients = [];
let delegateCdpEnabled = false;
let cdpDisconnectCleanupTimer = null;

const inFlight = new Set();
const completed = new Map();
const cdpBridge = typeof globalThis.createDelegateCdpBridge === "function"
  ? globalThis.createDelegateCdpBridge({
      chrome,
      enabled: () => enabled && delegateCdpEnabled,
      clientId: () => clientId || "",
    })
  : {
      cleanup: async () => {},
      dispatch: async () => { throw error("DELEGATE_CDP_EXTENSION_UNAVAILABLE", "Delegate-CDP bridge is unavailable."); },
    };

function error(code, message) {
  return { code, message };
}

function getConnectionStatus() {
  const cdpAttachments = delegateCdpEnabled && typeof cdpBridge.listAttachments === "function"
    ? cdpBridge.listAttachments()
    : [];
  return {
    state: connectionStatus,
    enabled,
    authConfigured: authToken.length >= 32,
    pairingInProgress: !!pairingCode,
    clientId,
    profileLabel,
    connectedClients,
    connected: isReady && socket?.readyState === WebSocket.OPEN,
    endpoint: ENDPOINT,
    lastConnectedAt,
    lastDisconnectedAt,
    nextRetryAt,
    lastError,
    retryCount: failures,
    inFlight: inFlight.size,
    tabPolicy: singleton.status(),
    cdp: {
      enabled: delegateCdpEnabled,
      capability: "delegate-cdp-v1",
      attached: cdpAttachments.length > 0,
      attachmentCount: cdpAttachments.length,
      attachments: cdpAttachments.map((entry) => ({
        tabId: entry.tabId,
        attachedAt: entry.attachedAt,
        lastUsedAt: entry.lastUsedAt,
      })),
    },
  };
}

function renderBadge() {
  const badges = {
    connected: { text: "ON", color: "#16834a", title: "Delegate — terhubung ke SuperAgent" },
    connecting: { text: "...", color: "#2563eb", title: "Delegate — menghubungkan..." },
    reconnecting: { text: "OFF", color: "#b45309", title: "Delegate — offline, mencoba menyambung ulang" },
    disconnected: { text: "OFF", color: "#b91c1c", title: "Delegate — tidak terhubung" },
    disabled: { text: "OFF", color: "#64748b", title: "Delegate — nonaktif secara manual" },
  };
  const badge = badges[connectionStatus] || badges.disconnected;
  // Updating the badge is cosmetic; never interfere with the RPC bridge.
  void chrome.action.setBadgeText({ text: badge.text }).catch(() => {});
  void chrome.action.setBadgeBackgroundColor({ color: badge.color }).catch(() => {});
  void chrome.action.setTitle({ title: badge.title }).catch(() => {});
}

function setStatus(next) {
  connectionStatus = next;
  renderBadge();
}

function send(payload) {
  if (socket?.readyState === WebSocket.OPEN && isReady) {
    socket.send(JSON.stringify(payload));
  }
}

function cancelRetry() {
  if (reconnectTimer !== null) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  nextRetryAt = null;
}

function scheduleReconnect() {
  if (!enabled || !initialized || authBlocked || reconnectTimer !== null) return;
  const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** Math.min(failures++, 5));
  nextRetryAt = Date.now() + delay;
  setStatus("reconnecting");
  // Reconnect the transport only: never replay a delegate.send_message.
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    nextRetryAt = null;
    connect();
  }, delay);
}

function connect() {
  if (!enabled || !initialized || authBlocked) return;
  if (socket && (
    socket.readyState === WebSocket.CONNECTING ||
    socket.readyState === WebSocket.OPEN
  )) return;

  cancelRetry();
  setStatus(failures > 0 ? "reconnecting" : "connecting");
  let ws;
  try {
    ws = new WebSocket(ENDPOINT);
  } catch {
    lastError = "Tidak dapat membuka WebSocket localhost.";
    scheduleReconnect();
    return;
  }

  socket = ws;
  isReady = false;

  ws.addEventListener("open", () => {
    if (socket !== ws) return;
    handshakeTimer = setTimeout(() => {
      if (socket === ws && !isReady) {
        lastError = "Handshake SuperAgent tidak dikonfirmasi.";
        ws.close();
      }
    }, 5_000);
    ws.send(JSON.stringify({
      type: "hello",
      protocol: PROTOCOL,
      clientId,
      label: profileLabel,
      extensionVersion: chrome.runtime.getManifest().version,
      browserUserAgent: typeof navigator === "object" ? navigator.userAgent : "unknown",
      capabilities: ["delegate-semantic-v1", "delegate-cdp-v1"],
      ...(pairingCode ? { pairingCode } : (authToken ? { authToken } : {})),
    }));
  });

  ws.addEventListener("message", (event) => {
    if (socket !== ws) return;
    let envelope;
    try { envelope = JSON.parse(event.data); } catch { return; }
    if (envelope?.type === "hello_ack" && envelope.protocol === PROTOCOL) {
      clearTimeout(handshakeTimer);
      handshakeTimer = null;
      const accepted = () => {
        if (socket !== ws) return;
        if (cdpDisconnectCleanupTimer !== null) clearTimeout(cdpDisconnectCleanupTimer);
        cdpDisconnectCleanupTimer = null;
        failures = 0;
        authBlocked = false;
        isReady = true;
        lastError = null;
        lastConnectedAt = Date.now();
        connectedClients = Array.isArray(envelope.clients) ? envelope.clients : [];
        setStatus("connected");
      };
      if (pairingCode) {
        if (typeof envelope.authToken !== "string" ||
            envelope.authToken.length < 32 || envelope.authToken.length > 512) {
          lastError = "Server tidak mengeluarkan kredensial pairing yang valid.";
          ws.close(1008, "DELEGATE_PAIR_RESPONSE_INVALID");
          return;
        }
        const receivedToken = envelope.authToken;
        void chrome.storage.local.set({ delegateAuthToken: receivedToken })
          .then(() => {
            if (socket !== ws) return;
            authToken = receivedToken;
            pairingCode = "";
            accepted();
          })
          .catch(() => {
            lastError = "Gagal menyimpan kredensial pairing pada profil Chrome.";
            ws.close(1008, "DELEGATE_PAIR_STORAGE_FAILED");
          });
        return;
      }
      accepted();
      return;
    }
    if (envelope?.type === "clients_update" && envelope.protocol === PROTOCOL) {
      connectedClients = Array.isArray(envelope.clients) ? envelope.clients : [];
      return;
    }
    if (!isReady || envelope?.type !== "request") return;
    void handleRequest(envelope);
  });

  ws.addEventListener("close", (event) => {
    if (socket !== ws) return;
    clearTimeout(handshakeTimer);
    handshakeTimer = null;
    if (isReady) lastDisconnectedAt = Date.now();
    isReady = false;
    socket = null;
    if (event.code === 1008 && event.reason) {
      const reasons = {
        DELEGATE_AUTH_FAILED: "Belum dipasangkan. Masukkan kode dari terminal SuperAgent.",
        DELEGATE_PAIR_CODE_INVALID: "Kode pairing salah atau kedaluwarsa. Lihat kode terbaru di terminal server.",
        DELEGATE_PAIR_RATE_LIMIT: "Terlalu banyak percobaan pairing. Coba setelah 1 menit.",
        DELEGATE_DUPLICATE_CLIENT_ID: "Client ID sedang dipakai Chrome lain. Periksa identitas profil.",
        DELEGATE_CLIENT_LIMIT: "Batas Chrome Delegate aktif tercapai (8 profil).",
        DELEGATE_SOCKET_LIMIT: "Koneksi sedang terlalu banyak, coba ulang.",
      };
      lastError = reasons[event.reason] || "Server menolak koneksi: " + String(event.reason).slice(0, 90);
    } else if (!lastError) {
      lastError = event.code === 1008
        ? "Server menolak koneksi extension (izin atau client lain aktif)."
        : "Koneksi terputus. Pastikan server SuperAgent berjalan.";
    }
    connectedClients = [];
    if (cdpDisconnectCleanupTimer !== null) clearTimeout(cdpDisconnectCleanupTimer);
    cdpDisconnectCleanupTimer = setTimeout(() => {
      cdpDisconnectCleanupTimer = null;
      if (!isReady) void cdpBridge.cleanup();
    }, 3_000);
    if (event.code === 1008 && [
      "DELEGATE_AUTH_FAILED", "DELEGATE_PAIR_CODE_INVALID", "DELEGATE_PAIR_RATE_LIMIT",
      "DELEGATE_PAIR_RESPONSE_INVALID", "DELEGATE_PAIR_STORAGE_FAILED",
    ].includes(event.reason)) {
      pairingCode = "";
      authBlocked = true; // wait for a fresh manual code; don't brute-force on timers
    }
    if (enabled) {
      setStatus("disconnected");
      scheduleReconnect();
    } else {
      setStatus("disabled");
    }
  });

  ws.addEventListener("error", () => {
    if (socket === ws) lastError = "Gagal menghubungi SuperAgent di localhost:17341.";
  });
}

function manualReconnect() {
  if (!enabled) return { started: false, reason: "disabled", status: getConnectionStatus() };
  if (authBlocked) return { started: false, reason: "pairing_required", status: getConnectionStatus() };
  if (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) {
    return { started: false, status: getConnectionStatus() };
  }
  cancelRetry();
  connect();
  return { started: true, status: getConnectionStatus() };
}


async function setEnabled(next) {
  if (typeof next !== "boolean") return { ok: false, error: "DELEGATE_INVALID_ENABLED" };
  if (!next && inFlight.size > 0) {
    return { ok: false, error: "DELEGATE_BUSY: Ada permintaan aktif; nonaktifkan setelah selesai." };
  }
  await chrome.storage.local.set({ delegateEnabled: next });
  enabled = next;
  if (!enabled) {
    cancelRetry();
    if (cdpDisconnectCleanupTimer !== null) clearTimeout(cdpDisconnectCleanupTimer);
    cdpDisconnectCleanupTimer = null;
    void cdpBridge.cleanup();
    isReady = false;
    lastError = null;
    connectedClients = [];
    setStatus("disabled");
    const oldSocket = socket;
    socket = null;
    if (oldSocket) oldSocket.close(1000, "Disabled by user");
  } else {
    lastError = null;
    connect();
    singleton.schedule();
  }
  return { ok: true, status: getConnectionStatus() };
}

async function setDelegateCdpEnabled(next) {
  if (typeof next !== "boolean") return { ok: false, error: "DELEGATE_CDP_INVALID_ENABLED" };
  if (!next && inFlight.size > 0) {
    return { ok: false, error: "DELEGATE_BUSY: wait for active requests before disabling Delegate-CDP." };
  }
  delegateCdpEnabled = next;
  await chrome.storage.local.set({ delegateCdpEnabled: next });
  if (!next) await cdpBridge.cleanup();
  return { ok: true, status: getConnectionStatus() };
}

async function setProfileLabel(next) {
  if (typeof next !== "string" || !next.trim() || next.trim().length > 48) {
    return { ok: false, error: "Nama profil harus 1–48 karakter." };
  }
  profileLabel = next.trim();
  await chrome.storage.local.set({ delegateProfileLabel: profileLabel });
  if (isReady) send({ type: "client_info", label: profileLabel });
  return { ok: true, status: getConnectionStatus() };
}

async function setPairingToken(next) {
  if (typeof next !== "string") return { ok: false, error: "Kode pairing harus berupa teks." };
  const normalized = next.toUpperCase().replace(/[\s-]/g, "");
  const shortCode = /^[A-HJ-NP-Z2-9]{8}$/.test(normalized);
  const longToken = next.length >= 32 && next.length <= 512;
  if (next && !shortCode && !longToken) {
    return { ok: false, error: "Masukkan kode 8 karakter dari terminal, atau kunci lama 32–512 karakter." };
  }
  if (inFlight.size) {
    return { ok: false, error: "DELEGATE_BUSY: Tunggu sampai operasi aktif selesai sebelum pairing." };
  }
  if (shortCode) {
    pairingCode = normalized; // RAM only, never persisted or returned via status
  } else {
    await chrome.storage.local.set({ delegateAuthToken: next });
    authToken = next; // legacy 32-512 character credential compatibility
    pairingCode = "";
  }
  authBlocked = false;
  lastError = null;
  cancelRetry();
  const old = socket;
  socket = null;
  isReady = false;
  connectedClients = [];
  if (old) old.close(1000, "Pairing updated");
  if (enabled) connect();
  else setStatus("disabled");
  return { ok: true, status: getConnectionStatus() };
}

// Manual repair is deliberately limited to bundled content.js on an exact
// ChatGPT tab. It does not reload the page, click, send or run arbitrary code.
async function attachContentScript(tabId) {
  if (!Number.isSafeInteger(tabId) || tabId < 1) {
    return { ok: false, error: "DELEGATE_INVALID_TAB_ID" };
  }
  const tab = await chrome.tabs.get(tabId);
  if (!/^https:\/\/chatgpt\.com(?:\/|$)/.test(tab?.url || "")) {
    return { ok: false, error: "DELEGATE_TAB_ORIGIN_DENIED" };
  }
  try {
    const existing = await chrome.tabs.sendMessage(tabId, { scope: PROTOCOL, action: "probe" });
    if (existing?.ready === true) return { ok: true, alreadyReady: true };
  } catch {}
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: false },
    files: ["content.js"],
    world: "ISOLATED",
  });
  const response = await chrome.tabs.sendMessage(tabId, { scope: PROTOCOL, action: "probe" });
  if (response?.ready !== true) {
    return { ok: false, error: "DELEGATE_TAB_REPAIR_UNVERIFIED" };
  }
  return { ok: true, repaired: true };
}

// Only the extension's own popup can query status or request reconnection.
// These messages never cause a ChatGPT DOM operation.
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id ||
      sender.url !== chrome.runtime.getURL("popup.html") ||
      message?.scope !== PROTOCOL) return false;
  if (message.action === "get_status") {
    respond({ ok: true, status: getConnectionStatus() });
    return false;
  }
  if (message.action === "reconnect") {
    respond({ ok: true, ...manualReconnect() });
    return false;
  }
  if (message.action === "attach_content") {
    attachContentScript(message.tabId)
      .then(respond, e => respond({ ok: false, error: String(e?.message || e) }));
    return true;
  }
  if (["set_enabled", "set_cdp_enabled", "set_label", "set_pairing"].includes(message.action)) {
    const task = message.action === "set_enabled"
      ? setEnabled(message.enabled)
      : message.action === "set_cdp_enabled"
        ? setDelegateCdpEnabled(message.enabled)
        : message.action === "set_label"
          ? setProfileLabel(message.label)
          : setPairingToken(message.token);
    task.then(respond, (reason) =>
      respond({ ok: false, error: String(reason?.message || reason) }));
    return true;
  }
  return false;
});

function selectChatTab(tabs) {
  return [...tabs]
    .filter((tab) => typeof tab.id === "number" && /^https:\/\/chatgpt\.com(?:\/|$)/.test(tab.url || ""))
    .sort((a, b) => (Number(b.active) - Number(a.active)) ||
      ((b.lastAccessed || 0) - (a.lastAccessed || 0)))[0];
}

async function waitForContentScript(tabId, ms = 4500) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { scope: PROTOCOL, action: "probe" });
      if (response?.ready === true) return;
    } catch {
      // Retry read-only probes only, never an action.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw error("CHATGPT_TAB_NOT_READY",
    "ChatGPT content script is unavailable. Sign in to chatgpt.com and try again.");
}

async function openChatTab() {
  try {
    const tab = await chrome.tabs.create({ url: "https://chatgpt.com/", active: true });
    if (!Number.isSafeInteger(tab?.id) || tab.id < 1) {
      throw new Error("Chrome did not return a valid tab ID.");
    }
    return tab;
  } catch {
    throw error("CHATGPT_TAB_OPEN_FAILED",
      "Delegate could not open chatgpt.com in this Chrome profile.");
  }
}

function validateHistoryChatId(value) {
  if (typeof value !== "string" || value.length < 8 || value.length > 180 ||
      !/^[a-zA-Z0-9:_-]+$/.test(value)) {
    throw error("DELEGATE_INVALID_CHAT_ID", "chatId must be a valid ChatGPT conversation ID.");
  }
  return value;
}

async function createHistoryWorkerTab() {
  const tab = await chrome.tabs.create({
    url: "https://chatgpt.com/#delegate-history-worker",
    active: false,
  });
  if (!Number.isSafeInteger(tab?.id) || tab.id < 1) {
    throw error("CHATGPT_HISTORY_WORKER_OPEN_FAILED", "Could not create the read-only history worker tab.");
  }
  await waitForContentScript(tab.id, 15_000);
  return tab;
}

async function closeHistoryWorkerTab(tabId) {
  try { await chrome.tabs.remove(tabId); } catch {}
}

async function navigateHistoryWorker(tabId, chatId, requestId) {
  const clean = validateHistoryChatId(chatId);
  return await executeHistoryContent(
    tabId, requestId + ":open:" + clean, "delegate.open_history_chat", { chatId: clean });
}

async function executeHistoryContent(tabId, id, method, params = {}) {
  const result = await chrome.tabs.sendMessage(tabId, {
    scope: PROTOCOL,
    action: "execute",
    id,
    method,
    params,
  });
  if (!result || typeof result !== "object") {
    throw error("DELEGATE_NO_RESPONSE", "History worker returned no result.");
  }
  if (result.ok !== true) {
    throw result.error || error("DELEGATE_HISTORY_TAB_ERROR", "History worker request failed.");
  }
  return result.result;
}

async function listOpenConversationTabs() {
  const tabs = await chrome.tabs.query({});
  const unique = new Map();
  for (const tab of tabs || []) {
    if (!Number.isSafeInteger(tab?.id) || typeof tab?.url !== "string") continue;
    const match = /^https:\/\/chatgpt\.com\/c\/([a-zA-Z0-9_-]{8,180})(?:[/?#]|$)/.exec(tab.url);
    if (!match) continue;
    const chatId = match[1];
    if (unique.has(chatId)) continue;
    unique.set(chatId, {
      chat_id: chatId,
      title: String(tab.title || "Untitled chat").slice(0, 2_000),
      url: "https://chatgpt.com/c/" + chatId,
    });
  }
  return [...unique.values()];
}

async function listChatsWithOpenTabFallback(workerId, requestId, params = {}) {
  const listing = await executeHistoryContent(
    workerId, requestId, "delegate.list_chats", params);
  if (Array.isArray(listing?.chats) && listing.chats.length > 0) return listing;

  const cursor = Number(params?.cursor ?? 0);
  const limit = Number(params?.limit ?? 50);
  if (!Number.isSafeInteger(cursor) || cursor < 0 ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    return listing;
  }
  const chats = await listOpenConversationTabs();
  const page = chats.slice(cursor, cursor + limit);
  const nextCursor = cursor + page.length < chats.length ? cursor + page.length : null;
  return {
    cursor,
    limit,
    chats: page,
    returned: page.length,
    scanned_unique: chats.length,
    scan_steps: 0,
    complete: false,
    next_cursor: nextCursor,
    fallback: "open_tabs",
  };
}

async function dispatchHistoryRequest(request) {
  const worker = await createHistoryWorkerTab();
  try {
    if (request.method === "delegate.list_chats") {
      return await listChatsWithOpenTabFallback(
        worker.id, request.id + ":list", request.params || {});
    }

    if (request.method === "delegate.read_chat_full") {
      await navigateHistoryWorker(worker.id, request.params?.chatId, request.id + ":full-nav");
      const params = { ...(request.params || {}) };
      delete params.chatId;
      return await executeHistoryContent(
        worker.id, request.id + ":full", "delegate.read_chat_full", params);
    }

    if (request.method === "delegate.search_history") {
      const query = typeof request.params?.query === "string" ? request.params.query.trim() : "";
      const resultLimit = Number(request.params?.limit ?? 20);
      const maxChats = Number(request.params?.maxChats ?? 100);
      if (!query || query.length > 500) {
        throw error("DELEGATE_INVALID_QUERY", "query must be 1 to 500 characters.");
      }
      if (!Number.isSafeInteger(resultLimit) || resultLimit < 1 || resultLimit > 50) {
        throw error("DELEGATE_INVALID_LIMIT", "limit must be an integer from 1 to 50.");
      }
      if (!Number.isSafeInteger(maxChats) || maxChats < 1 || maxChats > 500) {
        throw error("DELEGATE_INVALID_MAX_CHATS", "maxChats must be an integer from 1 to 500.");
      }

      const listing = await listChatsWithOpenTabFallback(
        worker.id, request.id + ":search-list",
        { cursor: 0, limit: Math.min(200, maxChats) });
      let chats = Array.isArray(listing?.chats) ? listing.chats : [];
      let cursor = listing?.next_cursor;
      while (chats.length < maxChats && cursor !== null && cursor !== undefined) {
        const page = await listChatsWithOpenTabFallback(
          worker.id, request.id + ":search-list:" + chats.length,
          { cursor: Number(cursor), limit: Math.min(200, maxChats - chats.length) });
        if (!Array.isArray(page?.chats) || page.chats.length === 0) {
          cursor = null;
          break;
        }
        chats = chats.concat(page.chats);
        cursor = page.next_cursor;
      }
      chats = chats.slice(0, maxChats);

      const needle = query.toLowerCase();
      const results = [];
      let scannedChats = 0;
      let skippedChats = 0;
      for (const chat of chats) {
        if (results.length >= resultLimit) break;
        scannedChats++;
        const title = String(chat?.title || "");
        if (title.toLowerCase().includes(needle)) {
          results.push({
            chat_id: chat.chat_id,
            title,
            url: chat.url,
            title_match: true,
            snippets: [],
          });
          continue;
        }
        try {
          await navigateHistoryWorker(worker.id, chat.chat_id, request.id + ":search-nav:" + scannedChats);
          const match = await executeHistoryContent(
            worker.id, request.id + ":search:" + scannedChats,
            "delegate.search_current_chat", { query, maxMatches: 3 });
          if (match?.matched) {
            results.push({
              chat_id: chat.chat_id,
              title: title || match.title || "Untitled chat",
              url: chat.url,
              title_match: !!match.title_match,
              snippets: Array.isArray(match.snippets) ? match.snippets : [],
              loaded_complete: match.loaded_complete !== false,
              total_message_count: Number(match.total_message_count || 0),
            });
          }
        } catch {
          skippedChats++;
        }
      }

      return {
        query,
        results,
        returned: results.length,
        scanned_chats: scannedChats,
        skipped_chats: skippedChats,
        listed_chats: chats.length,
        history_complete: cursor === null || cursor === undefined,
        max_chats: maxChats,
        result_limit: resultLimit,
      };
    }

    throw error("DELEGATE_UNKNOWN_METHOD", "Unsupported history method.");
  } finally {
    await closeHistoryWorkerTab(worker.id);
  }
}

const singleton = globalThis.createDelegateTabSingleton({
  chrome,
  enabled: () => initialized && enabled,
  busy: () => inFlight.size > 0,
  ensureContent: async (tabId) => {
    const ready = await attachContentScript(tabId);
    if (!ready?.ok) throw new Error(ready?.error || "DELEGATE_TAB_NOT_READY");
  },
});
singleton.register();

async function listOpenChatTabs() {
  const tabs = (await chrome.tabs.query({ url: "https://chatgpt.com/*" }))
    .filter(tab => Number.isSafeInteger(tab.id) &&
      /^https:\/\/chatgpt\.com(?:\/|$)/.test(tab.url || ""));
  const capped = tabs.slice(0, 40);
  const records = await Promise.all(capped.map(async tab => {
    const row = {
      tabId: tab.id,
      title: String(tab.title || "").slice(0, 160),
      url: String(tab.url || "").slice(0, 250),
      active: tab.active === true,
      status: "unavailable",
      ready: false,
    };
    if (tab.status !== "complete" || tab.discarded) return row;
    try {
      // Read-only content diagnostics. Never attach CDP, navigate or click Send.
      const info = await Promise.race([
        chrome.tabs.sendMessage(tab.id, {
          scope: PROTOCOL, action: "execute",
          id: "list-tabs:" + tab.id + ":" + Date.now(),
          method: "delegate.doctor", params: {},
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("tab_probe_timeout")), 1200)),
      ]);
      if (info?.ok === true && info.result?.ready === true) {
        return {
          ...row,
          ready: true,
          status: info.result.stop_visible === true ? "generating"
            : info.result.logged_in === false ? "login_required" : "idle",
        };
      }
    } catch {}
    return row;
  }));
  return { tabs: records, total: tabs.length, truncated: tabs.length > capped.length };
}

async function dispatchToTab(request) {
  if (request.method === "delegate.list_tabs") {
    return { ok: true, result: await listOpenChatTabs() };
  }
  if (HISTORY_METHODS.has(request.method)) {
    return { ok: true, result: await dispatchHistoryRequest(request) };
  }
  const tabs = await chrome.tabs.query({ url: "https://chatgpt.com/*" });
  const exactTab = request.params?.tabId;
  if (request.method === "delegate.create_chat" &&
      request.params?.newTab !== undefined &&
      typeof request.params.newTab !== "boolean") {
    throw error("DELEGATE_INVALID_NEW_TAB", "newTab must be a boolean.");
  }
  if (request.method === "delegate.create_chat" && request.params?.newTab === true) {
    if (exactTab !== undefined) {
      throw error("DELEGATE_INVALID_ARGUMENT", "newTab cannot be combined with tabId.");
    }
    // Start a new independent conversation without touching existing tabs.
    const created = await openChatTab();
    await waitForContentScript(created.id, 15_000);
    return { ok: true, result: {
      status: "new_chat", tabId: created.id, url: "https://chatgpt.com/",
    } };
  }
  if (exactTab === undefined && tabs.length > 1) {
    throw error("CHATGPT_MULTIPLE_TABS",
      "Multiple ChatGPT tabs in this Chrome profile. Choose an exact tabId from the Delegate popup. No action was dispatched.");
  }
  let tab = exactTab === undefined ? selectChatTab(tabs) : tabs.find((t) => t.id === exactTab);
  let waitMs = 4500;
  if (!tab && exactTab === undefined && tabs.length === 0) {
    tab = await openChatTab();
    waitMs = 15_000;
  }
  if (!tab) throw error("CHATGPT_TAB_NOT_FOUND",
    exactTab === undefined ? "No ChatGPT tab in this Chrome profile." : "Requested tabId not found in this Chrome profile.");
  await waitForContentScript(tab.id, waitMs);

  // Exactly one mutation dispatch. Never resend on timeout or reconnection.
  return chrome.tabs.sendMessage(tab.id, {
    scope: PROTOCOL,
    action: "execute",
    id: request.id,
    method: request.method,
    params: request.params || {},
  });
}

async function handleRequest(request) {
  if (typeof request.id !== "string" || !METHODS.has(request.method)) return;
  if (completed.has(request.id)) {
    send(completed.get(request.id));
    return;
  }
  if (inFlight.has(request.id)) return;
  inFlight.add(request.id);
  let response;
  try {
    if (request.method.startsWith("delegate.cdp.")) {
      const result = await cdpBridge.dispatch(request.method, request.params || {});
      response = { type: "response", id: request.id, ok: true, result };
    } else {
      const result = await dispatchToTab(request);
      if (!result || typeof result !== "object") throw error(
        "DELEGATE_NO_RESPONSE", "ChatGPT tab returned no result. Do not auto-resend.");
      if (result.ok !== true) throw result.error ||
        error("DELEGATE_TAB_ERROR", "Request failed in ChatGPT tab");
      response = { type: "response", id: request.id, ok: true, result: result.result };
    }
  } catch (reason) {
    response = {
      type: "response", id: request.id, ok: false,
      error: {
        code: String(reason?.code || "DELEGATE_DISPATCH_FAILED"),
        message: String(reason?.message || reason || "Unknown extension failure"),
      },
    };
  } finally {
    inFlight.delete(request.id);
    singleton.schedule();
  }
  completed.set(request.id, response);
  if (completed.size > 128) completed.delete(completed.keys().next().value);
  send(response);
}

function ensureWakeAlarm() {
  chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 0.5 });
}
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM) {
    connect();
    // A tab might finish rendering its composer AFTER navigation completed.
    // Periodically retry safe cleanup, even if no new tab event fires.
    singleton.schedule();
    if (enabled && delegateCdpEnabled) {
      // Re-arm title markers for genuinely attached tabs. The existing alarm
      // is the sole heartbeat; do not create another polling service.
      void cdpBridge.refreshIndicators?.();
    }
  }
});
chrome.runtime.onStartup.addListener(() => { ensureWakeAlarm(); connect(); });
chrome.runtime.onInstalled.addListener(() => { ensureWakeAlarm(); connect(); });

// A unique ID is stored per extension installation and Chrome profile.
// Turning OFF persists across service-worker restarts and disables retries.
// Never expose the stored pairing secret to content scripts on ChatGPT pages.
// Only the trusted service worker and popup may access extension-local storage.
chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }, () => {
  if (chrome.runtime.lastError) {
    initialized = true;
    enabled = false;
    lastError = "Tidak bisa mengamankan penyimpanan pairing di Chrome ini.";
    setStatus("disabled");
    return;
  }
  chrome.storage.local.get(
  ["delegateEnabled", "delegateCdpEnabled", "delegateClientId", "delegateProfileLabel", "delegateAuthToken"],
  (saved) => {
    enabled = saved?.delegateEnabled !== false;
    delegateCdpEnabled = saved?.delegateCdpEnabled === true;
    authToken = typeof saved?.delegateAuthToken === "string" ? saved.delegateAuthToken : "";
    clientId = typeof saved?.delegateClientId === "string" &&
      /^[a-zA-Z0-9_-]{8,80}$/.test(saved.delegateClientId)
      ? saved.delegateClientId : crypto.randomUUID();
    profileLabel = typeof saved?.delegateProfileLabel === "string" &&
      saved.delegateProfileLabel.trim()
      ? saved.delegateProfileLabel.trim().slice(0, 48) : "Chrome Delegate";
    initialized = true;
    if (clientId !== saved?.delegateClientId) {
      void chrome.storage.local.set({ delegateClientId: clientId });
    }
    ensureWakeAlarm();
    if (enabled) {
      connect();
      singleton.schedule(1100);
    } else setStatus("disabled");
  },
  );
});
renderBadge();
setInterval(() => {
  if (socket?.readyState === WebSocket.OPEN && isReady) send({ type: "ping" });
  else if (enabled && initialized && !socket && reconnectTimer === null) connect();
}, 20_000);

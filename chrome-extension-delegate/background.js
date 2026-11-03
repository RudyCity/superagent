/* Dedicated ChatGPT Delegate service worker: fixed localhost RPC only. */
const ENDPOINT = "ws://127.0.0.1:17341";
const PROTOCOL = "superagent-delegate-v1";
const METHODS = new Set([
  "delegate.create_chat",
  "delegate.read_chat",
  "delegate.send_message",
  "delegate.stop_generation",
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

const inFlight = new Set();
const completed = new Map();

function error(code, message) {
  return { code, message };
}

function getConnectionStatus() {
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
  if (!enabled) return { started: false, status: getConnectionStatus() };
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
  }
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
  if (["set_enabled", "set_label", "set_pairing"].includes(message.action)) {
    const task = message.action === "set_enabled"
      ? setEnabled(message.enabled)
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
    "ChatGPT content script is unavailable. Open a logged-in chatgpt.com tab and try again.");
}

async function dispatchToTab(request) {
  const tabs = await chrome.tabs.query({ url: "https://chatgpt.com/*" });
  const exactTab = request.params?.tabId;
  if (exactTab === undefined && tabs.length > 1) {
    throw error("CHATGPT_MULTIPLE_TABS",
      "Multiple ChatGPT tabs in this Chrome profile. Choose an exact tabId from the Delegate popup. No action was dispatched.");
  }
  const tab = exactTab === undefined ? selectChatTab(tabs) : tabs.find((t) => t.id === exactTab);
  if (!tab) throw error("CHATGPT_TAB_NOT_FOUND",
    exactTab === undefined ? "No ChatGPT tab in this Chrome profile." : "Requested tabId not found in this Chrome profile.");
  await waitForContentScript(tab.id);

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
    const result = await dispatchToTab(request);
    if (!result || typeof result !== "object") throw error(
      "DELEGATE_NO_RESPONSE", "ChatGPT tab returned no result. Do not auto-resend.");
    if (result.ok !== true) throw result.error ||
      error("DELEGATE_TAB_ERROR", "Request failed in ChatGPT tab");
    response = { type: "response", id: request.id, ok: true, result: result.result };
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
  }
  completed.set(request.id, response);
  if (completed.size > 128) completed.delete(completed.keys().next().value);
  send(response);
}

function ensureWakeAlarm() {
  chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 0.5 });
}
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM) connect();
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
  ["delegateEnabled", "delegateClientId", "delegateProfileLabel", "delegateAuthToken"],
  (saved) => {
    enabled = saved?.delegateEnabled !== false;
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
    if (enabled) connect();
    else setStatus("disabled");
  },
  );
});
renderBadge();
setInterval(() => {
  if (socket?.readyState === WebSocket.OPEN && isReady) send({ type: "ping" });
  else if (enabled && initialized && !socket && reconnectTimer === null) connect();
}, 20_000);

/* Local-only, fixed-method bridge. No execute-script, arbitrary URL, or API-key path. */
const ENDPOINT = "ws://127.0.0.1:17341";
const PROTOCOL = "superagent-delegate-v1";
const METHODS = new Set([
  "delegate.create_chat",
  "delegate.read_chat",
  "delegate.send_message",
  "delegate.stop_generation",
]);

let socket = null;
let reconnectTimer = null;
let isReady = false;
const inFlight = new Set();
const completed = new Map();

function error(code, message) {
  return { code, message };
}

function send(payload) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function connect() {
  if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) return;
  const ws = new WebSocket(ENDPOINT);
  socket = ws;
  isReady = false;
  ws.addEventListener("open", () => {
    send({ type: "hello", protocol: PROTOCOL });
  });
  ws.addEventListener("message", (event) => {
    let envelope;
    try { envelope = JSON.parse(event.data); } catch { return; }
    if (envelope?.type === "hello_ack" && envelope.protocol === PROTOCOL) {
      isReady = true;
      return;
    }
    if (!isReady || envelope?.type !== "request") return;
    void handleRequest(envelope);
  });
  ws.addEventListener("close", () => {
    isReady = false;
    if (socket === ws) socket = null;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 1000);
  });
  ws.addEventListener("error", () => { /* close event schedules reconnect */ });
}

function selectChatTab(tabs) {
  return [...tabs]
    .filter((tab) => typeof tab.id === "number" && /^https:\/\/chatgpt\.com(?:\/|$)/.test(tab.url || ""))
    .sort((a, b) => (Number(b.active) - Number(a.active)) || ((b.lastAccessed || 0) - (a.lastAccessed || 0)))[0];
}

async function waitForContentScript(tabId, ms = 4500) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { scope: PROTOCOL, action: "probe" });
      if (response?.ready === true) return;
    } catch {
      // Only a read-only probe is retried while the tab is initializing.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw error("CHATGPT_TAB_NOT_READY", "ChatGPT content script is unavailable. Open a logged-in chatgpt.com tab and try again.");
}

async function dispatchToTab(request) {
  const tabs = await chrome.tabs.query({ url: "https://chatgpt.com/*" });
  const tab = selectChatTab(tabs);
  if (!tab) throw error("CHATGPT_TAB_NOT_FOUND", "Open chatgpt.com in Chrome; no ChatGPT tab is available.");
  await waitForContentScript(tab.id);
  // Dispatch the requested mutation exactly ONCE. A rejected/late
  // response never triggers a second message submission.
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
  if (inFlight.has(request.id)) return; // never duplicate side effects
  inFlight.add(request.id);
  let response;
  try {
    const result = await dispatchToTab(request);
    if (!result || typeof result !== "object") throw error("DELEGATE_NO_RESPONSE", "ChatGPT tab returned no result; do not auto-resend.");
    if (result.ok !== true) throw result.error || error("DELEGATE_TAB_ERROR", "Request failed in ChatGPT tab");
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
  // Bounded, per-service-worker deduplication cache. Never automatically replays actions.
  completed.set(request.id, response);
  if (completed.size > 128) completed.delete(completed.keys().next().value);
  send(response);
}

connect();
// Chrome 116+ permits service workers to remain active via WebSocket
// heartbeat, without background tabs, refresh loops, or page reloads.
setInterval(() => {
  if (socket?.readyState === WebSocket.OPEN) send({ type: "ping" });
  else connect();
}, 20_000);

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);

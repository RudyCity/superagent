#!/usr/bin/env node
/**
 * Live Linux Xvfb -> Chrome -> x11vnc -> websockify/noVNC input smoke.
 * Local-only ephemeral process group, driven by scripts/linux-takeover-smoke.sh.
 * No remote sites or user browser profiles; validates actual VNC pointer/keyboard
 * delivery against Chrome's DOM via CDP, not just a handshake.
 */
import { createCipheriv } from "node:crypto";
import { WebSocket as NodeWebSocket } from "ws";
const cdpPort = process.env.M4C_CDP_PORT;
const wsPort = process.env.M4C_WS_PORT;
if (!cdpPort || !wsPort) throw new Error("M4C localhost endpoints not supplied.");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitForJson(url, fn) {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(850) });
      if (r.ok) { const j = await r.json(); if (fn(j)) return j; }
    } catch {}
    await sleep(120);
  }
  throw new Error("CDP did not become ready");
}
function openWs(url, options = {}) {
  return new Promise((resolve, reject) => {
    const ws = new NodeWebSocket(url, options.protocols || [],
      { headers: options.origin ? { Origin: options.origin } : undefined });
    ws.binaryType = "arraybuffer";
    const timeout = setTimeout(() => { ws.close(); reject(new Error("WebSocket connection timed out")); }, 7000);
    ws.addEventListener("open", () => { clearTimeout(timeout); resolve(ws); }, { once: true });
    ws.on("unexpected-response", (_req, response) => {
      response.resume();
      clearTimeout(timeout);
      reject(new Error("WebSocket handshake rejected: HTTP " + response.statusCode));
    });
    ws.addEventListener("error", () => { clearTimeout(timeout); reject(new Error("WebSocket connection failed")); }, { once: true });
  });
}
async function cdpClient(targetUrl) {
  const ws = await openWs(targetUrl);
  let id = 1;
  const pending = new Map();
  ws.addEventListener("message", event => {
    const data = JSON.parse(event.data);
    if (!data.id) return;
    const p = pending.get(data.id);
    if (!p) return;
    pending.delete(data.id);
    if (data.error) p.reject(new Error(JSON.stringify(data.error)));
    else p.resolve(data.result);
  });
  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const num = id++;
      pending.set(num, { resolve, reject });
      ws.send(JSON.stringify({ id: num, method, params }));
    });
  }
  return { ws, send };
}
async function waitFor(predicate, description, seconds = 8) {
  for (let i = 0; i < seconds * 12; i++) {
    if (await predicate()) return;
    await sleep(84);
  }
  throw new Error(description);
}
const pageHtml = '<html><head><meta charset="utf-8"/></head>' +
  '<body style="margin:0;background:#d0e4ff;font:20px sans-serif;height:100vh">' +
  '<div style="padding:100px"><h1>Local M4C input probe</h1>' +
  '<input id="probe" autofocus style="font:30px sans-serif;width:500px;height:65px" /></div>' +
  '<script>window.m4c={clicks:0,keys:[]};' +
  'document.addEventListener("pointerdown",e=>{window.m4c.clicks++; window.m4c.x=e.clientX;window.m4c.y=e.clientY;});' +
  'document.addEventListener("keydown",e=>{window.m4c.keys.push(e.key);});</script>' +
  '</body></html>';
const pages = await waitForJson('http://127.0.0.1:' + cdpPort + '/json/list',
  ps => ps.some(p => p.type === "page" && p.webSocketDebuggerUrl));
const page = pages.find(p => p.type === "page" && p.webSocketDebuggerUrl);
const devtools = await cdpClient(page.webSocketDebuggerUrl);
const proxyUrl = process.env.M4C_PROXY_WS_URL;
const proxyToken = process.env.M4C_OPERATOR_TOKEN;
const vncPassword = process.env.M4C_VNC_PASSWORD;
const vnc = await openWs(proxyUrl || ('ws://127.0.0.1:' + wsPort + '/websockify'), {
  protocols: proxyUrl ? ["binary", "operator." + proxyToken] : [],
  origin: proxyUrl ? new URL(proxyUrl).origin.replace(/^ws/, "http").split("/").join("/") : undefined,
});
let rfbVersion = null;
try {
  await devtools.send("Page.enable");
  await devtools.send("Page.navigate", { url: 'data:text/html,' + encodeURIComponent(pageHtml) });
  async function evalPage(expression) {
    const data = await devtools.send("Runtime.evaluate", { expression, returnByValue: true });
    return data.result.value;
  }
  await waitFor(async () => (await evalPage("Boolean(window.m4c && document.getElementById('probe'))")) === true,
    "Local Chrome probe page not ready");

  // Each RFB handshake stage consumes exactly one server response. The loop
  // supports partial/chunked transport frames rather than relying on alignment.
  let buffer = Buffer.alloc(0);
  const packets = [];
  let signal;
  let stage = "version";
  let framebuffer = null;
  function send(bytes) { vnc.send(bytes); }
  const handshakeReady = new Promise((resolve, reject) => {
    signal = { resolve, reject };
  });
  vnc.addEventListener("message", ev => {
    const incoming = Buffer.from(ev.data);
    buffer = Buffer.concat([buffer, incoming]);
    try {
      for (;;) {
        if (stage === "version") {
          if (buffer.length < 12) break;
          rfbVersion = buffer.subarray(0, 12).toString();
          buffer = buffer.subarray(12);
          if (!rfbVersion.startsWith("RFB 003.")) throw new Error("Not an RFB server");
          send(Buffer.from("RFB 003.008\n"));
          stage = "security";
        } else if (stage === "security") {
          if (buffer.length < 1) break;
          const n = buffer.readUInt8(0);
          if (!n) throw new Error("Server offers no RFB authentication methods");
          if (buffer.length < 1 + n) break;
          const offered = buffer.subarray(1, 1 + n);
          buffer = buffer.subarray(1 + n);
          // Owned Linux VNC uses x11vnc password authentication (type 2).
          // The earlier localhost-only no-password smoke may use type 1.
          if (vncPassword && offered.includes(2)) {
            send(Buffer.from([2]));
            stage = "vnc-challenge";
          } else if (!vncPassword && offered.includes(1)) {
            send(Buffer.from([1]));
            stage = "security-result";
          } else {
            throw new Error("RFB server requires a different authentication method");
          }
        } else if (stage === "vnc-challenge") {
          if (buffer.length < 16) break;
          const challenge = buffer.subarray(0, 16);
          buffer = buffer.subarray(16);
          // RFB VNCAuth uses DES with bit-reversed password bytes, repeated
          // key EDE3 is equivalent to single DES (OpenSSL 3 provider-safe).
          const passwordBytes = Buffer.alloc(8);
          Buffer.from(vncPassword.slice(0, 8)).copy(passwordBytes);
          const reverse = n => { let r = 0; for (let b = 0; b < 8; b++) r = (r << 1) | ((n >> b) & 1); return r; };
          const key = Buffer.from(passwordBytes.map(reverse));
          const cipher = createCipheriv("des-ede3", Buffer.concat([key, key, key]), null);
          cipher.setAutoPadding(false);
          send(Buffer.concat([cipher.update(challenge), cipher.final()]));
          stage = "security-result";
        } else if (stage === "security-result") {
          if (buffer.length < 4) break;
          const result = buffer.readUInt32BE(0);
          buffer = buffer.subarray(4);
          if (result !== 0) throw new Error("RFB authentication rejected");
          send(Buffer.from([1])); // shared desktop
          stage = "server-init";
        } else if (stage === "server-init") {
          if (buffer.length < 24) break;
          const width = buffer.readUInt16BE(0);
          const height = buffer.readUInt16BE(2);
          const nameLength = buffer.readUInt32BE(20);
          if (nameLength > 4096) throw new Error("Unexpectedly large RFB server name");
          if (buffer.length < 24 + nameLength) break;
          framebuffer = { width, height };
          buffer = buffer.subarray(24 + nameLength);
          stage = "ready";
          signal.resolve(framebuffer);
        } else { break; }
      }
    } catch (e) { signal.reject(e); }
  });

  const fb = await Promise.race([
    handshakeReady,
    new Promise((_, reject) => setTimeout(() => reject(new Error("RFB initialization timed out at " + stage)), 9000)),
  ]);
  // RFB PointerEvent: [5, buttonMask, x uint16, y uint16]; click into page
  // content below the browser's location bar, then type a normal 'a' key.
  function pointer(buttons, x, y) {
    const frame = Buffer.alloc(6);
    frame[0] = 5; frame[1] = buttons;
    frame.writeUInt16BE(x, 2); frame.writeUInt16BE(y, 4);
    send(frame);
  }
  function key(down, keySym) {
    const frame = Buffer.alloc(8);
    frame[0] = 4; frame[1] = down ? 1 : 0; frame.writeUInt32BE(keySym, 4);
    send(frame);
  }
  pointer(0, 300, 300);
  pointer(1, 300, 300);
  pointer(0, 300, 300);
  key(true, 0x61);
  key(false, 0x61);
  await waitFor(async () => {
    const result = await evalPage("JSON.stringify(window.m4c)");
    if (result) { const state = JSON.parse(result); return state.clicks >= 1 && state.keys.includes("a"); }
    return false;
  }, "VNC pointer/key events did not reach the Linux Chrome page", 12);
  const observed = JSON.parse(await evalPage("JSON.stringify(window.m4c)"));
  console.log(JSON.stringify({
    status: "M4C_LINUX_INPUT_PASS",
    rfb: rfbVersion.trim(),
    framebuffer: fb,
    pointerEvents: observed.clicks,
    pointerLocation: { x: observed.x, y: observed.y },
    typedKey: observed.keys.includes("a"),
    cdpPage: "local-data-url",
  }, null, 2));
} finally {
  try { vnc.close(); } catch {}
  try { devtools.ws.close(); } catch {}
}

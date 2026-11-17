/**
 * Read-only loopback viewer shell. The approved preview token is handed off in a
 * URL fragment (never sent in a request line), then removed from browser history.
 * The frame request is same-origin POST on loopback; this UI has no input,
 * takeover, or remote controller channel.
 */
export function renderLanReadOnlyViewer(nonce: string): string {
  if (!/^[A-Za-z0-9+/]{22}==$/.test(nonce)) throw Error("INVALID_CSP_NONCE");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SuperAgent Desktop Live · Local Read-only Viewer</title>
<style>
:root{color-scheme:dark;font:14px system-ui,sans-serif;background:#0a0f1c;color:#e5e7eb}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;flex-direction:column}
header{padding:16px 22px;border-bottom:1px solid #2a3347;display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}
h1{font-size:17px;margin:0}small{color:#94a3b8}main{flex:1;display:grid;place-items:center;padding:20px}
section{width:min(100%,1360px)}#frame{display:block;width:100%;height:auto;max-height:80vh;object-fit:contain;background:#000;border:1px solid #2a3347;border-radius:12px}
#status{padding:12px 0;color:#cbd5e1;overflow-wrap:anywhere}button{padding:9px 18px;background:#1e293b;color:white;border:1px solid #475569;border-radius:8px;cursor:pointer}
button:focus-visible{outline:2px solid #38bdf8}footer{padding:14px 22px;color:#94a3b8;border-top:1px solid #2a3347}
</style></head><body>
<header><h1>Desktop Live <small>Local · View only</small></h1><button id="stop" type="button">Stop viewing</button></header>
<main><section><img id="frame" alt="Approved application window preview" hidden><p id="status" role="status">Connecting to approved preview…</p></section></main>
<footer>Remote screen sharing requires separately authorized, encrypted transport. This local viewer never grants controller access.</footer>
<script nonce="${nonce}">
"use strict";
(() => {
  const tokenMatch = /^#token=([a-f0-9]{64})$/.exec(location.hash);
  const token = tokenMatch ? tokenMatch[1] : null;
  history.replaceState(null, "", location.pathname);
  const image = document.getElementById("frame");
  const status = document.getElementById("status");
  const stop = document.getElementById("stop");
  let active = !!token, hash = null, handle = null;
  const halt = (message) => {
    active = false;
    if (handle !== null) clearTimeout(handle);
    handle = null;
    status.textContent = message;
  };
  stop.addEventListener("click", () => {
    halt("Viewing stopped on this device. The host session remains under Tray control.");
    image.hidden = true;
    image.removeAttribute("src");
  });
  if (!token) { halt("A locally approved preview invitation is required."); return; }
  async function frame() {
    if (!active) return;
    if (document.hidden) { handle = setTimeout(frame, 500); return; }
    try {
      const response = await fetch("/api/desktop/live/lan-frame", {
        method: "POST", credentials: "omit", cache: "no-store",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({token, ...(hash ? {knownHash: hash} : {})}),
      });
      if (!response.ok) throw Error("Preview expired, revoked, or unavailable.");
      const result = await response.json();
      if (!active) return;
      if (result.success !== true) throw Error("Preview unavailable.");
      if (typeof result.jpeg === "string" && result.jpeg.length > 0) {
        image.src = "data:image/jpeg;base64," + result.jpeg;
        image.hidden = false;
      }
      if (typeof result.hash === "string") hash = result.hash;
      status.textContent = "Live preview · View only";
      handle = setTimeout(frame, result.unchanged ? 140 : 90);
    } catch {
      halt("Preview ended. Start a new approved session from SuperAgent Tray.");
    }
  }
  frame();
})();
</script></body></html>`;
}

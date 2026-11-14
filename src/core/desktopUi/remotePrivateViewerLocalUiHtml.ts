/**
 * Static, self-hosted loopback UI. Browser code has no mTLS keys, viewer grant,
 * pairing proof, access cookie, or input-control interface.
 */
export const PRIVATE_VIEWER_CSS = String.raw`
:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;background:#09111b;color:#e9f0f7}
*{box-sizing:border-box}body{margin:0;min-height:100vh}.shell{max-width:1240px;margin:0 auto;padding:24px clamp(16px,3vw,38px) 40px}
header{display:flex;align-items:center;justify-content:space-between;gap:16px;border-bottom:1px solid #26384b;padding-bottom:22px}
.brand{font-weight:800;letter-spacing:-.04em;font-size:24px}.brand small{font-weight:500;letter-spacing:.08em;color:#7fa4c4;font-size:11px;text-transform:uppercase;display:block;margin-top:4px}
.pill{display:inline-flex;gap:7px;align-items:center;border:1px solid #48617a;border-radius:99px;padding:6px 11px;color:#d5e6f6;font-size:12px;font-weight:650}
.pill:before{content:"";height:7px;width:7px;border-radius:50%;background:#98a9ba}
main{display:grid;grid-template-columns:minmax(0,1fr) 260px;gap:20px;margin-top:26px}
.stage{min-width:0;border:1px solid #27394c;background:#030912;border-radius:15px;position:relative;overflow:hidden}
.stage img{max-width:100%;max-height:min(71vh,810px);width:100%;height:auto;object-fit:contain;display:none}
.stage img.visible{display:block}.is-hidden{display:none!important}.placeholder{min-height:clamp(250px,53vw,550px);display:grid;align-content:center;justify-items:center;text-align:center;padding:25px}
.placeholder strong{font-size:20px;letter-spacing:-.025em}.placeholder p{color:#94aabc;font-size:14px;max-width:330px;line-height:1.6}
.reel{position:absolute;top:15px;left:15px;background:#071522df;border:1px solid #37516a;border-radius:5px;padding:7px 10px;font:600 11px ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.08em}
.panel{border:1px solid #27394c;background:#101f2e;border-radius:15px;padding:22px;height:fit-content}
h1{font-size:25px;line-height:1.15;letter-spacing:-.04em;margin:0 0 10px}p{line-height:1.6;color:#a5bed3;margin:0 0 18px;font-size:13px}
.field{display:flex;justify-content:space-between;gap:12px;border-top:1px solid #2c4154;padding:13px 0;font-size:13px}.field span:first-child{color:#91abc1}.field strong{font-variant-numeric:tabular-nums;text-align:right}
.actions{display:flex;flex-wrap:wrap;gap:10px;margin:20px 0}
button{appearance:none;border-radius:9px;border:1px solid #729bd0;background:#86b9f4;color:#071321;font:700 13px inherit;padding:11px 16px;min-height:44px;cursor:pointer;transition:background .12s ease,transform .12s ease}
button:hover:not(:disabled){background:#b0d2ff}button:active:not(:disabled){transform:translateY(1px)}
button:focus-visible,input:focus-visible{outline:3px solid #e8b16f;outline-offset:3px}
button:disabled{opacity:.5;cursor:not-allowed}button.secondary{background:transparent;color:#dceaff;border-color:#607a97}
button.secondary:hover:not(:disabled){background:#263f55}
.notice{font-size:12px;line-height:1.65;border-top:1px solid #2c4154;padding-top:16px;color:#a5bdcf}
.lock{max-width:390px;margin:12vh auto 0;padding:28px;background:#101f2e;border:1px solid #334b61;border-radius:15px}
.lock label{display:block;font-size:13px;margin:18px 0 8px}.lock input{width:100%;height:44px;border:1px solid #57718d;border-radius:8px;background:#081423;color:#edf5fb;padding:10px 12px}
.lock button{margin-top:18px;width:100%}.error{color:#ffb2a7}.subhead{font:600 11px ui-monospace,SFMono-Regular,Consolas,monospace;color:#91b5d0;letter-spacing:.12em;text-transform:uppercase;margin:0 0 10px}
footer{color:#829bb0;font-size:12px;padding-top:22px}
@media(max-width:768px){main{grid-template-columns:1fr}.panel{order:-1}.shell{padding:17px 15px 30px}header{padding-bottom:16px}.brand{font-size:21px}.panel{padding:17px}.placeholder{min-height:240px}}
@media(prefers-reduced-motion:reduce){button{transition:none}}
`;

export const PRIVATE_VIEWER_LOCK_HTML = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SuperAgent · Private viewer access</title><link rel="stylesheet" href="/viewer.css"></head>
<body><main class="lock"><div class="subhead">PRIVATE · LOOPBACK ONLY</div>
<h1>Local viewer access</h1><p>Enter the one-time process access secret from this viewer machine's terminal. It is never part of a link.</p>
<form method="post" action="/unlock" autocomplete="off"><label for="code">Access secret</label>
<input id="code" name="code" type="password" required autocomplete="off" spellcheck="false" maxlength="128">
<button type="submit">Unlock viewer</button></form>
<p class="notice">The browser only receives image frames. Starting a view also requires the host's separate attended native approval.</p>
</main></body></html>`;

export const PRIVATE_VIEWER_HTML = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SuperAgent · Desktop Live</title><link rel="stylesheet" href="/viewer.css">
<script src="/viewer.js" defer></script></head>
<body><div class="shell"><header><div class="brand">SuperAgent <small>Private desktop live / local viewer</small></div>
<span class="pill">View-only · Private</span></header>
<main><section class="stage" aria-label="Remote window image, view only">
<div id="reel" class="reel" role="status" aria-live="polite">NOT CONNECTED</div>
<div class="placeholder" id="placeholder"><strong>Ready for an approved window</strong>
<p>After the host approves the exact native window, press Start view. No desktop input is available here.</p></div>
<img id="frame" alt="Live image of the specifically approved remote desktop window"></section>
<aside class="panel"><div class="subhead">Session monitor</div><h1>Desktop Live</h1>
<p>One private mTLS session. Frames are transient; recording, clipboard and remote control are not provided.</p>
<div class="field"><span>Connection</span><strong id="phase" role="status" aria-live="polite">Idle</strong></div>
<div class="field"><span>Freshness</span><strong id="freshness">No frame</strong></div>
<div class="field"><span>Frame</span><strong id="sequence">—</strong></div>
<div class="field"><span>Resolution</span><strong id="resolution">—</strong></div>
<div class="actions"><button id="start" type="button">Start view</button><button id="stop" type="button" class="secondary" disabled>Stop session</button></div>
<div class="notice" id="explanation" role="status" aria-live="polite">Local viewer is ready. The remote host is not connected yet.</div></aside></main>
<footer>Private transport · Native host approval required · Loopback browser only · No recording</footer>
</div></body></html>`;

/**
 * Serialized as a standalone script by the HTTP handler. No interpolation of
 * user text, filenames, hostnames, secrets or credentials into the browser.
 */
export function privateViewerBrowserMain(): void {
  const get = (id: string) => document.getElementById(id) as HTMLElement;
  const start = get("start") as HTMLButtonElement;
  const stop = get("stop") as HTMLButtonElement;
  const image = get("frame") as HTMLImageElement;
  const placeholder = get("placeholder");
  const phase = get("phase");
  const freshness = get("freshness");
  const sequence = get("sequence");
  const resolution = get("resolution");
  const explanation = get("explanation");
  const reel = get("reel");
  let active = false;
  let lastSequence = 0;
  let lastCapture = 0;
  let objectUrl: string | null = null;
  let request: AbortController | null = null;
  let terminal = false;
  function paintStatus(): void {
    if (terminal) { freshness.textContent = "Ended"; reel.textContent = "SESSION ENDED"; return; }
    if (!lastCapture) { freshness.textContent = "No frame"; reel.textContent = active ? "AWAITING FRAME" : "NOT CONNECTED"; return; }
    const age = Math.max(0, Date.now() - lastCapture);
    const stale = age > 3000;
    freshness.textContent = stale ? "Stale · " + (age / 1000).toFixed(1) + "s" : "Fresh · " + (age / 1000).toFixed(1) + "s";
    reel.textContent = stale ? "STALE FRAME" : "LIVE · VIEW ONLY";
  }
  function finish(message: string): void {
    terminal = true; active = false; request?.abort();
    start.disabled = true; stop.disabled = true;
    phase.textContent = "Disconnected"; explanation.textContent = message;
    if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
    image.removeAttribute("src"); image.classList.remove("visible");
    placeholder.classList.remove("is-hidden");
    paintStatus();
  }
  async function signedPost(path: string): Promise<Response> {
    return fetch(path, { method: "POST", credentials: "same-origin",
      headers: { "x-viewer-request": "1", "content-type": "application/json" },
      body: "{}", cache: "no-store" });
  }
  async function display(response: Response): Promise<void> {
    const kind = response.headers.get("content-type");
    if (kind !== "image/jpeg" && kind !== "image/png") throw new Error("Unrecognized image type");
    const seq = Number(response.headers.get("x-frame-sequence"));
    const captured = Number(response.headers.get("x-frame-captured-at"));
    const width = Number(response.headers.get("x-frame-width"));
    const height = Number(response.headers.get("x-frame-height"));
    const digest = response.headers.get("x-frame-sha256");
    if (!Number.isSafeInteger(seq) || seq <= lastSequence ||
        !Number.isSafeInteger(captured) || captured <= lastCapture ||
        !Number.isSafeInteger(width) || width < 1 || width > 1920 ||
        !Number.isSafeInteger(height) || height < 1 || height > 1920 ||
        !digest || !/^[a-f0-9]{64}$/.test(digest)) throw new Error("Invalid frame metadata");
    const data = await response.arrayBuffer();
    if (data.byteLength < 12 || data.byteLength > 3000000) throw new Error("Invalid frame length");
    const check = await crypto.subtle.digest("SHA-256", data);
    const hex = Array.from(new Uint8Array(check), value => value.toString(16).padStart(2, "0")).join("");
    if (hex !== digest) throw new Error("Image digest mismatch");
    const nextUrl = URL.createObjectURL(new Blob([data], { type: kind }));
    try {
      image.src = nextUrl;
      await image.decode();
      if (!active) { URL.revokeObjectURL(nextUrl); return; }
      const previous = objectUrl;
      objectUrl = nextUrl;
      if (previous) URL.revokeObjectURL(previous);
      image.classList.add("visible"); placeholder.classList.add("is-hidden");
      lastSequence = seq; lastCapture = captured;
      sequence.textContent = "#" + seq;
      resolution.textContent = width + " × " + height;
      paintStatus();
    } catch (error) {
      URL.revokeObjectURL(nextUrl);
      throw error;
    }
  }
  async function frames(): Promise<void> {
    while (active) {
      request = new AbortController();
      try {
        const response = await fetch("/api/frame?after=" + lastSequence, {
          signal: request.signal, cache: "no-store", credentials: "same-origin" });
        if (!active) return;
        if (response.status === 204) { paintStatus(); continue; }
        if (!response.ok) throw new Error("Private stream ended");
        await display(response);
      } catch (error) {

        if (active) {
          void signedPost("/api/stop").catch(() => {});
          finish("Frame verification or private connection failed. Start a fresh, separately approved process.");
        }
        return;
      } finally { request = null; }
    }
  }
  start.addEventListener("click", async () => {
    if (active || terminal) return;
    start.disabled = true; phase.textContent = "Connecting";
    explanation.textContent = "Waiting for separately authorized private mTLS attachment.";
    try {
      const response = await signedPost("/api/start");
      if (!response.ok) throw new Error("Host authorization was not completed");
      active = true; stop.disabled = false;
      phase.textContent = "Connected"; explanation.textContent = "Rendering only verified, fresh frames.";
      void frames();
    } catch {
      finish("Private attach denied, expired or unavailable. No retry occurs in this process.");
    }
  });
  stop.addEventListener("click", () => {
    if (terminal) return;
    active = false; request?.abort();
    void signedPost("/api/stop").finally(() => finish("Stopped by the local viewer."));
  });
  window.addEventListener("pagehide", () => {
    if (active) {
      active = false; request?.abort();
      void signedPost("/api/stop").catch(() => {});
    }
  });
  window.setInterval(async () => {
    if (terminal) return;
    paintStatus();
    try {
      const response = await fetch("/api/status", { cache: "no-store", credentials: "same-origin" });
      if (!response.ok) { finish("Session access lost."); return; }
      const status = await response.json() as { state: string };
      if (status.state === "stopped") finish("Session ended or expired. A fresh native approval is required.");
    } catch { finish("Local viewer disconnected."); }
  }, 750);
  paintStatus();
}

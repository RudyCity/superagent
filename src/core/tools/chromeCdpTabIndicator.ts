/**
 * Cosmetic tab-strip marker and floating status widget for an agent-claimed managed CDP tab.
 * Displays title prefix and in-page status pill ("SuperAgent Working...").
 * Browser focus, page controls and favicon stay unchanged.
 * Self-expires at the real owner-lease deadline if the Core exits unexpectedly.
 */
/* Hallmark · component: tab marker & floating status pill · utilitarian · P5 H5 E5 S5 R5 V4 */
export const CDP_TAB_PREFIX = "🔴 CDP · ";
export const CDP_PILL_HOST_ID = "__superagent_cdp_floating_pill_host__";
const SLOT = "__superagent_cdp_tab_indicator_v1__";
type CdpSend = (target: any, method: string, params?: any) => Promise<any>;
type CdpTab = { id: string; webSocketDebuggerUrl?: string };
const registrations = new Map<string, string>();
const key = (target: CdpTab) => target.webSocketDebuggerUrl || target.id;

export function buildCdpTabIndicatorJs(mode: "show" | "hide", expiry = 0): string {
  const source = [
    "(() => {",
    "if (window !== window.top) return false;",
    "const slot = __SLOT__;",
    "const prefix = __PREFIX__;",
    "const pillHostId = __PILL_HOST_ID__;",
    "const previous = window[slot];",
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
    "if (__MODE__ === 'hide') {",
    " if (previous && typeof previous.stop === 'function') previous.stop();",
    " else {",
    "  if (document.title.startsWith(prefix)) document.title = document.title.slice(prefix.length);",
    "  removePill();",
    " }",
    " return true;",
    "}",
    "const expiresAt = __EXPIRY__;",
    "if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) return false;",
    "if (previous && typeof previous.stop === 'function') previous.stop();",
    "let stopped = false; let timer = null; let scheduled = false;",
    "const observer = new MutationObserver(() => {",
    " if (!scheduled && !stopped) {",
    "  scheduled = true;",
    "  queueMicrotask(() => { scheduled = false; apply(); });",
    " }",
    "});",
    "const stop = () => {",
    " if (stopped) return;",
    " stopped = true; observer.disconnect();",
    " if (timer !== null) clearTimeout(timer);",
    " document.removeEventListener('DOMContentLoaded', bootstrap);",
    " if (document.title.startsWith(prefix)) document.title = document.title.slice(prefix.length);",
    " removePill();",
    " if (window[slot] === state) delete window[slot];",
    "};",
    "const state = { stop, expiresAt };",
    "const apply = () => {",
    " if (stopped) return;",
    " if (Date.now() >= expiresAt) return stop();",
    " const title = document.title || '';",
    " if (!title.startsWith(prefix)) document.title = prefix + title;",
    " mountPill();",
    "};",
    "const bootstrap = () => {",
    " if (stopped) return;",
    " if (document.head) observer.observe(document.head, { childList: true, subtree: true, characterData: true });",
    " apply();",
    "};",
    "window[slot] = state;",
    "if (document.head || document.body) bootstrap();",
    "else document.addEventListener('DOMContentLoaded', bootstrap, { once: true });",
    "timer = setTimeout(stop, Math.min(2147483647, Math.max(1, expiresAt - Date.now())));",
    "return true;",
    "})()",
  ].join("\n");
  return source
    .replace("__SLOT__", JSON.stringify(SLOT))
    .replace("__PREFIX__", JSON.stringify(CDP_TAB_PREFIX))
    .replace("__PILL_HOST_ID__", JSON.stringify(CDP_PILL_HOST_ID))
    .replace("__MODE__", JSON.stringify(mode))
    .replace("__EXPIRY__", String(Math.floor(expiry)));
}

export async function showManagedCdpTabIndicator(send: CdpSend, target: CdpTab, expiresAt: number): Promise<boolean> {
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) return false;
  const targetKey = key(target);
  const old = registrations.get(targetKey);
  if (old) {
    try {
      await send(target, "Page.removeScriptToEvaluateOnNewDocument", { identifier: old });
      registrations.delete(targetKey);
    } catch { return false; } // Never multiply scripts after failed cleanup.
  }
  const expression = buildCdpTabIndicatorJs("show", expiresAt);
  try {
    const entry = await send(target, "Page.addScriptToEvaluateOnNewDocument", { source: expression });
    if (typeof entry?.identifier !== "string" || !entry.identifier) return false;
    registrations.set(targetKey, entry.identifier);
    await send(target, "Runtime.evaluate", { expression, returnByValue: true });
    return true;
  } catch { return false; } // Visual only: don't invalidate an authorized lease.
}

export async function hideManagedCdpTabIndicator(send: CdpSend, target: CdpTab): Promise<void> {
  const targetKey = key(target);
  const id = registrations.get(targetKey);
  if (id) {
    await send(target, "Page.removeScriptToEvaluateOnNewDocument", { identifier: id });
    registrations.delete(targetKey);
  }
  await send(target, "Runtime.evaluate", {
    expression: buildCdpTabIndicatorJs("hide"), returnByValue: true,
  });
}

export function forgetManagedCdpTabIndicators(): void {
  registrations.clear();
}

export function forgetManagedCdpTabIndicatorRegistration(webSocketDebuggerUrl: string): void {
  // A Page.addScript identifier is scoped to one live debugger connection.
  registrations.delete(webSocketDebuggerUrl);
}

/**
 * Cosmetic tab-strip marker for an agent-claimed managed CDP tab.
 * Changes only document.title; browser focus, page controls and favicon stay unchanged.
 * Self-expires at the real owner-lease deadline if the Core exits unexpectedly.
 */
/* Hallmark · component: tab marker · utilitarian · P5 H5 E5 S5 R5 V4 */
export const CDP_TAB_PREFIX = "🔴 CDP · ";
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
    "const previous = window[slot];",
    "if (__MODE__ === 'hide') {",
    " if (previous && typeof previous.stop === 'function') previous.stop();",
    " else if (document.title.startsWith(prefix)) document.title = document.title.slice(prefix.length);",
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
    " if (window[slot] === state) delete window[slot];",
    "};",
    "const state = { stop, expiresAt };",
    "const apply = () => {",
    " if (stopped) return;",
    " if (Date.now() >= expiresAt) return stop();",
    " const title = document.title || '';",
    " if (!title.startsWith(prefix)) document.title = prefix + title;",
    "};",
    "const bootstrap = () => {",
    " if (stopped || !document.head) return;",
    " observer.observe(document.head, { childList: true, subtree: true, characterData: true });",
    " apply();",
    "};",
    "window[slot] = state;",
    "if (document.head) bootstrap();",
    "else document.addEventListener('DOMContentLoaded', bootstrap, { once: true });",
    "timer = setTimeout(stop, Math.min(2147483647, Math.max(1, expiresAt - Date.now())));",
    "return true;",
    "})()",
  ].join("\n");
  return source
    .replace("__SLOT__", JSON.stringify(SLOT))
    .replace("__PREFIX__", JSON.stringify(CDP_TAB_PREFIX))
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

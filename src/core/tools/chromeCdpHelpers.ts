/**
 * DOM extraction, in-page JavaScript snippets, and snapshot formatting helpers
 * for Chrome Remote Debugging (CDP) automation.
 */

export interface CdpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
}

export interface SnapshotEntry {
  index: number;
  tag: string;
  text: string;
  type?: string;
  placeholder?: string;
  ariaLabel?: string;
  id?: string;
  name?: string;
  selector: string;
}

export interface PageOverview {
  title?: string;
  url?: string;
  headings?: Array<{ tag: string; text: string }>;
  alerts?: string[];
  viewMode?: string;
  elements?: SnapshotEntry[];
}

/**
 * Stores the last DOM snapshot per target ID.
 * Used by click and type to resolve elements by numerical index.
 */
export const snapshotStore = new Map<string, SnapshotEntry[]>();

/**
 * Stores the previous DOM snapshot per target ID for diff calculations.
 */
export const snapshotPrevStore = new Map<string, SnapshotEntry[]>();

/**
 * In-page JavaScript snippet that traverses the DOM and extracts interactive elements.
 * Also extracts page title, URL, top headings (h1, h2), and alerts/status messages so
 * the agent is never blind to page context, 404 errors, or verification requirements.
 */
export const SNAPSHOT_JS = `/*cdp-snapshot-walk*/(() => {
  function collectInteractive(root, list) {
    if (!root) return;
    try {
      const found = root.querySelectorAll(
        'button, a, input, select, textarea, [role="button"], [role="link"], [role="textbox"], [role="checkbox"], [role="radio"], [role="switch"], [role="tab"], [onclick], summary'
      );
      for (let i = 0; i < found.length; i++) list.push(found[i]);
    } catch (e) {}
    try {
      const all = root.querySelectorAll('*');
      for (let i = 0; i < all.length; i++) {
        if (all[i].shadowRoot) {
          collectInteractive(all[i].shadowRoot, list);
        }
      }
    } catch (e) {}
  }
  const els = [];
  collectInteractive(document, els);
  function visible(el) {
    const r = el.getBoundingClientRect();
    if (!r || r.width === 0 || r.height === 0) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    const role = el.getAttribute('role');
    if (role === 'presentation' || role === 'none') return false;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a' && !el.getAttribute('href') && !el.getAttribute('onclick') && !role) return false;
    return true;
  }
  function genSelector(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement && parts.length < 5) {
      let seg = cur.tagName.toLowerCase();
      const parent = cur.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === cur.tagName);
        if (same.length > 1) seg += ':nth-of-type(' + (same.indexOf(cur) + 1) + ')';
      }
      parts.unshift(seg);
      cur = parent;
    }
    return parts.join(' > ');
  }
  function label(el) {
    const t = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || '').replace(/\\s+/g, ' ').trim();
    return t.slice(0, 140);
  }
  const elements = els.filter(visible).slice(0, 120).map((el, i) => ({
    index: i,
    tag: el.tagName.toLowerCase(),
    text: label(el),
    type: el.getAttribute('type') || undefined,
    placeholder: el.getAttribute('placeholder') || undefined,
    ariaLabel: el.getAttribute('aria-label') || undefined,
    id: el.id || undefined,
    name: el.getAttribute('name') || undefined,
    selector: genSelector(el),
  }));

  const headings = Array.from(document.querySelectorAll('h1, h2, [role="heading"]'))
    .map(h => ({ tag: h.tagName.toLowerCase(), text: (h.innerText || '').replace(/\\s+/g, ' ').trim() }))
    .filter(h => h.text.length > 0 && h.text.length < 150)
    .slice(0, 6);

  const alerts = Array.from(document.querySelectorAll('[role="alert"], [role="status"], [role="alertdialog"], [aria-live="assertive"], [aria-live="polite"], [data-sonner-toast], [data-radix-toast-viewport] > *, .toast, .alert, .error, .notification, .banner, [class*="toast" i], [class*="snackbar" i]'))
    .map(a => (a.innerText || '').replace(/\\s+/g, ' ').trim())
    .filter(t => t.length > 0 && t.length < 200)
    .slice(0, 5);

  const hasModal = Boolean(document.querySelector('[role="dialog"], dialog[open], [class*="modal" i]:not(body), div.fixed.inset-0:not(#__next):not(#root)'));
  const hasDrawer = Boolean(document.querySelector('[role="region"][class*="drawer" i], [class*="slide-over" i], aside.fixed'));
  const formInputs = els.filter(e => visible(e) && (e.tagName === 'INPUT' || e.tagName === 'TEXTAREA' || e.tagName === 'SELECT') && e.type !== 'hidden' && e.type !== 'search');
  const hasForm = (formInputs.length >= 2 && !hasModal) || Boolean(document.querySelector('form, [data-form], #form'));
  const hasTable = Boolean(document.querySelector('table, [role="table"], [role="grid"], tbody tr'));

  let viewMode = 'general_view';
  if (hasModal) viewMode = 'modal_view';
  else if (hasDrawer) viewMode = 'drawer_view';
  else if (hasForm && (!hasTable || formInputs.length >= 3)) viewMode = 'form_view';
  else if (hasTable) viewMode = 'table_list_view';

  return {
    title: document.title,
    url: window.location.href,
    headings,
    alerts,
    viewMode,
    elements
  };
})()`;

/**
 * In-page JavaScript snippet that reads the full visible page text, headings,
 * status alerts, and hyperlinks. Eliminates blindness to non-interactive content
 * such as incoming email bodies, verification tokens, or error descriptions.
 */
export const READ_PAGE_JS = `/*cdp-read-page*/(() => {
  const url = window.location.href;
  const title = document.title;
  
  const headings = Array.from(document.querySelectorAll('h1, h2, h3, [role="heading"]'))
    .map(h => ({ tag: h.tagName.toLowerCase(), text: (h.innerText || '').replace(/\\s+/g, ' ').trim() }))
    .filter(h => h.text.length > 0)
    .slice(0, 10);

  const alerts = Array.from(document.querySelectorAll('[role="alert"], [role="status"], [role="alertdialog"], [aria-live="assertive"], [aria-live="polite"], [data-sonner-toast], [data-radix-toast-viewport] > *, .toast, .alert, .error, .notification, .banner, [class*="toast" i], [class*="snackbar" i]'))
    .map(a => (a.innerText || '').replace(/\\s+/g, ' ').trim())
    .filter(t => t.length > 0)
    .slice(0, 5);

  let bodyText = "";
  if (document.body) {
    const clone = document.body.cloneNode(true);
    const unneeded = clone.querySelectorAll('script, style, noscript, svg, iframe');
    unneeded.forEach(el => el.remove());
    bodyText = (clone.innerText || "").replace(/\\r\\n/g, "\\n").replace(/\\n{3,}/g, "\\n\\n").trim();
  }

  const links = Array.from(document.querySelectorAll('a[href]'))
    .map(a => {
      const text = (a.innerText || a.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim();
      const href = a.href || '';
      return { text: text.slice(0, 100), href };
    })
    .filter(l => l.href && !l.href.startsWith('javascript:') && !l.href.startsWith('#'))
    .slice(0, 30);

  const hasModal = Boolean(document.querySelector('[role="dialog"], dialog[open], [class*="modal" i]:not(body), div.fixed.inset-0:not(#__next):not(#root)'));
  const hasDrawer = Boolean(document.querySelector('[role="region"][class*="drawer" i], [class*="slide-over" i], aside.fixed'));
  const editableInputs = Array.from(document.querySelectorAll('input:not([type="hidden"]):not([type="search"]), select, textarea'));
  const hasForm = (editableInputs.length >= 2 && !hasModal) || Boolean(document.querySelector('form, [data-form], #form'));
  const hasTable = Boolean(document.querySelector('table, [role="table"], [role="grid"], tbody tr'));

  let viewMode = 'general_view';
  if (hasModal) viewMode = 'modal_view';
  else if (hasDrawer) viewMode = 'drawer_view';
  else if (hasForm && (!hasTable || editableInputs.length >= 3)) viewMode = 'form_view';
  else if (hasTable) viewMode = 'table_list_view';

  return {
    url,
    title,
    headings,
    alerts,
    viewMode,
    bodyText: bodyText.slice(0, 7000),
    links
  };
})()`;

/**
 * Builds page JS that extracts hyperlinks from the page, optionally matching a pattern.
 */
export function buildExtractLinksJs(pattern?: string): string {
  return `/*cdp-extract-links*/(() => {
    const filter = ${JSON.stringify(pattern || "")}.toLowerCase();
    const links = Array.from(document.querySelectorAll('a[href]'))
      .map(a => {
        const text = (a.innerText || a.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim();
        const href = a.href || '';
        return { text: text.slice(0, 120), href };
      })
      .filter(l => l.href && !l.href.startsWith('javascript:') && !l.href.startsWith('#'))
      .filter(l => !filter || l.text.toLowerCase().includes(filter) || l.href.toLowerCase().includes(filter));
    return links.slice(0, 50);
  })()`;
}

/**
 * Builds page JS that clicks the element matching selector.
 */
export function buildClickJs(selector: string): string {
  return `/*cdp-click*/(() => {
    function findEl(sel) {
      try { const el = document.querySelector(sel); if (el) return el; } catch (e) {}
      function walk(root) {
        const all = root.querySelectorAll('*');
        for (let i = 0; i < all.length; i++) {
          if (all[i].shadowRoot) {
            try {
              const found = all[i].shadowRoot.querySelector(sel) || walk(all[i].shadowRoot);
              if (found) return found;
            } catch (e) {}
          }
        }
        return null;
      }
      return walk(document);
    }
    const el = findEl(${JSON.stringify(selector)});
    if (!el) return JSON.stringify({ ok: false, reason: "no element matches selector" });
    try { el.scrollIntoView({ block: "center" }); } catch (e) {}
    el.click();
    const t = (el.innerText || el.value || "").replace(/\\s+/g, " ").trim().slice(0, 120);
    return JSON.stringify({ ok: true, tag: el.tagName.toLowerCase(), text: t });
  })()`;
}

/**
 * Builds page JS that types text into the element matching selector.
 * Pierces open Shadow DOM roots, updates React _valueTracker, and
 * dispatches InputEvent, input, change, and blur events for reactive frameworks (React, Vue, Svelte).
 */
export function buildTypeJs(selector: string, text: string, clear: boolean): string {
  return `/*cdp-type*/(() => {
    function findEl(sel) {
      try { const el = document.querySelector(sel); if (el) return el; } catch (e) {}
      function walk(root) {
        const all = root.querySelectorAll('*');
        for (let i = 0; i < all.length; i++) {
          if (all[i].shadowRoot) {
            try {
              const found = all[i].shadowRoot.querySelector(sel) || walk(all[i].shadowRoot);
              if (found) return found;
            } catch (e) {}
          }
        }
        return null;
      }
      return walk(document);
    }
    const el = findEl(${JSON.stringify(selector)});
    if (!el) return JSON.stringify({ ok: false, reason: "no element matches selector" });
    try { el.scrollIntoView({ block: "center" }); } catch (e) {}
    try { el.focus(); } catch (e) {}
    const tag = el.tagName.toLowerCase();
    const text = ${JSON.stringify(text)};
    const doClear = ${clear ? "true" : "false"};
    function fire(val) {
      if (el._valueTracker) {
        try { el._valueTracker.setValue(val !== undefined ? String(val) : ""); } catch (e) {}
      }
      try {
        el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: text }));
      } catch (e) {
        el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      }
      el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    }
    if (tag === "input" || tag === "textarea") {
      const proto = tag === "input" ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, "value");
      const setter = desc && desc.set;
      if (doClear) {
        if (setter) setter.call(el, ""); else el.value = "";
        fire("");
      }
      const finalVal = doClear ? text : ((el.value || "") + text);
      if (setter) setter.call(el, finalVal); else el.value = finalVal;
      fire(finalVal);
      try {
        el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, composed: true, key: text.slice(-1) || "a" }));
        el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, composed: true, key: text.slice(-1) || "a" }));
      } catch (e) {}
      try {
        el.dispatchEvent(new FocusEvent("blur", { bubbles: true, composed: true }));
      } catch (e) {
        el.dispatchEvent(new Event("blur", { bubbles: true, composed: true }));
      }
    } else if (el.isContentEditable) {
      const sel = window.getSelection();
      if (doClear) el.textContent = "";
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      if (sel) { sel.removeAllRanges(); sel.addRange(range); }
      let inserted = false;
      try { inserted = document.execCommand("insertText", false, text); } catch (e) {}
      if (!inserted) el.textContent = doClear ? text : el.textContent + text;
      fire(el.textContent);
      try {
        el.dispatchEvent(new FocusEvent("blur", { bubbles: true, composed: true }));
      } catch (e) {
        el.dispatchEvent(new Event("blur", { bubbles: true, composed: true }));
      }
    } else {
      return JSON.stringify({ ok: false, reason: "element is not editable (not input/textarea/contenteditable)" });
    }
    return JSON.stringify({ ok: true, tag: tag, typed: text.slice(0, 120) });
  })()`;
}

/**
 * Builds page JS that polls inside the page (~200ms) for a CSS selector or text to appear.
 */
export function buildWaitForJs(opts: { selector?: string; text?: string; timeoutMs: number }): string {
  const optsJson = JSON.stringify(opts);
  return `/*cdp-wait-for*/(() => {
    const o = ${optsJson};
    return new Promise((resolve) => {
      const timeoutMs = o.timeoutMs;
      const deadline = Date.now() + timeoutMs;
      function visible(el) {
        if (!el || el.nodeType !== 1) return false;
        const r = el.getBoundingClientRect();
        if (!r || r.width === 0 || r.height === 0) return false;
        try {
          const cs = getComputedStyle(el);
          if (cs.visibility === "hidden" || cs.display === "none") return false;
        } catch (e) {}
        return true;
      }
      function finishOk(kind, el) {
        const t = el ? ((el.innerText || el.value || "").replace(/\\s+/g, " ").trim()).slice(0, 120) : "";
        resolve(JSON.stringify({
          ok: true, kind: kind,
          selector: o.selector || undefined, text: o.text || undefined,
          tag: el ? el.tagName.toLowerCase() : undefined, foundText: t || undefined
        }));
      }
      function finishTimeout() {
        const waiting = o.selector ? ("selector '" + o.selector + "'") : ("text '" + o.text + "'");
        resolve(JSON.stringify({ ok: false, reason: "timeout after " + timeoutMs + "ms waiting for " + waiting }));
      }
      function check() {
        if (o.selector) {
          let el = null;
          try {
            el = document.querySelector(o.selector);
            if (!el) {
              const all = document.querySelectorAll('*');
              for (let i = 0; i < all.length; i++) {
                if (all[i].shadowRoot) {
                  try {
                    el = all[i].shadowRoot.querySelector(o.selector);
                    if (el) break;
                  } catch (e) {}
                }
              }
            }
          } catch (e) {}
          if (el && visible(el)) { finishOk("selector", el); return true; }
        }
        if (o.text) {
          try {
            const bodyText = (document.body && document.body.innerText) || "";
            if (bodyText.indexOf(o.text) !== -1) { finishOk("text", null); return true; }
          } catch (e) {}
        }
        return false;
      }
      if (check()) return;
      const iv = setInterval(() => {
        if (check()) { clearInterval(iv); return; }
        if (Date.now() >= deadline) { clearInterval(iv); finishTimeout(); }
      }, 200);
    });
  })()`;
}

/**
 * JavaScript snippet to check document.readyState.
 */
export const READY_STATE_JS = `/*cdp-ready-state*/(() => document.readyState)()`;

/**
 * Parses action results from click/type in-page evaluations.
 */
export function parseActionResult(raw: string): {
  ok: boolean;
  tag?: string;
  text?: string;
  typed?: string;
  reason?: string;
} {
  try {
    const o = JSON.parse(raw);
    if (o && typeof o === "object") return o;
  } catch {
    /* fall through */
  }
  return { ok: false, reason: `unexpected result: ${raw.slice(0, 200)}` };
}

/**
 * Parses an optional timeout_ms payload field; falls back to default when invalid.
 */
export function parseTimeoutMs(v: unknown, def: number): number {
  if (v === undefined || v === null || v === "") return def;
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 0 ? n : def;
}

/**
 * Formats a single snapshot entry for agent readability.
 */
export function formatSnapshotEntry(e: SnapshotEntry, compact: boolean): string {
  const labelText = e.text || e.placeholder || e.ariaLabel || "";
  const textStr = labelText ? ` "${labelText}"` : "";
  if (compact) {
    let extra = "";
    if (e.tag === "input" || e.tag === "textarea" || e.tag === "select" || e.tag === "button") {
      const parts: string[] = [];
      if (e.type && e.type !== "text") parts.push(`type="${e.type}"`);
      if (e.id) parts.push(`id="${e.id}"`);
      else if (e.name) parts.push(`name="${e.name}"`);
      if (parts.length > 0) extra = ` [${parts.join(" ")}]`;
    }
    return `[${e.index}] <${e.tag}>${extra}${textStr}`;
  }
  const attrs: string[] = [];
  if (e.type) attrs.push(`type="${e.type}"`);
  if (e.placeholder) attrs.push(`placeholder="${e.placeholder}"`);
  if (e.ariaLabel) attrs.push(`aria-label="${e.ariaLabel}"`);
  if (e.id) attrs.push(`id="${e.id}"`);
  if (e.name) attrs.push(`name="${e.name}"`);
  const attrStr = attrs.length > 0 ? " " + attrs.join(" ") : "";
  return `[${e.index}] <${e.tag}${attrStr}>${textStr}`;
}

/**
 * Formats snapshot diff compared to previous snapshot.
 */
export function formatSnapshotDiff(
  title: string,
  entries: SnapshotEntry[],
  prev: SnapshotEntry[],
  compact: boolean
): string {
  if (prev.length === 0) {
    return (
      `control_chrome_cdp: snapshot diff of ${title} - no previous snapshot, showing full list ` +
      `(${entries.length} interactive element(s)).\n` +
      `Use click/type with {"index": N}.\n${entries.map((e) => formatSnapshotEntry(e, compact)).join("\n")}`
    );
  }
  const prevBySel = new Map(prev.map((e) => [e.selector, e] as [string, SnapshotEntry]));
  const curBySel = new Map(entries.map((e) => [e.selector, e] as [string, SnapshotEntry]));
  const added = entries.filter((e) => !prevBySel.has(e.selector));
  const removed = prev.filter((e) => !curBySel.has(e.selector));
  const changed = entries.filter((e) => {
    const p = prevBySel.get(e.selector);
    return !!p && (p.text !== e.text || p.tag !== e.tag);
  });
  const dlines: string[] = [];
  for (const e of added) dlines.push(`+ ${formatSnapshotEntry(e, compact)}`);
  for (const e of removed) dlines.push(`- ${formatSnapshotEntry(e, compact)}`);
  for (const e of changed) {
    const p = prevBySel.get(e.selector)!;
    dlines.push(`~ ${formatSnapshotEntry(e, compact)} (was "${p.text}")`);
  }
  return (
    `control_chrome_cdp: snapshot diff of ${title} - ` +
    `+${added.length} added, -${removed.length} removed, ~${changed.length} changed.\n` +
    (dlines.length > 0 ? dlines.join("\n") : "(no changes)")
  );
}

/**
 * Formats context header (view mode, headings, alerts) for snapshot / navigate output.
 */
export function formatContextHeader(overview: PageOverview | null): string {
  if (!overview) return "";
  const parts: string[] = [];
  if (overview.viewMode) parts.push(`View Mode: [${String(overview.viewMode).toUpperCase()}]`);
  const hList = overview.headings?.map((h) => `[${h.tag.toUpperCase()}] ${h.text}`).join(" | ");
  if (hList) parts.push(`Headings: ${hList}`);
  const aList = overview.alerts?.map((a) => `[ALERT] ${a}`).join(" | ");
  if (aList) parts.push(`Alerts/Status: ${aList}`);
  return parts.length > 0 ? "\n" + parts.join("\n") : "";
}

/**
 * Resolves a click or type target from payload (either numerical index or selector).
 */
export function resolveActionSelector(
  payload: Record<string, unknown>,
  targetId: string
): { selector: string } | { error: string } {
  if (typeof payload.index === "number" && Number.isInteger(payload.index)) {
    const entries = snapshotStore.get(targetId);
    if (entries === undefined) {
      return {
        error:
          'control_chrome_cdp failed: no snapshot for this tab yet. Run command \'snapshot\' first, then click/type with {"index": N}.',
      };
    }
    if (entries.length === 0) {
      return {
        error:
          "control_chrome_cdp failed: the snapshot for this tab is empty — 'snapshot' found no interactive elements on this page.",
      };
    }
    const idx: number = payload.index;
    const entry = entries[idx];
    if (!entry) {
      return {
        error:
          `control_chrome_cdp failed: index ${idx} out of range — snapshot has ${entries.length} element(s) ` +
          `(indices 0..${entries.length - 1}). Run 'snapshot' again to refresh.`,
      };
    }
    return { selector: entry.selector };
  }
  const selector = String(payload.selector || "");
  if (!selector) {
    return {
      error:
        'control_chrome_cdp failed: provide either {"index": N} (from \'snapshot\') or {"selector": "<css>"}.',
    };
  }
  return { selector };
}

/**
 * Polls in-page for selector or text appearance via evaluate.
 */
export async function waitForInPage(
  cdpSend: (target: CdpTarget, method: string, params?: Record<string, unknown>) => Promise<any>,
  target: CdpTarget,
  opts: { selector?: string; text?: string; timeoutMs: number }
): Promise<{
  ok: boolean;
  kind?: string;
  selector?: string;
  text?: string;
  tag?: string;
  foundText?: string;
  reason?: string;
}> {
  const res: any = await cdpSend(target, "Runtime.evaluate", {
    expression: buildWaitForJs(opts),
    awaitPromise: true,
    returnByValue: true,
  });
  const value = res && res.result ? res.result.value : undefined;
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  try {
    const o = JSON.parse(raw);
    if (o && typeof o === "object") return o;
  } catch {
    /* fall through */
  }
  return { ok: false, reason: `unexpected wait_for result: ${raw.slice(0, 200)}` };
}

export interface CdpDialogEntry {
  type: string;
  message: string;
  url?: string;
  defaultPrompt?: string;
  timestamp: number;
  accepted: boolean;
  promptText?: string;
}

export interface CdpDialogPolicy {
  autoAccept: boolean;
  promptText?: string;
}

const MAX_DIALOG_HISTORY = 25;
export const dialogStore = new Map<string, CdpDialogEntry[]>();
export const dialogPolicyStore = new Map<string, CdpDialogPolicy>();
const defaultDialogPolicy: CdpDialogPolicy = { autoAccept: true };

export function setDialogPolicy(targetId: string, policy: CdpDialogPolicy): void {
  dialogPolicyStore.set(targetId || "*", {
    autoAccept: policy.autoAccept !== undefined ? Boolean(policy.autoAccept) : true,
    ...(policy.promptText !== undefined ? { promptText: String(policy.promptText) } : {}),
  });
}

export function getDialogPolicy(targetId: string): CdpDialogPolicy {
  return dialogPolicyStore.get(targetId) ?? dialogPolicyStore.get("*") ?? defaultDialogPolicy;
}

export function recordCdpDialog(targetId: string, entry: CdpDialogEntry): void {
  const list = dialogStore.get(targetId) ?? [];
  list.push(entry);
  if (list.length > MAX_DIALOG_HISTORY) {
    list.splice(0, list.length - MAX_DIALOG_HISTORY);
  }
  dialogStore.set(targetId, list);
}

export function getRecentDialogs(targetId: string, sinceTimestamp = 0): CdpDialogEntry[] {
  const list = dialogStore.get(targetId) ?? [];
  if (sinceTimestamp <= 0) return [...list];
  return list.filter((d) => d.timestamp >= sinceTimestamp);
}

export function clearCdpDialogs(targetId?: string): void {
  if (targetId) {
    dialogStore.delete(targetId);
    dialogPolicyStore.delete(targetId);
  } else {
    dialogStore.clear();
    dialogPolicyStore.clear();
  }
}

export function formatDialogEntry(d: CdpDialogEntry): string {
  const kind = String(d.type || "alert").toUpperCase();
  const status = d.accepted ? "accepted" : "dismissed";
  const promptSuffix = d.promptText !== undefined ? `, promptText="${d.promptText}"` : "";
  return `[NATIVE ${kind}] "${d.message}" (${status}${promptSuffix})`;
}

/**
 * Handles server-initiated CDP events on an active target WebSocket connection.
 * Specifically intercepts Page.javascriptDialogOpening (window.alert, confirm, prompt, beforeunload),
 * records the dialog metadata, and immediately dispatches Page.handleJavaScriptDialog
 * according to the active target policy so synchronous JS execution never deadlocks.
 */
export function handleIncomingCdpEvent(
  targetId: string,
  method: string,
  params: Record<string, unknown> | undefined,
  sendRaw: (method: string, params: Record<string, unknown>) => void
): void {
  if (method !== "Page.javascriptDialogOpening") return;
  const type = String(params?.type || "alert");
  const message = String(params?.message ?? "");
  const url = params?.url ? String(params.url) : undefined;
  const defaultPrompt =
    params?.defaultPrompt !== undefined && params?.defaultPrompt !== ""
      ? String(params.defaultPrompt)
      : undefined;

  const policy = getDialogPolicy(targetId);
  const promptText = policy.promptText !== undefined ? policy.promptText : defaultPrompt;

  const entry: CdpDialogEntry = {
    type,
    message,
    url,
    defaultPrompt,
    timestamp: Date.now(),
    accepted: policy.autoAccept,
    ...(promptText !== undefined ? { promptText } : {}),
  };
  recordCdpDialog(targetId, entry);

  const handleParams: Record<string, unknown> = { accept: policy.autoAccept };
  if (promptText !== undefined) {
    handleParams.promptText = promptText;
  }
  sendRaw("Page.handleJavaScriptDialog", handleParams);
}

export function executeGetDialogsCommand(target: CdpTarget, payload: Record<string, unknown>): string {
  const dialogs = getRecentDialogs(target.id);
  const shouldClear = Boolean(payload.clear);
  if (shouldClear) {
    dialogStore.delete(target.id);
  }
  if (dialogs.length === 0) {
    return `control_chrome_cdp: 0 native JavaScript dialogs recorded on '${target.title}'.`;
  }
  const lines = dialogs.map((d, idx) => `${idx + 1}. ${formatDialogEntry(d)}`);
  return `control_chrome_cdp: ${dialogs.length} native JavaScript dialog(s) captured on '${target.title}':\n${lines.join("\n")}`;
}

export async function executeHandleDialogCommand(
  cdpSend: (target: CdpTarget, method: string, params?: Record<string, unknown>) => Promise<any>,
  target: CdpTarget,
  payload: Record<string, unknown>
): Promise<string> {
  const accept = payload.accept !== undefined ? Boolean(payload.accept) : true;
  const promptText =
    payload.promptText !== undefined
      ? String(payload.promptText)
      : payload.prompt_text !== undefined
        ? String(payload.prompt_text)
        : payload.text !== undefined
          ? String(payload.text)
          : undefined;

  setDialogPolicy(target.id, { autoAccept: accept, promptText });
  try {
    await cdpSend(target, "Page.handleJavaScriptDialog", {
      accept,
      ...(promptText !== undefined ? { promptText } : {}),
    });
  } catch {
    /* No active blocking dialog open right now; policy is stored for future dialogs */
  }
  return (
    `control_chrome_cdp: dialog policy updated for '${target.title}' ` +
    `(autoAccept=${accept}${promptText !== undefined ? `, promptText="${promptText}"` : ""}).`
  );
}

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

  const alerts = Array.from(document.querySelectorAll('[role="alert"], [aria-live], .alert, .error, .notification, .banner'))
    .map(a => (a.innerText || '').replace(/\\s+/g, ' ').trim())
    .filter(t => t.length > 0 && t.length < 200)
    .slice(0, 3);

  return {
    title: document.title,
    url: window.location.href,
    headings,
    alerts,
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

  const alerts = Array.from(document.querySelectorAll('[role="alert"], [aria-live], .alert, .error, .notification, .toast, .banner'))
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

  return {
    url,
    title,
    headings,
    alerts,
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


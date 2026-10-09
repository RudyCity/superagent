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
 * Generates compact CSS selectors and identifies form controls with IDs and names.
 */
export const SNAPSHOT_JS = `/*cdp-snapshot-walk*/(() => {
  const els = Array.from(document.querySelectorAll(
    'button, a, input, select, textarea, [role="button"], [role="link"], [role="textbox"], [role="checkbox"], [role="radio"], [role="switch"], [role="tab"], [onclick], summary'
  ));
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
    return t.slice(0, 80);
  }
  return els.filter(visible).slice(0, 120).map((el, i) => ({
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
})()`;

/**
 * Builds page JS that clicks the element matching selector.
 */
export function buildClickJs(selector: string): string {
  return `/*cdp-click*/(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return JSON.stringify({ ok: false, reason: "no element matches selector" });
    try { el.scrollIntoView({ block: "center" }); } catch (e) {}
    el.click();
    const t = (el.innerText || el.value || "").replace(/\\s+/g, " ").trim().slice(0, 80);
    return JSON.stringify({ ok: true, tag: el.tagName.toLowerCase(), text: t });
  })()`;
}

/**
 * Builds page JS that types text into the element matching selector.
 * Dispatches input/change events for reactive frameworks (React, Vue, Svelte).
 */
export function buildTypeJs(selector: string, text: string, clear: boolean): string {
  return `/*cdp-type*/(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return JSON.stringify({ ok: false, reason: "no element matches selector" });
    try { el.scrollIntoView({ block: "center" }); } catch (e) {}
    el.focus();
    const tag = el.tagName.toLowerCase();
    const text = ${JSON.stringify(text)};
    const doClear = ${clear ? "true" : "false"};
    function fire() {
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
    if (tag === "input" || tag === "textarea") {
      const proto = tag === "input" ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, "value");
      const setter = desc && desc.set;
      if (doClear) { if (setter) setter.call(el, ""); else el.value = ""; fire(); }
      if (setter) setter.call(el, text); else el.value = text;
      fire();
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
      fire();
    } else {
      return JSON.stringify({ ok: false, reason: "element is not editable (not input/textarea/contenteditable)" });
    }
    return JSON.stringify({ ok: true, tag: tag, typed: text.slice(0, 80) });
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
        const t = el ? ((el.innerText || el.value || "").replace(/\\s+/g, " ").trim()).slice(0, 80) : "";
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
          try { el = document.querySelector(o.selector); } catch (e) {}
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

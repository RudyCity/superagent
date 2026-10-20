/**
 * CDP terminal text extraction. This is read-only: no keys, writes, or network hooks.
 * Canvas pixels are NOT DOM text; report an unavailable source when no buffer or
 * accessibility rows are exposed rather than inventing a terminal transcript.
 */

export interface TerminalReadOptions {
  selector?: string;
  index?: number;
  terminal_id?: string;
  max_lines?: number;
  max_chars?: number;
  viewport_only?: boolean;
}

export interface TerminalResult {
  terminals: Array<{
    index: number;
    terminalId?: string;
    kind: string;
    selector: string;
    source: string;
    lines: string[];
    totalLines: number | null;
    warning?: string;
  }>;
  detected: number;
  warning?: string;
}

function bound(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  return value === undefined || value === null || value === "" || !Number.isFinite(n)
    ? fallback : Math.max(min, Math.min(max, Math.floor(n)));
}

// Evaluated inside the *page* by CDP; cannot reference imported modules/closures.
function browserReadTerminal(opts: {
  selector: string; index: number | null; terminal_id: string; max_lines: number; max_chars: number; viewport_only: boolean;
}): TerminalResult {
  const roots: Element[] = [];
  const rootSelector = ".xterm, .hterm, [data-terminal], .terminal, .terminal-output, [role='log']";
  const MAX_TERMINALS = 32;
  function visit(node: Document | ShadowRoot, depth: number): void {
    if (depth > 5) return;
    try {
      for (const el of node.querySelectorAll(rootSelector)) {
        if (roots.length >= MAX_TERMINALS) break;
        if (!roots.some((parent) => parent.contains(el))) roots.push(el);
      }
      let scanned = 0;
      for (const el of node.querySelectorAll("*")) {
        if (++scanned > 5000) break;
        if (el.shadowRoot) visit(el.shadowRoot, depth + 1);
      }
      for (const frame of Array.from(node.querySelectorAll("iframe"))) {
        try { if (frame.contentDocument) visit(frame.contentDocument, depth + 1); } catch { /* cross origin */ }
      }
    } catch { /* detached nodes */ }
  }
  visit(document, 0);

  type Term = { element?: Element; rows?: number; buffer?: { active?: {
    length: number; baseY?: number; getLine: (i: number) => { translateToString: (trim: boolean) => string } | undefined
  }} };
  const instances: Term[] = [];
  const isTerm = (v: any): v is Term => {
    try { return v && v.buffer && v.buffer.active && typeof v.buffer.active.getLine === "function"; }
    catch { return false; }
  };
  // Explicitly exposed terminal instances only: do not walk arbitrary page app state.
  for (const key of ["term", "terminal", "xterm", "__xterm", "__terminal", "terminals"]) {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(window, key);
      const value = descriptor && "value" in descriptor ? descriptor.value : null;
      const candidates = Array.isArray(value) ? value.slice(0, 20) : [value];
      for (const v of candidates) if (isTerm(v) && !instances.includes(v)) instances.push(v);
    } catch { /* optional global */ }
  }

  // Some pages expose an instance without a corresponding xterm DOM root.
  const entries: Array<{ root?: Element; instance?: Term }> =
    roots.length ? roots.map((root) => ({ root })) : instances.map((instance) => ({ instance, root: instance.element }));
  const results: TerminalResult["terminals"] = [];
  for (const entry of entries) {
    const root = entry.root;
    if (opts.selector) {
      try {
        if (!root || !(
          root.matches(opts.selector) ||
          root.closest(opts.selector) ||
          root.querySelector(opts.selector)
        )) continue;
      } catch {
        return { terminals: [], detected: entries.length, warning: "Invalid CSS selector." };
      }
    }
    const idx = entries.indexOf(entry); // Keep indices identical between read and input targeting.
    const instance = entry.instance || instances.find((t) => {
      try { return !!(root && t.element && (root === t.element || root.contains(t.element) || t.element.contains(root))); }
      catch { return false; }
    }) || (entries.length === 1 && instances.length === 1 ? instances[0] : undefined);

    let selector = "(exposed instance)";
    if (root) {
      selector = root.id ? "#" + root.id : root.tagName.toLowerCase() +
        (typeof root.className === "string" ? "." + root.className.trim().split(/\s+/).join(".") : "");
    }
    const kind = root && root.classList.contains("xterm") ? "xterm.js"
      : root && root.classList.contains("hterm") ? "hterm" : "web-terminal";

    let source = "unavailable";
    let lines: string[] = [];
    let totalLines: number | null = null;
    if (instance && isTerm(instance)) {
      try {
        const b = instance.buffer!.active!;
        const total = Math.max(0, Math.min(100000, Number(b.length) || 0));
        const baseY = Math.max(0, Number(b.baseY) || 0);
        const rows = Math.max(0, Math.min(10000, Number(instance.rows) || 0));
        const end = opts.viewport_only && rows ? Math.min(total, baseY + rows) : total;
        const start = Math.max(opts.viewport_only ? baseY : 0, end - opts.max_lines);
        for (let i = start; i < end; i++) {
          const line = b.getLine(i);
          lines.push(line ? String(line.translateToString(true)) : "");
        }
        while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
        totalLines = total;
        source = "xterm-buffer";
      } catch { /* try DOM fallback */ }
    }
    if (source === "unavailable" && root) {
      const sources = [
        ["xterm-accessibility", ".xterm-accessibility-tree [role='listitem'], .xterm-accessibility-tree .xterm-accessibility-row"],
        ["xterm-dom", ".xterm-rows > div, .xterm-rows > span"],
        ["hterm-dom", ".hterm-row, .hterm-screen > div"],
        ["terminal-dom", ".terminal-line, .terminal-output > div, .terminal-output pre, [role='log'] > div"]
      ];
      for (const [name, query] of sources) {
        try {
          const rows = Array.from(root.querySelectorAll(query));
          const data = rows.map((el) => el.textContent || el.getAttribute("aria-label") || "");
          if (data.some((line) => line.trim())) {
            lines = data.slice(-opts.max_lines);
            totalLines = rows.length;
            source = name;
            break;
          }
        } catch { /* invalid document */ }
      }
      if (source === "unavailable") {
        try {
          const pre = root.matches("pre, [role='log']") ? root : root.querySelector("pre, [role='log']");
          if (pre && pre.textContent && pre.textContent.trim()) {
            const data = pre.textContent.split(/\r?\n/);
            lines = data.slice(-opts.max_lines);
            totalLines = data.length;
            source = "plaintext-dom";
          }
        } catch { /* no text fallback */ }
      }
    }
    const warning = source === "unavailable"
      ? "Terminal renderer has no readable DOM rows or exposed xterm buffer. Canvas/WebGL pixels cannot be decoded as text by CDP; use screenshot/vision or application-side terminal export."
      : undefined;
    // Document-scoped, opaque ids survive element reordering; reload invalidates ids.
    const idKey = "__superagentCdpTerminalRegistryV1";
    const world = window as any;
    if (!world[idKey] || !(world[idKey].ids instanceof WeakMap)) {
      world[idKey] = { ids: new WeakMap(), prefix: "term-" + Math.random().toString(36).slice(2) + "-", seq: 0 };
    }
    const registry = world[idKey];
    const reference = root || instance;
    let terminalId: string | undefined;
    if (reference) {
      terminalId = registry.ids.get(reference);
      if (!terminalId) { terminalId = registry.prefix + (++registry.seq); registry.ids.set(reference, terminalId); }
    }
    results.push({ index: idx, terminalId, kind, selector, source, lines, totalLines, warning });
  }
  const selected = results.filter((r) =>
    (opts.index === null || r.index === opts.index) &&
    (!opts.terminal_id || r.terminalId === opts.terminal_id));
  let remaining = opts.max_chars;
  for (const item of selected) {
    const kept: string[] = [];
    // Preserve the newest output when the shared character budget is exhausted.
    for (let n = item.lines.length - 1; n >= 0 && remaining > 0; n--) {
      const text = item.lines[n].slice(0, remaining);
      kept.unshift(text);
      remaining -= text.length + 1;
    }
    if (kept.length !== item.lines.length) {
      item.warning = (item.warning ? item.warning + " " : "") + "Output truncated by max_chars.";
    }
    item.lines = kept;
  }
  return {
    terminals: selected,
    detected: entries.length,
    warning: entries.length ? undefined : "No supported terminal element or exposed buffer found in this tab."
  };
}

export function buildReadTerminalJs(options: TerminalReadOptions = {}): string {
  const opts = {
    selector: String(options.selector || "").slice(0, 300),
    index: options.index === undefined ? null : bound(options.index, 0, 0, 1000),
    terminal_id: String(options.terminal_id || "").slice(0, 120),
    max_lines: bound(options.max_lines, 80, 1, 200),
    max_chars: bound(options.max_chars, 12000, 200, 20000),
    viewport_only: options.viewport_only === true
  };
  return "/*cdp-read-terminal*/(" + browserReadTerminal.toString() + ")(" + JSON.stringify(opts) + ")";
}

export function formatTerminalReadResult(data: unknown): string {
  if (!data || typeof data !== "object" || !Array.isArray((data as TerminalResult).terminals)) {
    return "control_chrome_cdp: read_terminal returned no structured output.";
  }
  const result = data as TerminalResult;
  const parts = ["control_chrome_cdp: read_terminal detected " + result.detected + " terminal(s)."];
  if (result.warning) parts.push("Note: " + result.warning);
  for (const terminal of result.terminals) {
    parts.push("Terminal [" + terminal.index + "] " + terminal.kind + (terminal.terminalId ? " id=" + terminal.terminalId : "") + " (" + terminal.selector +
      "), source: " + terminal.source + ", total lines: " + (terminal.totalLines ?? "unknown"));
    parts.push(terminal.source === "unavailable" ? "Unavailable: " + terminal.warning :
      (terminal.lines.length ? "Output:\n" + terminal.lines.join("\n") : "Output: (empty)"));
    if (terminal.warning && terminal.source !== "unavailable") parts.push("Note: " + terminal.warning);
  }
  return parts.join("\n");
}

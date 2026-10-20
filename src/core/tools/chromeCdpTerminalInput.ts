/**
 * Terminal input targeting for CDP. Focus a *terminal input* before sending
 * Input.insertText or Input.dispatchKeyEvent; never use xterm.write(), which
 * merely renders output and does not forward data to the underlying PTY.
 */
export interface TerminalInputTargetOptions {
  selector?: string;
  index?: number;
}

export interface TerminalFocusResult {
  ok: boolean;
  reason?: string;
  terminalIndex?: number;
  count?: number;
  kind?: string;
  inputTag?: string;
}

export function buildFocusTerminalJs(options: TerminalInputTargetOptions = {}): string {
  const safeIndex = options.index === undefined ? null : Number(options.index);
  const opts = {
    selector: String(options.selector || "").slice(0, 300),
    index: safeIndex !== null && Number.isSafeInteger(safeIndex) && safeIndex >= 0 && safeIndex <= 1000 ? safeIndex : null,
  };
  return "/*cdp-focus-terminal*/(" + browserFocusTerminal.toString() + ")(" + JSON.stringify(opts) + ")";
}

/** Source is stringified and evaluated in the page context, not Node.js. */
function browserFocusTerminal(opts: { selector: string; index: number | null }): TerminalFocusResult {
  const roots: Element[] = [];
  const rootSelector = ".xterm, .hterm, [data-terminal], .terminal, .terminal-output, [role='log']";
  const MAX_TERMINALS = 32;
  const visit = (doc: Document | ShadowRoot, depth: number): void => {
    if (depth > 5 || roots.length >= MAX_TERMINALS) return;
    try {
      for (const el of doc.querySelectorAll(rootSelector)) {
        if (roots.length >= MAX_TERMINALS) break;
        if (!roots.some((root) => root.contains(el))) roots.push(el);
      }
      let count = 0;
      for (const el of doc.querySelectorAll("*")) {
        if (++count > 5000) break;
        if (el.shadowRoot) visit(el.shadowRoot, depth + 1);
      }
      for (const frame of doc.querySelectorAll("iframe")) {
        try { if (frame.contentDocument) visit(frame.contentDocument, depth + 1); } catch { /* cross-origin */ }
      }
    } catch { /* detached nodes */ }
  };
  visit(document, 0);

  const matches: { root: Element; index: number }[] = [];
  for (let i = 0; i < roots.length; i++) {
    const root = roots[i];
    if (opts.index !== null && opts.index !== i) continue;
    if (opts.selector) {
      try {
        if (!(root.matches(opts.selector) || root.closest(opts.selector) || root.querySelector(opts.selector))) continue;
      } catch {
        return { ok: false, reason: "Invalid CSS selector.", count: roots.length };
      }
    }
    matches.push({ root, index: i });
  }
  if (!matches.length) return { ok: false, reason: "No matching terminal found. Run read_terminal to discover indices or selectors.", count: roots.length };
  if (matches.length > 1) return { ok: false, reason: "Multiple terminals found: specify index or selector to avoid sending to the wrong shell.", count: matches.length };

  const { root, index } = matches[0];
  const kind = root.classList.contains("xterm") ? "xterm.js" :
    root.classList.contains("hterm") ? "hterm" : "web-terminal";

  // xterm.js inserts a hidden textarea to accept real browser keyboard events.
  // For generic web terminals use existing input/contenteditable, never create DOM.
  const inputSelector = [
    "textarea.xterm-helper-textarea", "textarea.hterm", "textarea",
    "input[type='text']", "[contenteditable='true']", "[role='textbox']"
  ].join(", ");
  let input: HTMLElement | null = null;
  try { input = root.querySelector<HTMLElement>(inputSelector); } catch { /* detached */ }
  if (!input && (root.matches("[contenteditable='true'], [role='textbox']") ||
      (typeof (root as HTMLElement).focus === "function" && (root as HTMLElement).tabIndex >= 0))) input = root as HTMLElement;
  if (!input || typeof input.focus !== "function") {
    return { ok: false, reason: "Terminal has no focusable input. Expose a textarea/contenteditable element for CDP keyboard input.", terminalIndex: index, count: roots.length, kind };
  }
  try {
    input.focus();
    const owner = input.ownerDocument;
    const rootNode = input.getRootNode();
    const focusedWithinShadow = typeof ShadowRoot !== "undefined" &&
      rootNode instanceof ShadowRoot && rootNode.activeElement === input;
    if (owner.activeElement !== input && !focusedWithinShadow) {
      return { ok: false, reason: "Terminal input could not receive focus.", terminalIndex: index, count: roots.length, kind };
    }
  } catch {
    return { ok: false, reason: "Failed to focus terminal input.", terminalIndex: index, count: roots.length, kind };
  }
  return { ok: true, terminalIndex: index, count: roots.length, kind, inputTag: input.tagName.toLowerCase() };
}

type NativeKey = {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  modifiers?: number;
  text?: string;
};

const NATIVE_TERMINAL_KEYS: Record<string, NativeKey> = {
  enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, text: "\t" },
  escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
  arrowup: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
  home: { key: "Home", code: "Home", windowsVirtualKeyCode: 36 },
  end: { key: "End", code: "End", windowsVirtualKeyCode: 35 },
  "ctrl+c": { key: "c", code: "KeyC", windowsVirtualKeyCode: 67, modifiers: 2 },
  "ctrl+d": { key: "d", code: "KeyD", windowsVirtualKeyCode: 68, modifiers: 2 },
  "ctrl+l": { key: "l", code: "KeyL", windowsVirtualKeyCode: 76, modifiers: 2 },
};
export function terminalKeyEvent(key: string): {
  down: Record<string, unknown>;
  up: Record<string, unknown>;
} | null {
  const spec = NATIVE_TERMINAL_KEYS[key.trim().toLowerCase().replace(/\s+/g, "")];
  if (!spec) return null;
  return {
    down: {
      type: "keyDown", key: spec.key, code: spec.code,
      windowsVirtualKeyCode: spec.windowsVirtualKeyCode, nativeVirtualKeyCode: spec.windowsVirtualKeyCode,
      modifiers: spec.modifiers ?? 0,
      ...(spec.text ? { text: spec.text, unmodifiedText: spec.text } : {}),
    },
    up: {
      type: "keyUp", key: spec.key, code: spec.code,
      windowsVirtualKeyCode: spec.windowsVirtualKeyCode, nativeVirtualKeyCode: spec.windowsVirtualKeyCode,
      modifiers: spec.modifiers ?? 0,
    },
  };
}

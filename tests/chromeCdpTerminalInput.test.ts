import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import { buildFocusTerminalJs, terminalKeyEvent } from "../src/core/tools/chromeCdpTerminalInput.js";
import { CHROME_MCP_TOOL_DEFS } from "../src/core/mcp/tools/chromeMcpTools.js";
import { controlChromeCdpTool } from "../src/core/tools/chromeCdpTools.js";

function fixture(ids: string[], options: { noInput?: boolean; focusFails?: boolean } = {}) {
  const doc: { activeElement: unknown; querySelectorAll: (selector: string) => any[] } = {
    activeElement: null,
    querySelectorAll: () => [],
  };
  const roots: any[] = ids.map((id) => {
    const input = {
      tagName: "TEXTAREA", ownerDocument: doc,
      getRootNode: () => doc,
      focus: () => { if (!options.focusFails) doc.activeElement = input; },
    };
    const root = {
      id, classList: { contains: (name: string) => name === "xterm" },
      tagName: "DIV", tabIndex: -1, className: "xterm",
      contains: (other: unknown) => other === root || other === input,
      matches: (selector: string) => {
        if (selector === "[") throw new Error("invalid selector");
        return selector === "#" + id;
      },
      closest: () => null,
      querySelector: (selector: string) =>
        selector.includes("textarea.xterm-helper-textarea") && !options.noInput ? input : null,
    };
    return root;
  });
  doc.querySelectorAll = (selector) => selector.includes(".xterm") ? roots : [];
  return { doc, roots };
}

function executeFocus(ids: string[], options: { selector?: string; index?: number } = {}, flags: { noInput?: boolean; focusFails?: boolean } = {}) {
  const { doc } = fixture(ids, flags);
  return runInNewContext(buildFocusTerminalJs(options), { document: doc }) as {
    ok: boolean; reason?: string; terminalIndex?: number; count?: number; inputTag?: string;
  };
}

describe("Chrome CDP terminal writer", () => {
  it("exposes write and native key commands in CDP and MCP", () => {
    const cdps = (controlChromeCdpTool.parameters as any).properties.command.enum;
    const mcps = CHROME_MCP_TOOL_DEFS.find((item) => item.name === "superagent_chrome_cdp")?.inputSchema.properties.command.enum;
    for (const name of ["write_terminal", "send_terminal_key"]) {
      expect(cdps).toContain(name);
      expect(mcps).toContain(name);
    }
  });

  it("focuses the exact terminal's existing textarea without creating or modifying DOM", () => {
    const result = executeFocus(["a", "b"], { index: 1 });
    expect(result).toMatchObject({ ok: true, terminalIndex: 1, inputTag: "textarea" });
    expect(executeFocus(["a", "b"], { selector: "#a" })).toMatchObject({ ok: true, terminalIndex: 0 });
  });

  it("refuses to guess between multiple terminals, an unknown terminal, or invalid CSS", () => {
    expect(executeFocus(["a", "b"]).reason).toMatch(/Multiple terminals/);
    expect(executeFocus(["a"], { selector: "#missing" }).reason).toMatch(/No matching terminal/);
    expect(executeFocus(["a"], { index: 5 }).reason).toMatch(/No matching terminal/);
    expect(executeFocus(["a"], { selector: "[" }).reason).toMatch(/Invalid CSS selector/);
  });

  it("refuses input when a terminal lacks an interactive element or cannot be focused", () => {
    expect(executeFocus(["a"], {}, { noInput: true }).reason).toMatch(/no focusable input/);
    expect(executeFocus(["a"], {}, { focusFails: true }).reason).toMatch(/could not receive focus/);
  });

  it("maps Enter, Ctrl+C and navigation keys to real native CDP key event pairs", () => {
    const enter = terminalKeyEvent("Enter");
    expect(enter?.down).toMatchObject({ type: "keyDown", key: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
    expect(enter?.up).toMatchObject({ type: "keyUp", key: "Enter" });
    const interrupt = terminalKeyEvent(" Ctrl + C ");
    expect(interrupt?.down).toMatchObject({ type: "keyDown", key: "c", modifiers: 2 });
    expect(terminalKeyEvent("ArrowUp")?.down).toMatchObject({ key: "ArrowUp", windowsVirtualKeyCode: 38 });
    expect(terminalKeyEvent("Ctrl+Alt+Delete")).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import { buildReadTerminalJs, formatTerminalReadResult, type TerminalReadOptions, type TerminalResult } from "../src/core/tools/chromeCdpTerminal.js";
import { controlChromeCdpTool } from "../src/core/tools/chromeCdpTools.js";
import { CHROME_MCP_TOOL_DEFS } from "../src/core/mcp/tools/chromeMcpTools.js";

type ElementFixture = {
  id: string; tagName: string; className: string; classList: { contains: (x: string) => boolean };
  textContent: string; querySelectorAll: (query: string) => ElementFixture[];
  querySelector: (query: string) => ElementFixture | null;
  contains: (other: ElementFixture) => boolean;
  matches: (selector: string) => boolean;
  closest: (selector: string) => ElementFixture | null;
  getAttribute: (name: string) => string | null;
};

function fakeRoot(id: string, className = "xterm", a11yRows: string[] = []): ElementFixture {
  const el: ElementFixture = {
    id, tagName: "DIV", className, textContent: "",
    classList: { contains: (x) => className.split(" ").includes(x) },
    querySelectorAll: (query) => query.includes("xterm-accessibility-tree")
      ? a11yRows.map((text) => ({ textContent: text, getAttribute: () => null } as ElementFixture))
      : [],
    querySelector: () => null,
    contains: (other) => other === el,
    matches: (selector) => {
      if (selector.includes("[" ) && !selector.includes("]")) throw new Error("bad selector");
      return selector === "#" + id || selector === "." + className;
    },
    closest: () => null, getAttribute: () => null,
  };
  return el;
}

function runTerminal(options: TerminalReadOptions, roots: ElementFixture[], exposed: Record<string, unknown> = {}): TerminalResult {
  const document = {
    querySelectorAll: (selector: string) => selector.includes(".xterm, .hterm")
      ? roots : [],
  };
  const window = { ...exposed };
  return runInNewContext(buildReadTerminalJs(options), { document, window }) as TerminalResult;
}

function termBuffer(root: ElementFixture, texts: string[], baseY = 0, rows = 4) {
  return {
    element: root, rows,
    buffer: { active: {
      length: texts.length, baseY,
      getLine: (i: number) => i >= 0 && i < texts.length
        ? { translateToString: () => texts[i] } : undefined,
    } },
  };
}

describe("Chrome CDP web terminal reader", () => {
  it("is exposed in both native CDP and MCP schemas", () => {
    expect((controlChromeCdpTool.parameters as any).properties.command.enum).toContain("read_terminal");
    const mcp = CHROME_MCP_TOOL_DEFS.find((t) => t.name === "superagent_chrome_cdp");
    expect(mcp?.inputSchema.properties.command.enum).toContain("read_terminal");
  });

  it("reads xterm canvas renderer when the application exposes a buffer, including scrollback", () => {
    const root = fakeRoot("term");
    const result = runTerminal({}, [root], { term: termBuffer(root, ["old output", "build 99%", "build success", ""]) });
    expect(result.terminals).toHaveLength(1);
    expect(result.terminals[0].source).toBe("xterm-buffer");
    expect(result.terminals[0].lines.join("\n")).toBe("old output\nbuild 99%\nbuild success");
    expect(formatTerminalReadResult(result)).toContain("build success");
  });

  it("reads xterm accessibility rows without a global JS terminal instance", () => {
    const result = runTerminal({}, [fakeRoot("shell", "xterm", ["npm run build", "Done"])]);
    expect(result.terminals[0].source).toBe("xterm-accessibility");
    expect(result.terminals[0].lines.join("\n")).toBe("npm run build\nDone");
  });

  it("does not fabricate text for canvas-only terminals", () => {
    const result = runTerminal({}, [fakeRoot("canvas")]);
    expect(result.terminals[0].source).toBe("unavailable");
    expect(result.terminals[0].warning).toMatch(/Canvas\/WebGL/);
    expect(result.terminals[0].lines).toHaveLength(0);
  });

  it("selects one of several terminals by index or CSS selector", () => {
    const first = fakeRoot("first");
    const second = fakeRoot("second");
    const terminals = [termBuffer(first, ["one"]), termBuffer(second, ["two"])];
    expect(runTerminal({ index: 1 }, [first, second], { terminals }).terminals.map((t) => t.lines.join(""))).toEqual(["two"]);
    expect(runTerminal({ selector: "#first" }, [first, second], { terminals }).terminals.map((t) => t.lines.join(""))).toEqual(["one"]);
  });

  it("keeps global pane index after filtering rather than renumbering", () => {
    const first = fakeRoot("first");
    const second = fakeRoot("second");
    const result = runTerminal({ selector: "#second" }, [first, second], {
      terminals: [termBuffer(first, ["one"]), termBuffer(second, ["two"])],
    });
    expect(result.detected).toBe(2);
    expect(result.terminals).toHaveLength(1);
    expect(result.terminals[0].index).toBe(1);
    expect(result.terminals[0].terminalId).toMatch(/^term-/);
  });

  it("applies max_lines, max_chars and viewport_only bounds", () => {
    const root = fakeRoot("term");
    const term = termBuffer(root, ["zero", "one", "two", "three", "four"], 2, 2);
    expect(runTerminal({ max_lines: 2 }, [root], { term }).terminals[0].lines.join(",")).toBe("three,four");
    expect(runTerminal({ viewport_only: true }, [root], { term }).terminals[0].lines.join(",")).toBe("two,three");
    const many = termBuffer(root, Array.from({ length: 300 }, (_, i) => "line-" + i));
    expect(runTerminal({ max_lines: 9999 }, [root], { term: many }).terminals[0].lines.length).toBe(200);
    const long = termBuffer(root, ["x".repeat(1000)]);
    expect(runTerminal({ max_chars: 10 }, [root], { term: long }).terminals[0].lines.join("").length).toBeLessThanOrEqual(200);
  });

  it("reports malformed selector and missing terminal honestly", () => {
    expect(runTerminal({ selector: "[" }, [fakeRoot("shell")]).warning).toMatch(/Invalid CSS selector/);
    expect(runTerminal({}, []).warning).toMatch(/No supported terminal/);
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import { runInNewContext } from "node:vm";
import { buildReadTerminalJs } from "../src/core/tools/chromeCdpTerminal.js";
import { terminalKeyEvent } from "../src/core/tools/chromeCdpTerminalInput.js";
import { prepareTerminalInput, executeCdpTerminalCommand, type TerminalCdpDeps } from "../src/core/tools/chromeCdpTerminalCommands.js";
import { clearTerminalSessions, terminalCommandRisk } from "../src/core/tools/chromeCdpTerminalEngine.js";
import { CHROME_MCP_TOOL_DEFS } from "../src/core/mcp/tools/chromeMcpTools.js";
import { controlChromeCdpTool } from "../src/core/tools/chromeCdpTools.js";

function browserFixture(instanceLocation: "node" | "fiber" | "none") {
  const root: any = {
    id: "terminal", tagName: "DIV", className: "xterm",
    classList: { contains: (x: string) => x === "xterm" },
    contains: (other: unknown) => other === root,
    matches: () => false, closest: () => null,
    querySelector: () => null, querySelectorAll: () => [],
    getBoundingClientRect: () => ({ left: 14, top: 35, width: 400, height: 200 }),
  };
  const lines = ["ready", "echo test", "completed"];
  const term = { element: root, rows: 24, buffer: { active: {
    length: lines.length, baseY: 0,
    getLine: (i: number) => ({ translateToString: () => lines[i] }),
  } } };
  if (instanceLocation === "node") root._xterm = term;
  if (instanceLocation === "fiber") root["__reactFiber$test"] = {
    memoizedState: { memoizedState: { current: term }, next: null },
  };
  const document = { querySelectorAll: (q: string) => q.includes(".xterm") ? [root] : [] };
  return runInNewContext(buildReadTerminalJs(), { window: {}, document }) as {
    terminals: Array<{ source: string; lines: string[]; rect?: { width: number; height: number } }>
  };
}

function canvasDeps() {
  const calls: Array<{ method: string; params: any }> = [];
  const deps: TerminalCdpDeps = {
    pickTarget: async () => ({ id: "T1", title: "Canvas test", url: "http://localhost", webSocketDebuggerUrl: "ws://localhost/test" }),
    scopeTarget: (t) => "test:" + t.id,
    send: async (_target, method, params = {}) => {
      calls.push({ method, params });
      if (method === "Runtime.evaluate") {
        if (String(params.expression).includes("cdp-focus-terminal")) {
          return { result: { value: { ok: true, terminalIndex: 0, terminalId: "term-test-1", kind: "xterm.js" } } };
        }
        return { result: { value: { detected: 1, terminals: [{
          index: 0, terminalId: "term-test-1", kind: "xterm.js", selector: "#term",
          source: "unavailable", lines: [], totalLines: null,
          rect: { x: 14, y: 35, width: 400, height: 200 },
        }] } } };
      }
      if (method === "Page.captureScreenshot") return { data: "cG5n" };
      return {};
    },
  };
  return { deps, calls };
}

describe("CDP terminal optimization", () => {
  beforeEach(() => clearTerminalSessions());

  it("discovers a canvas renderer buffer on known DOM node and bounded React ref", () => {
    for (const location of ["node", "fiber"] as const) {
      const result = browserFixture(location);
      expect(result.terminals[0].source).toBe("xterm-buffer");
      expect(result.terminals[0].lines).toEqual(["ready", "echo test", "completed"]);
    }
    const absent = browserFixture("none");
    expect(absent.terminals[0].source).toBe("unavailable");
    expect(absent.terminals[0].rect).toEqual({ x: 14, y: 35, width: 400, height: 200 });
  });

  it("maps Ctrl shortcuts, function keys and paging to native events", () => {
    for (const key of ["Ctrl+Z", "Ctrl+A", "Ctrl+E", "Ctrl+U", "Ctrl+K", "Ctrl+W", "Ctrl+R"]) {
      expect(terminalKeyEvent(key)?.down.modifiers).toBe(2);
    }
    for (let i = 1; i <= 12; i++) {
      expect(terminalKeyEvent("F" + i)?.down.windowsVirtualKeyCode).toBe(111 + i);
    }
    expect(terminalKeyEvent("PageUp")?.down.windowsVirtualKeyCode).toBe(33);
    expect(terminalKeyEvent("PageDown")?.down.windowsVirtualKeyCode).toBe(34);
    expect(terminalKeyEvent("Insert")?.down.windowsVirtualKeyCode).toBe(45);
  });

  it("protects multiline scripts and preserves heredoc text losslessly", () => {
    const script = "cat <<'EOF'\nhello\nEOF";
    const wrapped = prepareTerminalInput(script, { verify_shell: "posix" });
    expect(wrapped.ok).toBe(true);
    expect(wrapped.mode).toBe("base64");
    const encoded = wrapped.text.match(/'([A-Za-z0-9+/=]+)'/)?.[1];
    expect(encoded).toBeDefined();
    expect(Buffer.from(encoded!, "base64").toString("utf8")).toBe(script);
    expect(prepareTerminalInput(script, {})).toMatchObject({ ok: false, mode: "base64" });
    const bracketed = prepareTerminalInput("one\ntwo", { multiline_mode: "bracketed" });
    expect(bracketed.text).toBe("\x1b[200~one\ntwo\x1b[201~");
    expect(prepareTerminalInput(script, { multiline_mode: "reject" }).ok).toBe(false);
    expect(prepareTerminalInput(script, { multiline_mode: "raw" }).ok).toBe(false);
    expect(terminalCommandRisk("echo ok\nrm -rf /tmp/nope", true).blocked).toBe(true);
  });

  it("returns visual-only data without claiming text or completion, and requires explicit opt-in to execute", async () => {
    const mock = canvasDeps();
    const blocked = await executeCdpTerminalCommand("execute_terminal", { text: "echo ok", wait_ms: 0 }, "T1", mock.deps);
    expect(blocked).toContain("readable terminal");
    expect(mock.calls.some((c) => c.method === "Input.insertText")).toBe(false);
    const read = JSON.parse(await executeCdpTerminalCommand("read_terminal",
      { allow_visual_fallback: true }, "T1", mock.deps));
    expect(read).toMatchObject({ source: "canvas-visual", status: "visual_only_unverified", screenshot: "data:image/png;base64,cG5n", completionVerified: false });
    const result = JSON.parse(await executeCdpTerminalCommand("execute_terminal",
      { text: "echo safe", allow_visual_fallback: true, wait_ms: 0 }, "T1", mock.deps));
    expect(result).toMatchObject({ dispatched: true, status: "visual_only_unverified", completionVerified: false, exitCode: null });
    expect(mock.calls.filter((c) => c.method === "Input.dispatchKeyEvent").map((c) => c.params.type).slice(-3))
      .toEqual(["rawKeyDown", "char", "keyUp"]);
    const imageCall = mock.calls.find((c) => c.method === "Page.captureScreenshot");
    expect(imageCall?.params.clip).toMatchObject({ x: 14, y: 35, width: 400, height: 200 });
  });

  it("keeps matching options in native and MCP tool declarations", () => {
    const native = (controlChromeCdpTool.parameters as any).properties;
    const mcp = CHROME_MCP_TOOL_DEFS.find((tool) => tool.name === "superagent_chrome_cdp")!.inputSchema.properties;
    for (const key of ["multiline_mode", "allow_visual_fallback", "auto_crop_screenshot"]) {
      expect(native).toHaveProperty(key);
      expect(mcp).toHaveProperty(key);
    }
  });
});

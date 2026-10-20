import { describe, it, expect, beforeEach } from "vitest";
import { executeCdpTerminalCommand, type TerminalCdpDeps } from "../src/core/tools/chromeCdpTerminalCommands.js";
import { clearTerminalSessions, getTerminalSessions } from "../src/core/tools/chromeCdpTerminalEngine.js";

function mockedTerminal() {
  let typed = "";
  let enterSent = false;
  let print = ["$ "];
  let failures = false;
  let delayMarker = false;
  const calls: Array<{ method: string; params: any }> = [];
  const deps: TerminalCdpDeps = {
    pickTarget: async (id, _activate, explicit) => {
      if (explicit && id !== "T1") throw new Error("Multiple targets; supply targetId");
      return { id: "T1", title: "Mock", url: "http://127.0.0.1/app", webSocketDebuggerUrl: "ws://localhost:9222/mock" };
    },
    scopeTarget: (target) => "port9222:" + target.id,
    send: async (_target, method, params = {}) => {
      calls.push({ method, params });
      if (method === "Runtime.evaluate") {
        const expression = String(params.expression);
        if (expression.includes("cdp-focus-terminal")) {
          return { result: { value: failures
            ? { ok: false, reason: "focus denied" }
            : { ok: true, terminalIndex: 0, terminalId: "term-mock-1", kind: "xterm.js", inputTag: "textarea" }
          } };
        }
        if (expression.includes("cdp-read-terminal")) {
          const requestedId = expression.match(/"terminal_id":"([^"]*)"/)?.[1];
          if (requestedId && requestedId !== "term-mock-1") {
            return { result: { value: { detected: 1, terminals: [] } } };
          }
          return { result: { value: { detected: 1, terminals: [
            { index: 0, terminalId: "term-mock-1", kind: "xterm.js", selector: "#tty",
              source: "xterm-buffer", totalLines: print.length, lines: [...print] },
          ] } } };
        }
      }
      if (method === "Input.insertText") typed = String(params.text || "");
      if (method === "Input.dispatchKeyEvent" && params.type === "keyUp" && params.key === "Enter") {
        enterSent = true;
        const marker = typed.match(/__SA_EXIT_[0-9a-f]{20}/)?.[0];
        print = [...print, "command executing", ...(marker ? (delayMarker ? [] : [marker + ":0"]) : ["done"]) ];
      }
      return {};
    },
  };
  return { deps, calls, get typed() { return typed; },
    get enterSent() { return enterSent; },
    setFailures(v: boolean) { failures = v; },
    setDelayed(v: boolean) { delayMarker = v; },
    setLines(v: string[]) { print = v; },
  };
}
const execute = (cmd: string, payload: Record<string, unknown>, deps: TerminalCdpDeps, id = "T1") =>
  executeCdpTerminalCommand(cmd, payload, id, deps);

describe("CDP terminal command workflows", () => {
  beforeEach(() => clearTerminalSessions());

  it("reads deltas, retains per-target metadata, and clears sessions without killing processes", async () => {
    const mock = mockedTerminal();
    const first = await execute("read_terminal_delta", {}, mock.deps);
    expect(JSON.parse(first).observations[0].changed).toBe(true);
    const unchanged = await execute("read_terminal_delta", {}, mock.deps);
    expect(JSON.parse(unchanged).observations[0].changed).toBe(false);
    mock.setLines(["$ ", "build passed"]);
    const next = await execute("read_terminal_delta", {}, mock.deps);
    expect(JSON.parse(next).observations[0].delta).toContain("build passed");
    expect(JSON.parse(await execute("list_terminal_sessions", {}, mock.deps)).sessions).toHaveLength(1);
    await execute("clear_terminal_sessions", {}, mock.deps);
    expect(getTerminalSessions()).toHaveLength(0);
  });

  it("requires explicit targetId if several tabs exist", async () => {
    const mock = mockedTerminal();
    await expect(execute("write_terminal", { text: "pwd", enter: true }, mock.deps, ""))
      .rejects.toThrow(/Multiple targets/);
    expect(mock.calls).toHaveLength(0);
  });

  it("can execute and observe output while honestly leaving exit code unknown", async () => {
    const mock = mockedTerminal();
    const text = await execute("execute_terminal",
      { index: 0, text: "echo done", expected_output: "done", wait_ms: 0 }, mock.deps);
    const result = JSON.parse(text);
    expect(result.dispatched).toBe(true);
    expect(result.completionVerified).toBe(false);
    expect(result.exitCode).toBeNull();
    expect(mock.enterSent).toBe(true);
    expect(result.expectedOutputMatched).toBe(true);
  });

  it("can verify an exit-code marker for an opted-in known POSIX shell", async () => {
    const mock = mockedTerminal();
    const text = await execute("execute_terminal",
      { terminal_id: "term-mock-1", text: "echo ok", verify_shell: "posix", wait_ms: 0 }, mock.deps);
    const result = JSON.parse(text);
    expect(result.status).toBe("exit_code_observed");
    expect(result.exitCode).toBe(0);
    expect(result.completionVerified).toBe(true);
    expect(mock.typed).toContain("printf");
  });

  it("packages a multiline POSIX heredoc before dispatch and retains shell verification", async () => {
    const mock = mockedTerminal();
    const script = "cat <<'EOF'\nhello\nEOF";
    const response = JSON.parse(await execute("execute_terminal",
      { text: script, verify_shell: "posix", multiline_mode: "base64", wait_ms: 0 }, mock.deps));
    expect(response.completionVerified).toBe(true);
    expect(response.exitCode).toBe(0);
    expect(mock.typed).toContain("base64 -d | bash");
    expect(mock.typed).toContain("printf '\\n__SA_EXIT_");
  });

  it("preserves pending exit verification across calls and prevents duplicate execution", async () => {
    const mock = mockedTerminal();
    mock.setDelayed(true);
    const first = JSON.parse(await execute("execute_terminal",
      { text: "sleep 10", verify_shell: "posix", wait_ms: 0 }, mock.deps));
    expect(first.completionVerified).toBe(false);
    expect(getTerminalSessions()[0].awaitingCompletion).toBe(true);
    expect(await execute("execute_terminal",
      { text: "echo duplicate", wait_ms: 0 }, mock.deps)).toMatch(/awaiting completion/);
    const marker = mock.typed.match(/__SA_EXIT_[0-9a-f]{20}/)?.[0];
    expect(marker).toBeDefined();
    mock.setLines(["$ ", "command executing", marker + ":0"]);
    const followed = JSON.parse(await execute("watch_terminal", { wait_ms: 0 }, mock.deps));
    expect(followed.exitCode).toBe(0);
    expect(followed.completionVerified).toBe(true);
    expect(getTerminalSessions()[0].awaitingCompletion).toBe(false);
  });

  it("recovers a known target and only rebinds a stale id with explicit opt-in", async () => {
    const mock = mockedTerminal();
    const missing = JSON.parse(await execute("recover_terminal", { terminal_id: "term-stale-1" }, mock.deps));
    expect(missing.status).toBe("unavailable");
    const rebound = JSON.parse(await execute("recover_terminal",
      { terminal_id: "term-stale-1", rebind_on_reload: true }, mock.deps));
    expect(rebound.rebound).toBe(true);
    expect(rebound.terminalId).toBe("term-mock-1");
  });

  it("blocks destructive shell commands without explicit opt-in", async () => {
    const mock = mockedTerminal();
    const refused = await execute("execute_terminal", { text: "rm -rf /tmp/folder", wait_ms: 0 }, mock.deps);
    expect(refused).toMatch(/Potentially destructive/);
    expect(mock.calls.some((c) => c.method === "Input.insertText")).toBe(false);
    const allowed = await execute("execute_terminal",
      { text: "rm -rf /tmp/folder", allow_dangerous: true, wait_ms: 0 }, mock.deps);
    expect(JSON.parse(allowed).dispatched).toBe(true);
  });

  it("rejects nonfocusable terminal and unsupported key without dispatching text", async () => {
    const mock = mockedTerminal();
    mock.setFailures(true);
    expect(await execute("write_terminal", { text: "pwd" }, mock.deps)).toContain("focus denied");
    expect(mock.calls.some((c) => c.method === "Input.insertText")).toBe(false);
    expect(await execute("send_terminal_key", { key: "Ctrl+Alt+Delete" }, mock.deps)).toMatch(/unsupported/);
  });

  it("does not mistake preexisting scrollback for new watch output", async () => {
    const mock = mockedTerminal();
    mock.setLines(["$ ", "old success"]);
    const result = JSON.parse(await execute("watch_terminal",
      { expected_output: "old success", wait_ms: 0 }, mock.deps));
    expect(result.status).toBe("timed_out_unverified");
    expect(result.expectedOutputMatched).toBe(false);
  });

  it("watch_terminal returns bounded delta and correct unknown status", async () => {
    const mock = mockedTerminal();
    await execute("read_terminal_delta", {}, mock.deps);
    const idle = JSON.parse(await execute("watch_terminal", { index: 0, wait_ms: 0 }, mock.deps));
    expect(idle.status).toBe("timed_out_unverified");
    mock.setLines(["$ ", "Claude Code ready"]);
    const changed = JSON.parse(await execute("watch_terminal", { index: 0, wait_ms: 0 }, mock.deps));
    expect(changed.status).toBe("output_changed_unverified");
    expect(changed.agent).toMatch(/claude-code/);
    const agents = JSON.parse(await execute("monitor_terminal_agents", {}, mock.deps));
    expect(agents.sessions).toHaveLength(1);
  });
});

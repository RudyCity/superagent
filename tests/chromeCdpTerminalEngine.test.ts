import { describe, it, expect, beforeEach } from "vitest";
import {
  observeTerminal, clearTerminalSessions, getTerminalSessions,
  appendedTerminalText, findCliAgent, terminalCommandRisk,
  recordTerminalAction,
} from "../src/core/tools/chromeCdpTerminalEngine.js";

const pane = (lines: string[], terminalId = "term-abc-1") => ({
  index: 0, terminalId, kind: "xterm.js", selector: "#tty",
  source: "xterm-buffer", totalLines: lines.length, lines,
});

describe("Chrome CDP Terminal engine", () => {
  beforeEach(() => clearTerminalSessions());

  it("records output deltas and monotonic cursors without duplicating unchanged output", () => {
    const first = observeTerminal("T1", pane(["root@host$ "]));
    expect(first.changed).toBe(true);
    const same = observeTerminal("T1", pane(["root@host$ "]));
    expect(same.changed).toBe(false);
    expect(same.cursor).toBe(first.cursor);
    const second = observeTerminal("T1", pane(["root@host$ ", "build success"]));
    expect(second.changed).toBe(true);
    expect(second.delta).toContain("build success");
    expect(second.cursor).toBe(first.cursor + 1);
    expect(getTerminalSessions()).toHaveLength(1);
    expect(JSON.stringify(getTerminalSessions())).not.toContain("build success");
  });

  it("separates panes, target scopes and captures only metadata of dispatch", () => {
    observeTerminal("port9222:T1", pane(["token=private"], "term-xyz-1"));
    observeTerminal("port9333:T1", pane(["other"], "term-xyz-1"));
    recordTerminalAction("port9222:T1", "term-xyz-1", "write_terminal", true);
    const states = getTerminalSessions();
    expect(states).toHaveLength(2);
    expect(states.find((s) => s.targetId === "port9222:T1")?.recentActions).toHaveLength(1);
    expect(JSON.stringify(states)).not.toContain("token=private");
    clearTerminalSessions("port9222:T1");
    expect(getTerminalSessions()).toHaveLength(1);
  });

  it("identifies append, scrollback overlap and reset", () => {
    expect(appendedTerminalText("hello", "hello world")).toEqual({ delta: " world", reset: false });
    expect(appendedTerminalText("prefix\nCOMMONSTRING", "COMMONSTRING\nnew"))
      .toEqual({ delta: "\nnew", reset: false });
    expect(appendedTerminalText("old screen", "new screen").reset).toBe(true);
  });

  it("recognizes agent hints without claiming process-level proof", () => {
    expect(findCliAgent("Claude Code Opus")).toMatch(/claude-code.*signature/);
    expect(findCliAgent("codex")).toMatch(/signature/);
    expect(findCliAgent("npm run test")).toBeNull();
  });

  it("flags destructive commands and control characters; opt-in is handled by caller", () => {
    for (const cmd of ["rm -rf /tmp/project", "git reset --hard HEAD", "docker system prune", "shutdown now"]) {
      expect(terminalCommandRisk(cmd).blocked, cmd).toBe(true);
    }
    expect(terminalCommandRisk("echo hello").blocked).toBe(false);
    expect(terminalCommandRisk("echo ok\necho delete").blocked).toBe(true);
  });
});

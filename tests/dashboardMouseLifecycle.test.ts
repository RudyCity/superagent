import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { Console } from "node:console";
import React from "react";
import * as ink from "ink";
import { useDashboardMouse } from "../src/hooks/useDashboardMouse.js";

// Bun's console facade may omit the constructor Ink uses.
if (!console.Console) console.Console = Console;

describe("dashboard mouse lifecycle and keyboard responsiveness", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(ink, "useApp").mockReturnValue({ exit: vi.fn() } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("supports keyboard-only recovery without registering terminal mouse hooks", async () => {
    const oldFlag = process.env.SUPERAGENT_CLI_DISABLE_MOUSE;
    process.env.SUPERAGENT_CLI_DISABLE_MOUSE = "1";
    const onSpy = vi.spyOn(process.stdin, "on").mockImplementation(() => process.stdin);
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const Test = () => {
      useDashboardMouse({ query: "test", terminalSize: { width: 80, height: 30 } } as any);
      return React.createElement(ink.Text, null, "keyboard-only");
    };
    const view = ink.render(React.createElement(Test));
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(onSpy.mock.calls.filter(([event]) => event === "data")).toHaveLength(0);
      expect(writeSpy.mock.calls.filter(([data]) => String(data).includes("\x1b[?1000h"))).toHaveLength(0);
    } finally {
      view.unmount();
      if (oldFlag === undefined) delete process.env.SUPERAGENT_CLI_DISABLE_MOUSE;
      else process.env.SUPERAGENT_CLI_DISABLE_MOUSE = oldFlag;
    }
  });

  it("keeps a single mouse listener when query and layout change", async () => {
    const onSpy = vi.spyOn(process.stdin, "on").mockImplementation(() => process.stdin);
    const offSpy = vi.spyOn(process.stdin, "off").mockImplementation(() => process.stdin);
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const context = (query: string) => ({
      wrappedLines: [], logsCount: 8, terminalSize: { width: 90, height: 35 },
      activeWizard: null, wizardOptions: [], wizardSelectedIndex: 0,
      query, wizardAllOptions: [], workspaceHeight: 20, leftTopHeight: 10,
      wizardIsLoadingModels: false, agent: null, focusArea: "input",
      setQuery: vi.fn(), setActiveWizard: vi.fn(), setWizardSelectedIndex: vi.fn(),
      setWizardSelectedSet: vi.fn(), setWizardOptions: vi.fn(),
      handleWizardSubmit: vi.fn(), setFocusArea: vi.fn(),
      setLogScrollOffset: vi.fn(), setChecklistScrollOffset: vi.fn(),
      setAgentsScrollOffset: vi.fn(), setProcsScrollOffset: vi.fn(),
      checklistTasksCount: 0, agentsCount: 0, procsCount: 0,
    });
    const Test = ({ query }: { query: string }) => {
      useDashboardMouse(context(query) as any);
      return React.createElement(ink.Text, null, query);
    };
    const view = ink.render(React.createElement(Test, { query: "" }));
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      const initialListeners = onSpy.mock.calls.filter(([event]) => event === "data").length;
      const initialEnableWrites = writeSpy.mock.calls.filter(([data]) => String(data).includes("\x1b[?1000h")).length;
      expect(initialListeners).toBe(1);
      expect(initialEnableWrites).toBe(1);

      for (const query of ["a", "ab", "abc", "/model", "/model mcp", "hello!"]) {
        view.rerender(React.createElement(Test, { query }));
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(onSpy.mock.calls.filter(([event]) => event === "data")).toHaveLength(1);
      expect(offSpy.mock.calls.filter(([event]) => event === "data")).toHaveLength(0);
      expect(writeSpy.mock.calls.filter(([data]) => String(data).includes("\x1b[?1000h"))).toHaveLength(1);
    } finally {
      view.unmount();
    }
    // Ink schedules passive-effect cleanup asynchronously after unmount.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(offSpy.mock.calls.filter(([event]) => event === "data")).toHaveLength(1);
  });
});

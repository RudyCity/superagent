import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import * as reactModule from "react";
import * as inkModule from "ink";
import { useKeyboardHandler } from "../src/hooks/useKeyboardHandler.js";
import { useDashboardKeyboard } from "../src/hooks/useDashboardKeyboard.js";

describe("CLI focus mode input and typing recovery regression", () => {
  let callbacks: Array<(input: string, key: any) => void>;

  beforeEach(() => {
    callbacks = [];
    vi.restoreAllMocks();
    vi.spyOn(inkModule, "useInput").mockImplementation((callback: any) => {
      callbacks.push(callback);
    });
    vi.spyOn(reactModule, "useRef").mockImplementation((value: any) => ({ current: value }));
    vi.spyOn(reactModule, "useCallback").mockImplementation((fn: any) => fn);
    vi.spyOn(reactModule.default, "useRef").mockImplementation((value: any) => ({ current: value }));
    vi.spyOn(reactModule.default, "useCallback").mockImplementation((fn: any) => fn);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function singleAgentContext(overrides: Record<string, unknown> = {}) {
    const ctx = {
      input: "",
      setInput: vi.fn(),
      isProcessing: false,
      setIsProcessing: vi.fn(),
      isExecutingTool: false,
      setIsExecutingTool: vi.fn(),
      activeWizard: null,
      setActiveWizard: vi.fn(),
      wizardOptions: [],
      setWizardOptions: vi.fn(),
      wizardSelectedIndex: 0,
      setWizardSelectedIndex: vi.fn(),
      wizardSelectedSet: new Set(),
      setWizardSelectedSet: vi.fn(),
      checkpointsList: [],
      setCheckpointsList: vi.fn(),
      lines: [{ type: "assistant", content: "response" }],
      setLines: vi.fn(),
      addLine: vi.fn(),
      history: ["item1", "item2"],
      setHistory: vi.fn(),
      historyIndex: -1,
      setHistoryIndex: vi.fn(),
      tempInput: "",
      setTempInput: vi.fn(),
      scrollOffset: 5,
      setScrollOffset: vi.fn(),
      focusedResponseIndex: null,
      setFocusedResponseIndex: vi.fn(),
      focusedResponseOffset: 0,
      setFocusedResponseOffset: vi.fn(),
      planState: "IDLE",
      setPlanState: vi.fn(),
      focusMode: "chat",
      setFocusMode: vi.fn(),
      historySelectedIndex: 0,
      setHistorySelectedIndex: vi.fn(),
      checklistScrollOffset: 0,
      setChecklistScrollOffset: vi.fn(),
      superagentsScrollOffset: 0,
      setSuperagentsScrollOffset: vi.fn(),
      subagentsScrollOffset: 0,
      setSubagentsScrollOffset: vi.fn(),
      procsScrollOffset: 0,
      setProcsScrollOffset: vi.fn(),
      procsSelectedIndex: 0,
      setProcsSelectedIndex: vi.fn(),
      terminalHeight: 30,
      terminalWidth: 80,
      checklistTasks: [],
      agentRef: { current: { abort: vi.fn(), isAgentRunning: () => false } },
      pendingPermission: null,
      pendingQuestion: null,
      handleWizardSubmit: vi.fn(),
      handleSubmit: vi.fn(),
      handlePermissionResponse: vi.fn(),
      stopRunningSubagents: vi.fn().mockReturnValue(0),
      scrollChat: vi.fn(),
      setContextLimit: vi.fn(),
      setActiveModel: vi.fn(),
      exit: vi.fn(),
      isPasted: false,
      setIsPasted: vi.fn(),
      pastePrefixLength: 0,
      pasteSuffixLength: 0,
      lastTabPrefix: null,
      setLastTabPrefix: vi.fn(),
      commands: [],
      ...overrides,
    };
    return { ctx };
  }

  it.each(["chat", "checklist", "superagents", "subagents", "procs", "history"])(
    "preserves typed character and switches to input when typing in %s focus mode",
    (focusMode) => {
      const { ctx } = singleAgentContext({ focusMode });
      useKeyboardHandler(ctx as any);

      callbacks[0]("h", {});

      expect(ctx.setFocusMode).toHaveBeenCalledWith("input");
      expect(ctx.setInput).toHaveBeenCalledWith(expect.any(Function));

      // Test functional updater preserves character
      const updater = ctx.setInput.mock.calls[0][0];
      expect(updater("")).toBe("h");
      expect(updater("start ")).toBe("start h");
    },
  );

  it.each(["chat", "checklist", "superagents", "subagents", "procs", "history"])(
    "preserves pasted text and switches to input when pasting in %s focus mode",
    (focusMode) => {
      const { ctx } = singleAgentContext({ focusMode });
      useKeyboardHandler(ctx as any);

      callbacks[0]("pasted command text", {});

      expect(ctx.setFocusMode).toHaveBeenCalledWith("input");
      expect(ctx.setInput).toHaveBeenCalledWith(expect.any(Function));

      const updater = ctx.setInput.mock.calls[0][0];
      expect(updater("")).toBe("pasted command text");
    },
  );

  it.each(["chat", "checklist", "superagents", "subagents"])(
    "Enter key resets focus to input from %s mode",
    (focusMode) => {
      const { ctx } = singleAgentContext({ focusMode });
      useKeyboardHandler(ctx as any);

      callbacks[0]("", { return: true });

      expect(ctx.setFocusMode).toHaveBeenCalledWith("input");
      if (focusMode === "chat") {
        expect(ctx.setScrollOffset).toHaveBeenCalledWith(0);
      }
    },
  );

  it("Escape key resets focus to input from procs mode", () => {
    const { ctx } = singleAgentContext({ focusMode: "procs" });
    useKeyboardHandler(ctx as any);

    callbacks[0]("", { escape: true });

    expect(ctx.setFocusMode).toHaveBeenCalledWith("input");
  });

  it("multi-agent dashboard auto-focuses input and appends text when typing outside input", () => {
    const setFocusArea = vi.fn();
    const setQuery = vi.fn();
    const setIsPasted = vi.fn();
    useDashboardKeyboard({
      focusArea: "logs",
      setFocusArea,
      setQuery,
      activeWizard: null,
      query: "",
      isProcessing: false,
      setIsProcessing: vi.fn(),
      setCurrentTask: vi.fn(),
      stopAllRunningAgents: vi.fn().mockReturnValue(0),
      pastePrefixLength: 0,
      pasteSuffixLength: 0,
      isPasted: false,
      setIsPasted,
      setLogScrollOffset: vi.fn(),
      sessions: [],
    } as any);

    callbacks[0]("build project", {});

    expect(setFocusArea).toHaveBeenCalledWith("input");
    expect(setQuery).toHaveBeenCalledWith(expect.any(Function));
    const updater = setQuery.mock.calls[0][0];
    expect(updater("")).toBe("build project");
  });
});

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import * as reactModule from "react";
import * as inkModule from "ink";
import { useKeyboardHandler } from "../src/hooks/useKeyboardHandler.js";
import { useDashboardKeyboard } from "../src/hooks/useDashboardKeyboard.js";

describe("CLI Escape routing regression", () => {
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
    const abort = vi.fn();
    const ctx = {
      input: "draft",
      setInput: vi.fn(),
      isProcessing: true,
      setIsProcessing: vi.fn(),
      isExecutingTool: true,
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
      history: ["earlier"],
      setHistory: vi.fn(),
      historyIndex: -1,
      setHistoryIndex: vi.fn(),
      tempInput: "",
      setTempInput: vi.fn(),
      scrollOffset: 4,
      setScrollOffset: vi.fn(),
      focusedResponseIndex: null,
      setFocusedResponseIndex: vi.fn(),
      focusedResponseOffset: 2,
      setFocusedResponseOffset: vi.fn(),
      planState: "IDLE",
      setPlanState: vi.fn(),
      focusMode: "chat",
      setFocusMode: vi.fn(),
      historySelectedIndex: 0,
      setHistorySelectedIndex: vi.fn(),
      terminalHeight: 30,
      terminalWidth: 80,
      checklistTasks: [],
      agentRef: { current: { abort, isAgentRunning: () => true } },
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
    return { ctx, abort };
  }

  it.each(["chat", "history", "checklist", "procs", "superagents", "subagents"])(
    "interrupts a running agent before Escape is swallowed by %s focus",
    (focusMode) => {
      const { ctx, abort } = singleAgentContext({ focusMode });
      useKeyboardHandler(ctx as any);

      callbacks[0]("\x1b", { escape: false });

      expect(abort).toHaveBeenCalledTimes(1);
      expect(ctx.setIsProcessing).toHaveBeenCalledWith(false);
      expect(ctx.setIsExecutingTool).toHaveBeenCalledWith(false);
      expect(ctx.setFocusMode).toHaveBeenCalledWith("input");
      expect(ctx.setScrollOffset).toHaveBeenCalledWith(0);
      expect(ctx.addLine).toHaveBeenCalledWith(expect.objectContaining({
        content: expect.stringContaining("Esc"),
      }));
    },
  );

  it("interrupts an agent even with a response expanded", () => {
    const { ctx, abort } = singleAgentContext({ focusedResponseIndex: 0 });
    useKeyboardHandler(ctx as any);
    callbacks[0]("", { escape: true });

    expect(abort).toHaveBeenCalledTimes(1);
    expect(ctx.setFocusedResponseIndex).toHaveBeenCalledWith(null);
    expect(ctx.setFocusedResponseOffset).toHaveBeenCalledWith(0);
  });

  it("keeps idle Escape as focus navigation without aborting", () => {
    const { ctx, abort } = singleAgentContext({
      isProcessing: false,
      isExecutingTool: false,
      focusMode: "history",
      agentRef: { current: { abort: vi.fn(), isAgentRunning: () => false } },
    });
    useKeyboardHandler(ctx as any);
    callbacks[0]("", { escape: true });

    expect(ctx.setFocusMode).toHaveBeenCalledWith("input");
    expect(abort).not.toHaveBeenCalled();
    expect(ctx.setIsProcessing).not.toHaveBeenCalled();
  });

  it("dashboard ESC clears processing state when no agent count is reported", () => {
    const setIsProcessing = vi.fn();
    const setCurrentTask = vi.fn();
    const stopAllRunningAgents = vi.fn().mockReturnValue(0);
    useDashboardKeyboard({
      activeWizard: null,
      query: "",
      isProcessing: true,
      setIsProcessing,
      setCurrentTask,
      stopAllRunningAgents,
      pastePrefixLength: 0,
      pasteSuffixLength: 0,
      isPasted: false,
    } as any);

    callbacks[0]("", { escape: true });
    expect(stopAllRunningAgents).toHaveBeenCalledTimes(1);
    expect(setIsProcessing).toHaveBeenCalledWith(false);
    expect(setCurrentTask).toHaveBeenCalledWith("Idle - Interrupted");
  });
});

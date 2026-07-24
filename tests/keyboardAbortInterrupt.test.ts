import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as reactModule from "react";
import * as inkModule from "ink";

let inputCallbacks: any[] = [];

import { useKeyboardHandler } from "../src/hooks/useKeyboardHandler.js";

describe("Keyboard Abort Interrupt Tests", () => {
  beforeEach(() => {
    inputCallbacks = [];
    vi.restoreAllMocks();
    vi.spyOn(inkModule, "useApp").mockReturnValue({ exit: vi.fn() });
    vi.spyOn(inkModule, "useInput").mockImplementation((cb: any) => {
      inputCallbacks.push(cb);
    });
    vi.spyOn(reactModule, "useRef").mockImplementation((val: any) => ({ current: val }));
    vi.spyOn(reactModule, "useCallback").mockImplementation((fn: any) => fn);
    vi.spyOn(reactModule, "useState").mockImplementation((initial: any) => [initial, vi.fn()]);
    vi.spyOn(reactModule, "useEffect").mockImplementation(vi.fn());
    vi.spyOn(reactModule, "createElement").mockImplementation(vi.fn());

    vi.spyOn(reactModule.default, "useRef").mockImplementation((val: any) => ({ current: val }));
    vi.spyOn(reactModule.default, "useCallback").mockImplementation((fn: any) => fn);
    vi.spyOn(reactModule.default, "useState").mockImplementation((initial: any) => [initial, vi.fn()]);
    vi.spyOn(reactModule.default, "useEffect").mockImplementation(vi.fn());
    vi.spyOn(reactModule.default, "createElement").mockImplementation(vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should call agent.abort() and set isProcessing to false when ESC is pressed during processing", () => {
    let isProcessing = true;
    const setIsProcessingMock = vi.fn((val) => { isProcessing = val; });
    const abortMock = vi.fn();
    const agentRef = {
      current: {
        abort: abortMock,
        isAgentRunning: () => true,
        wasRunningBeforeAbort: false,
      }
    };

    useKeyboardHandler({
      input: "",
      setInput: vi.fn(),
      isProcessing,
      setIsProcessing: setIsProcessingMock,
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
      lines: [],
      setLines: vi.fn(),
      addLine: vi.fn(),
      history: [],
      setHistory: vi.fn(),
      historyIndex: -1,
      setHistoryIndex: vi.fn(),
      tempInput: "",
      setTempInput: vi.fn(),
      scrollOffset: 0,
      setScrollOffset: vi.fn(),
      focusedResponseIndex: null,
      setFocusedResponseIndex: vi.fn(),
      focusedResponseOffset: 0,
      setFocusedResponseOffset: vi.fn(),
      planState: "APPROVED",
      setPlanState: vi.fn(),
      focusMode: "input",
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
      terminalHeight: 30,
      terminalWidth: 80,
      checklistTasks: [],
      agentRef,
      pendingPermission: null,
      setPendingPermission: vi.fn(),
      pendingQuestion: null,
      setPendingQuestion: vi.fn(),
      handleWizardSubmit: vi.fn(),
      handleSubmit: vi.fn(),
      handlePermissionResponse: vi.fn(),
      openLatestTruncatedResponse: vi.fn(),
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
      suggestions: [],
    } as any);

    expect(inputCallbacks.length).toBeGreaterThan(0);

    // Trigger ESC
    for (const cb of inputCallbacks) {
      cb("", { escape: true } as any);
    }

    expect(abortMock).toHaveBeenCalled();
    expect(setIsProcessingMock).toHaveBeenCalledWith(false);
  });

  it("should call agent.abort() and set isProcessing to false when Ctrl+C is pressed during processing", () => {
    let isProcessing = true;
    const setIsProcessingMock = vi.fn((val) => { isProcessing = val; });
    const abortMock = vi.fn();
    const agentRef = {
      current: {
        abort: abortMock,
        isAgentRunning: () => true,
        wasRunningBeforeAbort: false,
      }
    };

    useKeyboardHandler({
      input: "",
      setInput: vi.fn(),
      isProcessing,
      setIsProcessing: setIsProcessingMock,
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
      lines: [],
      setLines: vi.fn(),
      addLine: vi.fn(),
      history: [],
      setHistory: vi.fn(),
      historyIndex: -1,
      setHistoryIndex: vi.fn(),
      tempInput: "",
      setTempInput: vi.fn(),
      scrollOffset: 0,
      setScrollOffset: vi.fn(),
      focusedResponseIndex: null,
      setFocusedResponseIndex: vi.fn(),
      focusedResponseOffset: 0,
      setFocusedResponseOffset: vi.fn(),
      planState: "APPROVED",
      setPlanState: vi.fn(),
      focusMode: "input",
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
      terminalHeight: 30,
      terminalWidth: 80,
      checklistTasks: [],
      agentRef,
      pendingPermission: null,
      setPendingPermission: vi.fn(),
      pendingQuestion: null,
      setPendingQuestion: vi.fn(),
      handleWizardSubmit: vi.fn(),
      handleSubmit: vi.fn(),
      handlePermissionResponse: vi.fn(),
      openLatestTruncatedResponse: vi.fn(),
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
      suggestions: [],
    } as any);

    expect(inputCallbacks.length).toBeGreaterThan(0);

    // Trigger Ctrl+C
    for (const cb of inputCallbacks) {
      cb("c", { ctrl: true } as any);
    }

    expect(abortMock).toHaveBeenCalled();
    expect(setIsProcessingMock).toHaveBeenCalledWith(false);
  });
});

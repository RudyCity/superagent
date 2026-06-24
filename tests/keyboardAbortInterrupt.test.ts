import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import { render } from "ink";
import { Console } from "node:console";
import { useKeyboardHandler } from "../src/hooks/useKeyboardHandler.js";

if (!console.Console) {
  console.Console = Console;
}

let inputCallbacks: any[] = [];
vi.mock("ink", async (importOriginal) => {
  const original = await importOriginal<typeof import("ink")>();
  return {
    ...original,
    useApp: () => ({ exit: vi.fn() }),
    useInput: vi.fn((cb) => {
      inputCallbacks.push(cb);
    }),
  };
});

describe("Keyboard Abort Interrupt Tests", () => {
  beforeEach(() => {
    inputCallbacks = [];
    vi.clearAllMocks();
  });

  it("should call agent.abort() and set isProcessing to false when ESC is pressed during processing", async () => {
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

    const TestComponent = () => {
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
      return null;
    };

    const { unmount } = render(React.createElement(TestComponent));

    expect(inputCallbacks.length).toBeGreaterThan(0);

    // Trigger ESC
    for (const cb of inputCallbacks) {
      cb("", { escape: true } as any);
    }

    expect(abortMock).toHaveBeenCalled();
    expect(setIsProcessingMock).toHaveBeenCalledWith(false);

    unmount();
  });

  it("should call agent.abort() and set isProcessing to false when Ctrl+C is pressed during processing", async () => {
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

    const TestComponent = () => {
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
      return null;
    };

    const { unmount } = render(React.createElement(TestComponent));

    expect(inputCallbacks.length).toBeGreaterThan(0);

    // Trigger Ctrl+C
    for (const cb of inputCallbacks) {
      cb("c", { ctrl: true } as any);
    }

    expect(abortMock).toHaveBeenCalled();
    expect(setIsProcessingMock).toHaveBeenCalledWith(false);

    unmount();
  });
});

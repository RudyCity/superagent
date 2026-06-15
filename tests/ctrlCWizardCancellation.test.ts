import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import { render } from "ink";
import { Console } from "node:console";
import { useKeyboardHandler } from "../src/hooks/useKeyboardHandler.js";
import { useDashboardKeyboard } from "../src/hooks/useDashboardKeyboard.js";

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

describe("Ctrl+C Wizard Cancellation Tests", () => {
  beforeEach(() => {
    inputCallbacks = [];
    vi.clearAllMocks();
  });

  it("should cancel active wizard in useKeyboardHandler on Ctrl+C and not call exit", async () => {
    let activeWizard: any = { type: "model", step: 1, data: {} };
    let wizardOptions: string[] = ["1. Load/Apply Model Preset", "< Back"];
    let wizardSelectedIndex = 0;
    const addedLines: any[] = [];
    const exitMock = vi.fn();

    const TestComponent = () => {
      useKeyboardHandler({
        activeWizard,
        setActiveWizard: (w: any) => { activeWizard = w; },
        setWizardOptions: (opts: string[]) => { wizardOptions = opts; },
        setWizardSelectedIndex: (idx: number) => { wizardSelectedIndex = idx; },
        wizardOptions,
        wizardSelectedIndex,
        setInput: vi.fn(),
        addLine: (l: any) => { addedLines.push(l); },
        focusedResponseIndex: null,
        focusMode: "input",
        scrollOffset: 0,
        focusedResponseOffset: 0,
        exit: exitMock,
      } as any);
      return null;
    };
    const { unmount } = render(React.createElement(TestComponent));

    expect(inputCallbacks.length).toBeGreaterThan(0);

    // Trigger Ctrl+C
    for (const cb of inputCallbacks) {
      cb("c", { ctrl: true } as any);
    }

    expect(activeWizard).toBeNull();
    expect(wizardOptions).toEqual([]);
    expect(wizardSelectedIndex).toBe(0);
    expect(exitMock).not.toHaveBeenCalled();
    expect(addedLines.some(l => l.content === "Wizard cancelled.")).toBe(true);

    unmount();
  });

  it("should cancel active wizard in useDashboardKeyboard on Ctrl+C and not call exit", async () => {
    let activeWizard: any = { type: "model", step: 1, data: {} };
    let wizardOptions: string[] = ["1. Load/Apply Model Preset", "< Back"];
    let wizardSelectedIndex = 0;
    const exitMock = vi.fn();
    const setMasterLogsMock = vi.fn();

    const TestComponent = () => {
      useDashboardKeyboard({
        activeWizard,
        setActiveWizard: (w: any) => { activeWizard = w; },
        setWizardOptions: (opts: string[]) => { wizardOptions = opts; },
        setWizardSelectedIndex: (idx: number) => { wizardSelectedIndex = idx; },
        wizardOptions,
        wizardSelectedIndex,
        wizardSelectedSet: new Set(),
        setWizardSelectedSet: vi.fn(),
        setWizardAllOptions: vi.fn(),
        setWizardIsLoadingModels: vi.fn(),
        setQuery: vi.fn(),
        exit: exitMock,
        setMasterLogs: setMasterLogsMock,
        stopAllRunningAgents: vi.fn().mockReturnValue(0),
        setCurrentTask: vi.fn(),
        setIsHistoryTruncated: vi.fn(),
        query: "",
        pastePrefixLength: 0,
        pasteSuffixLength: 0,
        isPasted: false,
        setIsPasted: vi.fn(),
        handleQuerySubmit: vi.fn(),
        focusArea: "input",
        setFocusArea: vi.fn(),
        setLogScrollOffset: vi.fn(),
        history: [],
        historyIndex: -1,
        setHistoryIndex: vi.fn(),
        tempInput: "",
        setTempInput: vi.fn(),
        wizardAllOptions: [],
        pendingQuestion: null,
        setPendingQuestion: vi.fn(),
        suggestions: [],
        planState: "IDLE",
        checklistTasks: [],
        runningSubagentsCount: 0,
        runningTasksCount: 0,
        setSelectedIndex: vi.fn(),
        sessions: [],
        selectedIndex: 0,
        wrappedLines: [],
        logsCount: 0,
        setChecklistScrollOffset: vi.fn(),
        maxChecklistVisible: 5,
        setAgentsScrollOffset: vi.fn(),
        maxAgentsVisible: 3,
        setProcsScrollOffset: vi.fn(),
        maxProcsVisible: 5,
        isProcessing: false,
        setIsProcessing: vi.fn(),
      } as any);
      return null;
    };
    const { unmount } = render(React.createElement(TestComponent));

    expect(inputCallbacks.length).toBeGreaterThan(0);

    // Trigger Ctrl+C
    for (const cb of inputCallbacks) {
      cb("c", { ctrl: true } as any);
    }

    expect(activeWizard).toBeNull();
    expect(wizardOptions).toEqual([]);
    expect(wizardSelectedIndex).toBe(0);
    expect(exitMock).not.toHaveBeenCalled();
    expect(setMasterLogsMock).toHaveBeenCalled();

    unmount();
  });
});

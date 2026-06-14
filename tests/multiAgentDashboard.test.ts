import { describe, it, expect, vi } from "vitest";
import React from "react";
import { render } from "ink";
import { Console } from "node:console";
import { MultiAgentDashboard } from "../src/components/multi-agent-dashboard.js";

// Restore console.Console if Vitest mocked or removed it
if (!console.Console) {
  console.Console = Console;
}

let inputCallback: any = null;

// Mock useApp and useInput from ink
vi.mock("ink", async (importOriginal) => {
  const original = await importOriginal<typeof import("ink")>();
  return {
    ...original,
    useApp: () => ({ exit: vi.fn() }),
    useInput: vi.fn((cb) => {
      inputCallback = cb;
    }),
  };
});

describe("MultiAgentDashboard UI Component", () => {
  it("should instantiate the dashboard React element successfully", () => {
    const mockAgent = { sendMessage: vi.fn().mockResolvedValue(undefined) };
    const element = React.createElement(MultiAgentDashboard, {
      agent: mockAgent as any,
      registerLogHandler: vi.fn(),
    });
    expect(element).toBeDefined();
    expect(element.type).toBe(MultiAgentDashboard);
  });

  it("should toggle history truncation on Ctrl+T keypress", () => {
    const mockAgent = {
      sendMessage: vi.fn().mockResolvedValue(undefined),
      getHistory: () => ({ getMessages: () => [] }),
      getCurrentHistoryFilePath: () => "mock-history-path",
      getPlanFilePath: () => "mock-plan-path",
      getTaskFilePath: () => "mock-task-path",
      isAgentRunning: vi.fn().mockReturnValue(false),
    };

    const { unmount } = render(
      React.createElement(MultiAgentDashboard, {
        agent: mockAgent as any,
        registerLogHandler: vi.fn(),
      })
    );

    // Verify useInput registered the callback
    expect(inputCallback).toBeDefined();
    expect(typeof inputCallback).toBe("function");

    // Call inputCallback with Ctrl+T keypress
    expect(() => {
      inputCallback("t", { ctrl: true });
    }).not.toThrow();

    unmount();
  });

  it("should trigger handleQuerySubmit when Enter key is pressed while activeWizard is active", async () => {
    // Import useDashboardKeyboard
    const { useDashboardKeyboard } = await import("../src/hooks/useDashboardKeyboard.js");
    const mockHandleQuerySubmit = vi.fn();
    const TestComponent = () => {
      useDashboardKeyboard({
        activeWizard: { type: "model", step: 2, data: {} },
        setActiveWizard: vi.fn(),
        setWizardSelectedIndex: vi.fn(),
        wizardOptions: ["Option 1", "Option 2"],
        wizardSelectedIndex: 0,
        handleQuerySubmit: mockHandleQuerySubmit,
        query: "",
      } as any);
      return null;
    };

    const { unmount } = render(React.createElement(TestComponent));

    expect(inputCallback).toBeDefined();
    expect(typeof inputCallback).toBe("function");

    // Trigger Enter (return) keypress
    inputCallback("\r", { return: true });

    expect(mockHandleQuerySubmit).toHaveBeenCalledWith("");
    unmount();
  });

  it("should abort processing and stop running agents on Ctrl+C", async () => {
    const { useDashboardKeyboard } = await import("../src/hooks/useDashboardKeyboard.js");
    const mockStopAllRunningAgents = vi.fn().mockReturnValue(1);
    const mockSetIsProcessing = vi.fn();
    const mockSetCurrentTask = vi.fn();

    const TestComponent = () => {
      useDashboardKeyboard({
        isProcessing: true,
        setIsProcessing: mockSetIsProcessing,
        stopAllRunningAgents: mockStopAllRunningAgents,
        setCurrentTask: mockSetCurrentTask,
        exit: vi.fn(),
        query: "",
        setQuery: vi.fn(),
      } as any);
      return null;
    };

    const { unmount } = render(React.createElement(TestComponent));

    expect(inputCallback).toBeDefined();
    expect(typeof inputCallback).toBe("function");

    // Press Ctrl+C
    inputCallback("c", { ctrl: true });

    expect(mockStopAllRunningAgents).toHaveBeenCalled();
    expect(mockSetIsProcessing).toHaveBeenCalledWith(false);
    expect(mockSetCurrentTask).toHaveBeenCalledWith("Idle - Interrupted");

    unmount();
  });

  it("should focus agents or procs on mouse click", async () => {
    const { useDashboardMouse } = await import("../src/hooks/useDashboardMouse.js");

    const originalOn = process.stdin.on;
    const originalOff = process.stdin.off;
    const originalWrite = process.stdout.write;

    let mouseHandler: any = null;
    process.stdin.on = vi.fn((event, cb) => {
      if (event === "data") mouseHandler = cb;
      return process.stdin;
    }) as any;
    process.stdin.off = vi.fn() as any;
    process.stdout.write = vi.fn() as any;

    const mockSetFocusArea = vi.fn();

    const { subagentInstances, backgroundTasks } = await import("../src/core/tools/state.js");
    subagentInstances.clear();
    backgroundTasks.clear();

    subagentInstances.set("agent-1", { id: "agent-1", status: "running", role: "researcher", logs: [] });
    backgroundTasks.set("task-1", { id: "task-1", hasExited: false, command: "sleep 10" });

    const TestComponent = () => {
      useDashboardMouse({
        wrappedLines: [],
        logsCount: 10,
        terminalSize: { width: 100, height: 40 },
        activeWizard: null,
        setActiveWizard: vi.fn(),
        wizardOptions: [],
        wizardSelectedIndex: 0,
        setWizardSelectedIndex: vi.fn(),
        wizardSelectedSet: new Set(),
        setWizardSelectedSet: vi.fn(),
        setWizardOptions: vi.fn(),
        pendingQuestion: null,
        handleWizardSubmit: vi.fn(),
        query: "",
        setQuery: vi.fn(),
        wizardAllOptions: [],
        workspaceHeight: 15,
        leftTopHeight: 10,
        wizardIsLoadingModels: false,
        agent: null,
        focusArea: "input",
        setFocusArea: mockSetFocusArea,
        setLogScrollOffset: vi.fn(),
      } as any);
      return null;
    };

    const { unmount } = render(React.createElement(TestComponent));

    // Wait for useEffect to register stdin listener
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mouseHandler).toBeDefined();

    // Click on agents (y = 22)
    mouseHandler(Buffer.from("\x1b[<0;10;22M"));
    expect(mockSetFocusArea).toHaveBeenCalledWith("agents");

    // Click on procs (y = 24)
    mouseHandler(Buffer.from("\x1b[<0;10;24M"));
    expect(mockSetFocusArea).toHaveBeenCalledWith("procs");

    unmount();

    process.stdin.on = originalOn;
    process.stdin.off = originalOff;
    process.stdout.write = originalWrite;

    subagentInstances.clear();
    backgroundTasks.clear();
  });

  it("should select wizard option on first click and submit on second click", async () => {
    const { useDashboardMouse } = await import("../src/hooks/useDashboardMouse.js");

    const originalOn = process.stdin.on;
    const originalOff = process.stdin.off;
    const originalWrite = process.stdout.write;

    let mouseHandler: any = null;
    process.stdin.on = vi.fn((event, cb) => {
      if (event === "data") mouseHandler = cb;
      return process.stdin;
    }) as any;
    process.stdin.off = vi.fn() as any;
    process.stdout.write = vi.fn() as any;

    const mockHandleWizardSubmit = vi.fn();
    const mockSetWizardSelectedIndex = vi.fn();

    // Context for first click (unselected option)
    const TestComponentUnselected = () => {
      useDashboardMouse({
        wrappedLines: [],
        logsCount: 10,
        terminalSize: { width: 100, height: 40 },
        activeWizard: { type: "login", step: 10, data: {} },
        setActiveWizard: vi.fn(),
        wizardOptions: ["Option 1", "Option 2"],
        wizardSelectedIndex: 0, // Option 1 selected
        setWizardSelectedIndex: mockSetWizardSelectedIndex,
        wizardSelectedSet: new Set(),
        setWizardSelectedSet: vi.fn(),
        setWizardOptions: vi.fn(),
        pendingQuestion: null,
        handleWizardSubmit: mockHandleWizardSubmit,
        query: "",
        setQuery: vi.fn(),
        wizardAllOptions: [],
        workspaceHeight: 15,
        leftTopHeight: 10,
        wizardIsLoadingModels: false,
        agent: null,
        focusArea: "input",
        setFocusArea: vi.fn(),
        setLogScrollOffset: vi.fn(),
      } as any);
      return null;
    };

    const { unmount: unmount1 } = render(React.createElement(TestComponentUnselected));
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Click on Option 2 (y = 26), which is currently unselected
    mouseHandler(Buffer.from("\x1b[<0;10;26M"));
    expect(mockSetWizardSelectedIndex).toHaveBeenCalledWith(1);
    expect(mockHandleWizardSubmit).not.toHaveBeenCalled();

    unmount1();

    // Context for second click (already selected option)
    const TestComponentSelected = () => {
      useDashboardMouse({
        wrappedLines: [],
        logsCount: 10,
        terminalSize: { width: 100, height: 40 },
        activeWizard: { type: "login", step: 10, data: {} },
        setActiveWizard: vi.fn(),
        wizardOptions: ["Option 1", "Option 2"],
        wizardSelectedIndex: 1, // Option 2 already selected
        setWizardSelectedIndex: mockSetWizardSelectedIndex,
        wizardSelectedSet: new Set(),
        setWizardSelectedSet: vi.fn(),
        setWizardOptions: vi.fn(),
        pendingQuestion: null,
        handleWizardSubmit: mockHandleWizardSubmit,
        query: "",
        setQuery: vi.fn(),
        wizardAllOptions: [],
        workspaceHeight: 15,
        leftTopHeight: 10,
        wizardIsLoadingModels: false,
        agent: null,
        focusArea: "input",
        setFocusArea: vi.fn(),
        setLogScrollOffset: vi.fn(),
      } as any);
      return null;
    };

    const { unmount: unmount2 } = render(React.createElement(TestComponentSelected));
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Click on Option 2 (y = 26), which is already selected
    mouseHandler(Buffer.from("\x1b[<0;10;26M"));
    expect(mockHandleWizardSubmit).toHaveBeenCalledWith("Option 2");

    unmount2();

    process.stdin.on = originalOn;
    process.stdin.off = originalOff;
    process.stdout.write = originalWrite;
  });

  it("should focus input area and select suggestion on click", async () => {
    const { useDashboardMouse } = await import("../src/hooks/useDashboardMouse.js");

    const originalOn = process.stdin.on;
    const originalOff = process.stdin.off;
    const originalWrite = process.stdout.write;

    let mouseHandler: any = null;
    process.stdin.on = vi.fn((event, cb) => {
      if (event === "data") mouseHandler = cb;
      return process.stdin;
    }) as any;
    process.stdin.off = vi.fn() as any;
    process.stdout.write = vi.fn() as any;

    const mockSetFocusArea = vi.fn();
    const mockSetQuery = vi.fn();

    const TestComponent = () => {
      useDashboardMouse({
        wrappedLines: [],
        logsCount: 10,
        terminalSize: { width: 100, height: 40 },
        activeWizard: null,
        setActiveWizard: vi.fn(),
        wizardOptions: [],
        wizardSelectedIndex: 0,
        setWizardSelectedIndex: vi.fn(),
        wizardSelectedSet: new Set(),
        setWizardSelectedSet: vi.fn(),
        setWizardOptions: vi.fn(),
        pendingQuestion: null,
        handleWizardSubmit: vi.fn(),
        query: "/he",
        setQuery: mockSetQuery,
        wizardAllOptions: [],
        workspaceHeight: 15,
        leftTopHeight: 10,
        wizardIsLoadingModels: false,
        agent: null,
        focusArea: "input",
        setFocusArea: mockSetFocusArea,
        setLogScrollOffset: vi.fn(),
      } as any);
      return null;
    };

    const { unmount } = render(React.createElement(TestComponent));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mouseHandler).toBeDefined();

    // Click on suggestion:
    // With query "/he", suggestions contains "/help".
    // promptStartRow = height (40) - statusBarHeight (5) - bottomPromptHeight (3) + 1 = 33
    // So the suggestions row is y = 33.
    // "/help" starts at col 18, length is 5, so columns 18-22.
    // Let's click at x = 19, y = 33
    mouseHandler(Buffer.from("\x1b[<0;19;33M"));
    expect(mockSetFocusArea).toHaveBeenCalledWith("input");
    expect(mockSetQuery).toHaveBeenCalledWith("/help");

    // Click on footer:
    // footer starts at y = terminalSize.height - statusBarHeight + 1 = 36.
    // Let's click at x = 10, y = 38 (footer area)
    mockSetFocusArea.mockClear();
    mouseHandler(Buffer.from("\x1b[<0;10;38M"));
    expect(mockSetFocusArea).toHaveBeenCalledWith("input");

    unmount();

    process.stdin.on = originalOn;
    process.stdin.off = originalOff;
    process.stdout.write = originalWrite;
  });
});


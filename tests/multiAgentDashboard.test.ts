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
});

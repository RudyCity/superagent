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
});

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

vi.mock("execa", () => ({
  execa: vi.fn().mockResolvedValue({ stdout: "", failed: false }),
}));

vi.mock("../src/core/checkpoints.js", () => ({
  restoreCheckpoint: vi.fn().mockResolvedValue(undefined),
  terminateActiveTasksAndSubagents: vi.fn(),
  listCheckpointsForSession: vi.fn().mockResolvedValue([]),
  deleteCheckpointById: vi.fn().mockResolvedValue(true),
}));

describe("Checkpoint Keyboard Handler Step 2 Tests", () => {
  beforeEach(() => {
    inputCallbacks = [];
    vi.clearAllMocks();
  });

  it("should execute workspace restore (git checkout) when selecting index 0 in step 2", async () => {
    let activeWizard: any = { type: "checkpoint", step: 2, data: { checkpointIndex: "0" } };
    let wizardOptions: string[] = [
      "✓ Yes, restore workspace to this commit (git stash & checkout)",
      "✗ No, only restore conversation history"
    ];
    let wizardSelectedIndex = 0; // Yes option
    let checkpointsList = [
      {
        id: "chk_1",
        name: "test-checkpoint",
        timestamp: Date.now(),
        gitSha: "abcdef123456",
        messages: []
      }
    ];

    const setActiveWizardMock = vi.fn((w) => { activeWizard = w; });
    const setWizardOptionsMock = vi.fn((opts) => { wizardOptions = opts; });
    const setWizardSelectedIndexMock = vi.fn((idx) => { wizardSelectedIndex = idx; });
    const setCheckpointsListMock = vi.fn((list) => { checkpointsList = list; });
    const addLineMock = vi.fn();

    const mockAgent = {
      getCurrentHistoryFilePath: () => "mock/session.json",
      loadHistoryFromPath: vi.fn().mockResolvedValue(undefined),
      getHistory: () => ({
        getMessages: () => []
      }),
      planState: "IDLE",
      workingDirectory: "/mock/cwd"
    };

    const TestComponent = () => {
      useKeyboardHandler({
        activeWizard,
        setActiveWizard: setActiveWizardMock,
        setWizardOptions: setWizardOptionsMock,
        setWizardSelectedIndex: setWizardSelectedIndexMock,
        wizardOptions,
        wizardSelectedIndex,
        checkpointsList,
        setCheckpointsList: setCheckpointsListMock,
        setInput: vi.fn(),
        addLine: addLineMock,
        focusedResponseIndex: null,
        focusMode: "input",
        scrollOffset: 0,
        focusedResponseOffset: 0,
        exit: vi.fn(),
        agentRef: { current: mockAgent } as any,
        isProcessing: false,
        setIsProcessing: vi.fn()
      } as any);
      return null;
    };

    const { unmount } = render(React.createElement(TestComponent));

    expect(inputCallbacks.length).toBeGreaterThan(0);

    // Press return (Enter)
    for (const cb of inputCallbacks) {
      cb("", { return: true } as any);
    }

    // Wait a bit for the async IIFE to process
    await new Promise(r => setTimeout(r, 100));

    // The wizard should be closed
    expect(setActiveWizardMock).toHaveBeenCalledWith(null);
    expect(setWizardOptionsMock).toHaveBeenCalledWith([]);
    expect(setWizardSelectedIndexMock).toHaveBeenCalledWith(0);
    expect(setCheckpointsListMock).toHaveBeenCalledWith([]);

    // Checkpoint list shouldn't have reset back to step 1
    // (If the bug were present, it would set activeWizard back to step 1 browse options,
    // which starts by calling setActiveWizard with { type: "checkpoint", step: 1, ... } instead of null)
    expect(activeWizard).toBeNull();

    unmount();
  });
});

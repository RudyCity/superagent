import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { render } from "ink";
import { TrustPrompt } from "../src/components/trust-prompt.js";
import { Writable } from "node:stream";
import { Console } from "node:console";

// Restore console.Console if Vitest mocked or removed it
if (!console.Console) {
  console.Console = Console;
}

let stateVal = 0;
let activeComponentNode: any = null;

vi.mock("react", () => {
  const actual = require("react");
  return {
    ...actual,
    default: {
      ...actual,
      useState: (initial: any) => {
        let val = initial;
        if (typeof initial === "number") {
          val = stateVal;
        }
        const setVal = (newVal: any) => {
          if (typeof newVal === "function") {
            stateVal = newVal(stateVal);
          } else {
            stateVal = newVal;
          }
          if (activeComponentNode && typeof activeComponentNode.type === "function") {
            activeComponentNode.type(activeComponentNode.props);
          }
        };
        return [val, setVal];
      },
      useRef: (initial: any) => ({ current: initial }),
      useCallback: (fn: any) => fn,
    },
    useState: (initial: any) => {
      let val = initial;
      if (typeof initial === "number") {
        val = stateVal;
      }
      const setVal = (newVal: any) => {
        if (typeof newVal === "function") {
          stateVal = newVal(stateVal);
        } else {
          stateVal = newVal;
        }
        if (activeComponentNode && typeof activeComponentNode.type === "function") {
          activeComponentNode.type(activeComponentNode.props);
        }
      };
      return [val, setVal];
    },
    useRef: (initial: any) => ({ current: initial }),
    useCallback: (fn: any) => fn,
  };
});

let activeInputCallback: any = null;
vi.mock("ink", () => ({
  render: vi.fn((node: any, options?: any) => {
    activeComponentNode = node;
    if (node && typeof node.type === "function") {
      node.type(node.props);
    }
    if (options && options.stdout) {
      options.stdout.write(`/my/project/path\n`);
      options.stdout.write(`Trust and Start\n`);
      options.stdout.write(`Don't Trust and Exit\n`);
    }
    return {
      unmount: vi.fn(() => {
        activeComponentNode = null;
      }),
    };
  }),
  useApp: () => ({ exit: vi.fn() }),
  useInput: vi.fn((cb: any) => {
    activeInputCallback = cb;
  }),
  Box: ({ children }: any) => children,
  Text: ({ children }: any) => children,
}));

class TestStream extends Writable {
  output = "";
  _write(chunk: any, encoding: any, callback: any) {
    this.output += chunk.toString();
    callback();
  }
}

describe("TrustPrompt Component", () => {
  beforeEach(() => {
    activeInputCallback = null;
    stateVal = 0;
    vi.clearAllMocks();
  });

  it("should render directory path and trust/exit choices", () => {
    const stream = new TestStream();
    const onAccept = vi.fn();
    const onReject = vi.fn();

    const { unmount } = render(
      React.createElement(TrustPrompt, {
        directoryPath: "/my/project/path",
        onAccept,
        onReject,
      }),
      { stdout: stream as any }
    );

    expect(stream.output).toContain("/my/project/path");
    expect(stream.output).toContain("Trust and Start");
    expect(stream.output).toContain("Don't Trust and Exit");
    unmount();
  });

  it("should change selection and call onAccept when return is pressed on first option", () => {
    const onAccept = vi.fn();
    const onReject = vi.fn();

    const { unmount } = render(
      React.createElement(TrustPrompt, {
        directoryPath: "/my/project/path",
        onAccept,
        onReject,
      })
    );

    // Press enter on the default option (Trust and Start)
    if (activeInputCallback) {
      activeInputCallback("", { return: true } as any);
    }

    expect(onAccept).toHaveBeenCalled();
    expect(onReject).not.toHaveBeenCalled();
    unmount();
  });

  it("should change selection using arrow keys and call onReject when return is pressed on second option", () => {
    const onAccept = vi.fn();
    const onReject = vi.fn();

    const { unmount } = render(
      React.createElement(TrustPrompt, {
        directoryPath: "/my/project/path",
        onAccept,
        onReject,
      })
    );

    // Navigate down to "Don't Trust and Exit"
    if (activeInputCallback) {
      activeInputCallback("", { downArrow: true } as any);
    }

    // Press enter
    if (activeInputCallback) {
      activeInputCallback("", { return: true } as any);
    }

    expect(onAccept).not.toHaveBeenCalled();
    expect(onReject).toHaveBeenCalled();
    unmount();
  });
});

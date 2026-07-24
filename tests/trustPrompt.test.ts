import { describe, it, expect, vi, beforeEach } from "vitest";
import * as reactModule from "react";
import * as inkModule from "ink";
import { TrustPrompt } from "../src/components/trust-prompt.js";
import { Writable } from "node:stream";
import { Console } from "node:console";

// Restore console.Console if Vitest mocked or removed it
if (!console.Console) {
  console.Console = Console;
}

let stateVal = 0;
let activeComponentNode: any = null;
let activeInputCallback: any = null;

const render = (node: any, options?: any) => {
  return inkModule.render(node, options);
};

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
    activeComponentNode = null;
    vi.restoreAllMocks();

    vi.spyOn(reactModule, "useRef").mockImplementation((initial: any) => ({ current: initial }));
    vi.spyOn(reactModule, "useCallback").mockImplementation((fn: any) => fn);
    vi.spyOn(reactModule, "useState").mockImplementation((initial: any) => {
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
    });

    vi.spyOn(reactModule.default, "useRef").mockImplementation((initial: any) => ({ current: initial }));
    vi.spyOn(reactModule.default, "useCallback").mockImplementation((fn: any) => fn);
    vi.spyOn(reactModule.default, "useState").mockImplementation((initial: any) => {
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
    });

    vi.spyOn(inkModule, "useApp").mockReturnValue({ exit: vi.fn() });
    vi.spyOn(inkModule, "useInput").mockImplementation((cb: any) => {
      activeInputCallback = cb;
    });
    vi.spyOn(inkModule, "render").mockImplementation(((node: any, options?: any) => {
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
    }) as any);
  });

  it("should render directory path and trust/exit choices", () => {
    const stream = new TestStream();
    const onAccept = vi.fn();
    const onReject = vi.fn();

    const { unmount } = render(
      reactModule.createElement(TrustPrompt, {
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

  it("should select Trust and call onAccept when pressing Enter", () => {
    const onAccept = vi.fn();
    const onReject = vi.fn();

    const { unmount } = render(
      reactModule.createElement(TrustPrompt, {
        directoryPath: "/my/project/path",
        onAccept,
        onReject,
      })
    );

    expect(activeInputCallback).not.toBeNull();

    // Select Trust (index 0 is selected by default)
    // Press return (Enter)
    activeInputCallback("", { return: true } as any);

    expect(onAccept).toHaveBeenCalled();
    expect(onReject).not.toHaveBeenCalled();
    unmount();
  });

  it("should select Don't Trust and call onReject when pressing Enter after moving down", () => {
    const onAccept = vi.fn();
    const onReject = vi.fn();

    const { unmount } = render(
      reactModule.createElement(TrustPrompt, {
        directoryPath: "/my/project/path",
        onAccept,
        onReject,
      })
    );

    expect(activeInputCallback).not.toBeNull();

    // Press Down to select "Don't Trust" (index 1)
    activeInputCallback("", { downArrow: true } as any);
    // Press return (Enter)
    activeInputCallback("", { return: true } as any);

    expect(onReject).toHaveBeenCalled();
    expect(onAccept).not.toHaveBeenCalled();
    unmount();
  });

  it("should stay on Don't Trust when pressing Down on Don't Trust", () => {
    const onAccept = vi.fn();
    const onReject = vi.fn();

    const { unmount } = render(
      reactModule.createElement(TrustPrompt, {
        directoryPath: "/my/project/path",
        onAccept,
        onReject,
      })
    );

    // Press Down twice
    activeInputCallback("", { downArrow: true } as any);
    activeInputCallback("", { downArrow: true } as any);
    // Press return (Enter)
    activeInputCallback("", { return: true } as any);

    expect(onReject).toHaveBeenCalled();
    expect(onAccept).not.toHaveBeenCalled();
    unmount();
  });

  it("should stay on Trust when pressing Up on Trust", () => {
    const onAccept = vi.fn();
    const onReject = vi.fn();

    const { unmount } = render(
      reactModule.createElement(TrustPrompt, {
        directoryPath: "/my/project/path",
        onAccept,
        onReject,
      })
    );

    // Press Up on Trust
    activeInputCallback("", { upArrow: true } as any);
    // Press return (Enter)
    activeInputCallback("", { return: true } as any);

    expect(onAccept).toHaveBeenCalled();
    expect(onReject).not.toHaveBeenCalled();
    unmount();
  });
});

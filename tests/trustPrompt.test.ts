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

let activeInputCallback: any = null;
vi.mock("ink", async (importOriginal) => {
  const original = await importOriginal<typeof import("ink")>();
  return {
    ...original,
    useInput: vi.fn((cb) => {
      activeInputCallback = cb;
    }),
  };
});

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

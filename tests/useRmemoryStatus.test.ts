import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { render } from "ink";
import { Console } from "node:console";
import { useRmemoryStatus } from "../src/hooks/useRmemoryStatus.js";

if (!console.Console) {
  console.Console = Console;
}

let mockSettings = {
  enableRmemory: false,
  rmemoryGatewayUrl: "http://127.0.0.1:8420",
  rmemoryGatewayApiKey: "sk-xxxx",
  rmemoryServiceId: "default",
  rmemoryPollIntervalMs: 30000,
};

vi.mock("../src/core/config/jsonConfig.js", () => {
  return {
    getSettings: () => mockSettings,
  };
});

describe("useRmemoryStatus Hook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSettings = {
      enableRmemory: false,
      rmemoryGatewayUrl: "http://127.0.0.1:8420",
      rmemoryGatewayApiKey: "sk-xxxx",
      rmemoryServiceId: "default",
      rmemoryPollIntervalMs: 30000,
    };
  });

  const waitForCondition = async (fn: () => boolean, timeout = 1000) => {
    const start = Date.now();
    while (!fn()) {
      if (Date.now() - start > timeout) {
        throw new Error("Timeout waiting for condition in hook test");
      }
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  it("should return online when enableRmemory is true, and disabled when false", async () => {
    let hookStatus = "";
    const TestComponent = () => {
      hookStatus = useRmemoryStatus();
      return null;
    };

    mockSettings.enableRmemory = false;
    let renderResult = render(React.createElement(TestComponent));
    await waitForCondition(() => hookStatus === "disabled");
    expect(hookStatus).toBe("disabled");
    renderResult.unmount();

    mockSettings.enableRmemory = true;
    renderResult = render(React.createElement(TestComponent));
    await waitForCondition(() => hookStatus === "online");
    expect(hookStatus).toBe("online");
    renderResult.unmount();
  });
});

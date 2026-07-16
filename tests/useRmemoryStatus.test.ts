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

  it("should always return disabled", async () => {
    let hookStatus = "";
    const TestComponent = () => {
      hookStatus = useRmemoryStatus();
      return null;
    };

    const { unmount } = render(React.createElement(TestComponent));
    expect(hookStatus).toBe("disabled");

    mockSettings.enableRmemory = true;
    expect(hookStatus).toBe("disabled");
    unmount();
  });
});

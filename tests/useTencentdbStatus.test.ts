import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { render } from "ink";
import { Console } from "node:console";
import { useTencentdbStatus } from "../src/hooks/useTencentdbStatus.js";

if (!console.Console) {
  console.Console = Console;
}



let mockSettings = {
  enableTencentdbMemory: false,
  tencentdbGatewayUrl: "http://127.0.0.1:8420",
  tencentdbGatewayApiKey: "sk-xxxx",
  tencentdbServiceId: "default",
  tencentdbPollIntervalMs: 30000,
};

vi.mock("../src/core/config/jsonConfig.js", () => {
  return {
    getSettings: () => mockSettings,
  };
});

describe("useTencentdbStatus Hook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSettings = {
      enableTencentdbMemory: false,
      tencentdbGatewayUrl: "http://127.0.0.1:8420",
      tencentdbGatewayApiKey: "sk-xxxx",
      tencentdbServiceId: "default",
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
      hookStatus = useTencentdbStatus();
      return null;
    };

    const { unmount } = render(React.createElement(TestComponent));
    expect(hookStatus).toBe("disabled");

    mockSettings.enableTencentdbMemory = true;
    expect(hookStatus).toBe("disabled");
    unmount();
  });
});

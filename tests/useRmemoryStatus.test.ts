import { describe, it, expect, vi, beforeEach, mock, afterAll } from "vitest";
import React from "react";
import { render } from "ink";
import { Console } from "node:console";
import path from "path";

if (!console.Console) {
  console.Console = Console;
}

import * as jsonConfigModule from "../src/core/config/jsonConfig.js";
import * as rmemoryUtilModule from "../src/core/rmemoryUtil.js";

let mockSettings = {
  enableRmemory: false,
  rmemoryGatewayUrl: "http://127.0.0.1:8420",
  rmemoryGatewayApiKey: "sk-xxxx",
  rmemoryServiceId: "default",
  rmemoryPollIntervalMs: 30000,
};

vi.spyOn(jsonConfigModule, "getSettings").mockImplementation(() => mockSettings as any);


import { useRmemoryStatus } from "../src/hooks/useRmemoryStatus.js";

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

  it("distinguishes disabled, uninitialized, healthy and degraded memory indexes", async () => {
    let hookStatus = "";
    const TestComponent = () => {
      hookStatus = useRmemoryStatus();
      return null;
    };

    const health = vi.spyOn(rmemoryUtilModule, "getRMemoryDiagnostics");
    const snapshot = (enabled: boolean, indexReady: boolean, degraded = false) => ({
      enabled, indexReady, degraded, provider: "local" as const,
      modelName: "test-model", dimensions: 384, initializationState: "ready" as const,
      migrationStatus: "current" as const, retryAvailable: degraded, error: null,
    });
    health.mockReturnValue(snapshot(false, false));
    let view = render(React.createElement(TestComponent));
    await waitForCondition(() => hookStatus === "disabled");
    view.unmount();

    health.mockReturnValue(snapshot(true, false));
    view = render(React.createElement(TestComponent));
    await waitForCondition(() => hookStatus === "ready");
    view.unmount();

    health.mockReturnValue(snapshot(true, true));
    view = render(React.createElement(TestComponent));
    await waitForCondition(() => hookStatus === "online");
    view.unmount();

    health.mockReturnValue(snapshot(true, false, true));
    view = render(React.createElement(TestComponent));
    await waitForCondition(() => hookStatus === "offline");
    view.unmount();
  });
});


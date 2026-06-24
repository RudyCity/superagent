import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { render } from "ink";
import { Console } from "node:console";
import { useTencentdbStatus } from "../src/hooks/useTencentdbStatus.js";

if (!console.Console) {
  console.Console = Console;
}

const mockListScenarios = vi.fn();

vi.mock("@tencentdb-agent-memory/memory-sdk-ts", () => {
  class MockMemoryClient {
    listScenarios = mockListScenarios;
  }
  return {
    MemoryClient: MockMemoryClient,
  };
});

let mockSettings = {
  enableTencentdbMemory: false,
  tencentdbGatewayUrl: "http://127.0.0.1:8420",
  tencentdbGatewayApiKey: "sk-xxxx",
  tencentdbServiceId: "default",
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

  it("should return disabled when enableTencentdbMemory is false", async () => {
    let hookStatus = "";
    const TestComponent = () => {
      hookStatus = useTencentdbStatus();
      return null;
    };

    const { unmount } = render(React.createElement(TestComponent));
    expect(hookStatus).toBe("disabled");
    unmount();
  });

  it("should return online when enableTencentdbMemory is true and gateway is online", async () => {
    mockSettings.enableTencentdbMemory = true;
    mockListScenarios.mockResolvedValue({ entries: [] });

    let hookStatus = "";
    const TestComponent = () => {
      hookStatus = useTencentdbStatus();
      return null;
    };

    const { unmount } = render(React.createElement(TestComponent));
    
    // Starts checking
    expect(hookStatus).toBe("checking");

    // Wait for the async checkHealth to complete
    await new Promise((r) => setTimeout(r, 50));
    expect(hookStatus).toBe("online");

    unmount();
  });

  it("should return offline when enableTencentdbMemory is true and gateway ping fails", async () => {
    mockSettings.enableTencentdbMemory = true;
    mockListScenarios.mockRejectedValue(new Error("Connection refused"));

    let hookStatus = "";
    const TestComponent = () => {
      hookStatus = useTencentdbStatus();
      return null;
    };

    const { unmount } = render(React.createElement(TestComponent));
    expect(hookStatus).toBe("checking");

    // Wait for the async checkHealth to complete
    await new Promise((r) => setTimeout(r, 50));
    expect(hookStatus).toBe("offline");

    unmount();
  });
});

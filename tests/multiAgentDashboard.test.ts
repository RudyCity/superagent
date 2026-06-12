import { describe, it, expect, vi } from "vitest";
import React from "react";
import { MultiAgentDashboard } from "../src/components/multi-agent-dashboard.js";

// Mock useApp and useInput from ink
vi.mock("ink", async (importOriginal) => {
  const original = await importOriginal<typeof import("ink")>();
  return {
    ...original,
    useApp: () => ({ exit: vi.fn() }),
    useInput: vi.fn(),
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
});

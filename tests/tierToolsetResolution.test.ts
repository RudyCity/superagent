import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "os";
import path from "path";
import fs from "fs";
import { Agent } from "../src/core/agent.js";
import { streamText } from "ai";
import * as configModule from "../src/core/config.js";
import {
  masterToolset,
  superagentToolset,
  subagentToolsets,
} from "../src/core/tools/toolsets.js";

const tempHome = path.join(process.cwd(), "tests", "temp-home-tier-toolset");
vi.spyOn(os, "homedir").mockReturnValue(tempHome);

// Mock ai SDK synchronously
vi.mock("ai", () => ({
  streamText: vi.fn(),
  generateText: vi.fn(),
  jsonSchema: (s: any) => s,
}));

import * as rmemoryUtilModule from "../src/core/rmemoryUtil.js";

describe("Agent - Tier-Specific Default Toolset Resolution", () => {
  beforeEach(() => {
    if (fs.existsSync(tempHome)) {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.spyOn(rmemoryUtilModule, "getRMemoryClient").mockReturnValue({} as any);
    vi.spyOn(rmemoryUtilModule, "getRMemorySessionKey").mockReturnValue("test-sess");
    vi.spyOn(rmemoryUtilModule, "isRmemoryActive").mockResolvedValue(true);
    // Speed up tests by skipping actual countdown delay
    vi.spyOn(Agent.prototype as any, "delayWithCountdown").mockResolvedValue(undefined);
    // Re-apply config spy after restoreAllMocks
    vi.spyOn(configModule, "getConfig").mockReturnValue({
      provider: "openai",
      model: "gpt-4",
      apiKey: "fake-key",
      disableStreaming: false,
      workingDirectory: process.cwd(),
      systemPrompt: "Base Agent Prompt Content",
    } as any);
  });

  afterEach(() => {
    if (fs.existsSync(tempHome)) {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("should resolve masterToolset for master tier agent", async () => {
    const onEvent = vi.fn();
    const onPermission = vi.fn().mockResolvedValue(true);
    const onQuestion = vi.fn();

    const agent = new Agent(onEvent, onPermission, onQuestion);
    agent.tier = "master";
    agent.planState = "APPROVED";

    let toolsPassed: any[] = [];
    vi.mocked(streamText).mockImplementation(({ tools }: any) => {
      toolsPassed = Object.keys(tools || {});
      return {
        fullStream: (async function* () {
          yield { type: "text-delta", textDelta: "Test finished" };
        })(),
        usage: Promise.resolve({ promptTokens: 10, completionTokens: 10 }),
      } as any;
    });

    await agent.sendMessage("hello");

    const expectedToolNames = masterToolset
      .map((t) => t.name)
      .filter((name) => name !== "manage_workspace_chain" && name !== "cross_workspace_exec");
    expect(toolsPassed).toEqual(expect.arrayContaining(expectedToolNames));
    expect(toolsPassed.length).toBe(expectedToolNames.length);
  });

  it("should resolve superagentToolset for single tier agent", async () => {
    const onEvent = vi.fn();
    const onPermission = vi.fn().mockResolvedValue(true);
    const onQuestion = vi.fn();

    const agent = new Agent(onEvent, onPermission, onQuestion);
    agent.tier = "single";
    agent.planState = "APPROVED";

    let toolsPassed: any[] = [];
    vi.mocked(streamText).mockImplementation(({ tools }: any) => {
      toolsPassed = Object.keys(tools || {});
      return {
        fullStream: (async function* () {
          yield { type: "text-delta", textDelta: "Test finished" };
        })(),
        usage: Promise.resolve({ promptTokens: 10, completionTokens: 10 }),
      } as any;
    });

    await agent.sendMessage("hello");

    const expectedToolNames = superagentToolset
      .map((t) => t.name)
      .filter((name) => name !== "manage_workspace_chain" && name !== "cross_workspace_exec");
    expect(toolsPassed).toEqual(expect.arrayContaining(expectedToolNames));
    expect(toolsPassed.length).toBe(expectedToolNames.length);
  });

  it("should resolve superagentToolset for superagent tier agent", async () => {
    const onEvent = vi.fn();
    const onPermission = vi.fn().mockResolvedValue(true);
    const onQuestion = vi.fn();

    const agent = new Agent(onEvent, onPermission, onQuestion);
    agent.tier = "superagent";
    agent.planState = "APPROVED";

    let toolsPassed: any[] = [];
    vi.mocked(streamText).mockImplementation(({ tools }: any) => {
      toolsPassed = Object.keys(tools || {});
      return {
        fullStream: (async function* () {
          yield { type: "text-delta", textDelta: "Test finished" };
        })(),
        usage: Promise.resolve({ promptTokens: 10, completionTokens: 10 }),
      } as any;
    });

    await agent.sendMessage("hello");

    const expectedToolNames = superagentToolset
      .map((t) => t.name)
      .filter((name) => name !== "manage_workspace_chain" && name !== "cross_workspace_exec");
    expect(toolsPassed).toEqual(expect.arrayContaining(expectedToolNames));
    expect(toolsPassed.length).toBe(expectedToolNames.length);
  });

  it("should resolve specific subagent toolset for subagent tier agent", async () => {
    const onEvent = vi.fn();
    const onPermission = vi.fn().mockResolvedValue(true);
    const onQuestion = vi.fn();

    const agent = new Agent(onEvent, onPermission, onQuestion);
    agent.tier = "subagent";
    agent.subagentType = "coder";
    agent.planState = "APPROVED";

    let toolsPassed: any[] = [];
    vi.mocked(streamText).mockImplementation(({ tools }: any) => {
      toolsPassed = Object.keys(tools || {});
      return {
        fullStream: (async function* () {
          yield { type: "text-delta", textDelta: "Test finished" };
        })(),
        usage: Promise.resolve({ promptTokens: 10, completionTokens: 10 }),
      } as any;
    });

    await agent.sendMessage("hello");

    const expectedToolNames = subagentToolsets.coder.map((t) => t.name);
    expect(toolsPassed).toEqual(expect.arrayContaining(expectedToolNames));
    expect(toolsPassed.length).toBe(expectedToolNames.length);
  });

  it("should NOT filter tools based on classification category when planState is active (not IDLE)", async () => {
    const onEvent = vi.fn();
    const onPermission = vi.fn().mockResolvedValue(true);
    const onQuestion = vi.fn();

    const agent = new Agent(onEvent, onPermission, onQuestion);
    agent.tier = "single";
    agent.planState = "APPROVED";
    agent.currentClassification = {
      category: "conversation",
      confidence: "high",
      reason: "Short acknowledgment",
      heuristicOnly: true,
      classificationTokens: 0,
    };

    let toolsPassed: any[] = [];
    vi.mocked(streamText).mockImplementation(({ tools }: any) => {
      toolsPassed = Object.keys(tools || {});
      return {
        fullStream: (async function* () {
          yield { type: "text-delta", textDelta: "Test finished" };
        })(),
        usage: Promise.resolve({ promptTokens: 10, completionTokens: 10 }),
      } as any;
    });

    await agent.sendMessage("lanjut");

    const expectedToolNames = superagentToolset
      .map((t) => t.name)
      .filter((name) => name !== "manage_workspace_chain" && name !== "cross_workspace_exec");
    // Tools should NOT be filtered to empty array because planState is active
    expect(toolsPassed).toEqual(expect.arrayContaining(expectedToolNames));
    expect(toolsPassed.length).toBe(expectedToolNames.length);
  });
});

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

// Mock configuration partially
vi.mock("../src/core/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof configModule>();
  return {
    ...actual,
    getConfig: vi.fn().mockReturnValue({
      provider: "openai",
      model: "gpt-4",
      apiKey: "fake-key",
      disableStreaming: false,
      workingDirectory: process.cwd(),
      systemPrompt: "Base Agent Prompt Content",
    }),
  };
});

// Mock rmemoryUtil
vi.mock("../src/core/rmemoryUtil.js", () => ({
  getRMemoryClient: vi.fn(),
  getRMemorySessionKey: vi.fn().mockReturnValue("test-sess"),
  isRmemoryActive: vi.fn().mockResolvedValue(true),
}));

// Mock ai SDK partially
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    streamText: vi.fn(),
  };
});

describe("Agent - Tier-Specific Default Toolset Resolution", () => {
  beforeEach(() => {
    if (fs.existsSync(tempHome)) {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
    vi.clearAllMocks();
    // Speed up tests by skipping actual countdown delay
    vi.spyOn(Agent.prototype as any, "delayWithCountdown").mockResolvedValue(undefined);
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

    const expectedToolNames = masterToolset.map((t) => t.name);
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

    const expectedToolNames = superagentToolset.map((t) => t.name);
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

    const expectedToolNames = superagentToolset.map((t) => t.name);
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
});

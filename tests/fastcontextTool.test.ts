import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fastcontextTool } from "../src/core/tools/fastcontextTool.js";
import { existsSync } from "fs";
import { execa } from "execa";
import { appendActiveToolOutput, clearActiveToolOutput } from "../src/core/tools/state.js";

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return { ...actual, existsSync: vi.fn() };
});

vi.mock("execa", () => ({
  execa: vi.fn(),
}));

vi.mock("../src/core/tools/state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/tools/state.js")>();
  return {
    ...actual,
    appendActiveToolOutput: vi.fn(),
    clearActiveToolOutput: vi.fn(),
  };
});

vi.mock("../src/core/config/jsonConfig.js", () => ({
  loadModelConfig: vi.fn().mockReturnValue({
    providers: [{ id: "test", provider: "openai", apiKey: "sk-test-key", baseUrl: "" }],
  }),
  getActivePreset: vi.fn().mockReturnValue({
    models: {
      superagent: { model: "gpt-4o" },
      subagentDetails: {},
    },
  }),
}));

/**
 * Helper: create a mock execa child process with a controllable stderr stream.
 * The returned object behaves like the real execa return — it's both a promise
 * and has a `.stderr` with `.on("data", cb)`.
 */
function createMockChild(resolvedValue: any = { stdout: "", stderr: "", exitCode: 0 }) {
  const stderrHandlers: Array<(chunk: Buffer) => void> = [];

  const promise: any = Promise.resolve(resolvedValue);
  promise.stderr = {
    on: vi.fn().mockImplementation((event: string, cb: (chunk: Buffer) => void) => {
      if (event === "data") stderrHandlers.push(cb);
      return promise.stderr;
    }),
  };
  promise.kill = vi.fn();

  /** Emit a line of JSONL to stderr (simulates the Python runner). */
  async function emitStderr(data: string) {
    // Flush microtasks so the tool code has registered its stderr handler
    await new Promise<void>((r) => setTimeout(r, 0));
    for (const cb of stderrHandlers) {
      cb(Buffer.from(data + "\n"));
    }
  }

  return { promise, emitStderr };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("fastcontextTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: Python binary exists
    vi.mocked(existsSync).mockReturnValue(true);
  });

  it("has correct name and parameters", () => {
    expect(fastcontextTool.name).toBe("fastcontext");
    expect(fastcontextTool.parameters).toBeDefined();
    expect((fastcontextTool.parameters as any).properties.query).toBeDefined();
    expect((fastcontextTool.parameters as any).properties.maxTurns).toBeDefined();
    expect((fastcontextTool.parameters as any).properties.citation).toBeDefined();
    expect((fastcontextTool.parameters as any).required).toContain("query");
  });

  it("returns error when query is empty", async () => {
    const result = await fastcontextTool.execute({ query: "" }, "/tmp");
    expect(result).toContain("Error");
    expect(result).toContain("query");
  });

  it("returns error when Python binary is missing", async () => {
    vi.mocked(existsSync).mockReturnValue(false);

    const result = await fastcontextTool.execute(
      { query: "Find auth middleware" },
      "/tmp"
    );
    expect(result).toContain("not installed");
    expect(result).toContain("setup-fastcontext");
  });

  it("is registered in all toolsets", async () => {
    const { masterToolset, superagentToolset, subagentToolsets, defaultSubagentToolset } =
      await import("../src/core/tools/toolsets.js");

    expect(masterToolset.some((t) => t.name === "fastcontext")).toBe(true);
    expect(superagentToolset.some((t) => t.name === "fastcontext")).toBe(true);
    expect(subagentToolsets.researcher.some((t) => t.name === "fastcontext")).toBe(true);
    expect(subagentToolsets.coder.some((t) => t.name === "fastcontext")).toBe(true);
    expect(subagentToolsets.reviewer.some((t) => t.name === "fastcontext")).toBe(true);
    expect(subagentToolsets["manual-tester"].some((t) => t.name === "fastcontext")).toBe(true);
    expect(defaultSubagentToolset.some((t) => t.name === "fastcontext")).toBe(true);
  });
});

describe("fastcontextTool live output panel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(true);
  });

  it("clears and uses appendActiveToolOutput for progress events", async () => {
    const { promise, emitStderr } = createMockChild({
      stdout: "final answer",
      stderr: "",
      exitCode: 0,
    });
    vi.mocked(execa).mockReturnValue(promise as any);

    const resultP = fastcontextTool.execute(
      { query: "Find auth middleware" },
      "/tmp"
    );

    // Simulate Python stderr JSONL events
    await emitStderr(JSON.stringify({ event: "start", query: "Find auth middleware" }));
    await emitStderr(JSON.stringify({ event: "turn", turn: 1 }));
    await emitStderr(JSON.stringify({ event: "thinking", text: "Searching for auth...", has_tools: true }));
    await emitStderr(JSON.stringify({ event: "tool_start", tool: "Grep", args: '{"pattern":"auth"}' }));
    await emitStderr(JSON.stringify({ event: "tool_end", ok: true, preview: "src/auth.ts:10" }));
    await emitStderr(JSON.stringify({ event: "done", turns: 1 }));

    const result = await resultP;

    // Verify result is the stdout
    expect(result).toBe("final answer");

    // Verify clearActiveToolOutput was called at start and end
    expect(clearActiveToolOutput).toHaveBeenCalledTimes(2);

    // Verify appendActiveToolOutput was called with formatted events
    const calls = vi.mocked(appendActiveToolOutput).mock.calls.map((c) => c[0]);
    expect(calls.some((c) => c.includes('Exploring: "Find auth middleware"'))).toBe(true);
    expect(calls.some((c) => c.includes("── Turn 1 ──"))).toBe(true);
    expect(calls.some((c) => c.includes("💭"))).toBe(true);
    expect(calls.some((c) => c.includes("🔧 Grep"))).toBe(true);
    expect(calls.some((c) => c.includes("✅"))).toBe(true);
    expect(calls.some((c) => c.includes("✔ Done"))).toBe(true);
  });

  it("formats tool_end failure with ❌", async () => {
    const { promise, emitStderr } = createMockChild({
      stdout: "partial answer",
      stderr: "",
      exitCode: 0,
    });
    vi.mocked(execa).mockReturnValue(promise as any);

    const resultP = fastcontextTool.execute({ query: "test" }, "/tmp");

    await emitStderr(JSON.stringify({ event: "start", query: "test" }));
    await emitStderr(JSON.stringify({ event: "tool_end", ok: false, preview: "File not found" }));
    await emitStderr(JSON.stringify({ event: "done", turns: 1 }));

    await resultP;

    const calls = vi.mocked(appendActiveToolOutput).mock.calls.map((c) => c[0]);
    expect(calls.some((c) => c.includes("❌"))).toBe(true);
  });

  it("handles non-JSON stderr gracefully", async () => {
    const { promise, emitStderr } = createMockChild({
      stdout: "answer",
      stderr: "",
      exitCode: 0,
    });
    vi.mocked(execa).mockReturnValue(promise as any);

    const resultP = fastcontextTool.execute({ query: "test" }, "/tmp");

    await emitStderr("WARNING: some random python warning");
    await emitStderr(JSON.stringify({ event: "done", turns: 1 }));

    const result = await resultP;
    expect(result).toBe("answer");

    const calls = vi.mocked(appendActiveToolOutput).mock.calls.map((c) => c[0]);
    expect(calls.some((c) => c.includes("WARNING: some random python warning"))).toBe(true);
  });

  it("handles error event from Python runner", async () => {
    const { promise, emitStderr } = createMockChild({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });
    vi.mocked(execa).mockReturnValue(promise as any);

    const resultP = fastcontextTool.execute({ query: "test" }, "/tmp");

    await emitStderr(JSON.stringify({ event: "error", text: "LLM API rate limit exceeded" }));
    await emitStderr(JSON.stringify({ event: "done", turns: 0 }));

    await resultP;

    const calls = vi.mocked(appendActiveToolOutput).mock.calls.map((c) => c[0]);
    expect(calls.some((c) => c.includes("🚨") && c.includes("rate limit"))).toBe(true);
  });

  it("clears live panel even when process throws", async () => {
    vi.mocked(execa).mockImplementation(() => {
      const p: any = Promise.reject(new Error("spawn ENOENT"));
      p.stderr = { on: vi.fn() };
      p.kill = vi.fn();
      return p;
    });

    const result = await fastcontextTool.execute({ query: "test" }, "/tmp");

    expect(result).toContain("FastContext error");
    // clearActiveToolOutput should be called in the catch block
    expect(clearActiveToolOutput).toHaveBeenCalled();
  });

  it("does not use emitToolLog (agent text stream stays clean)", async () => {
    const { promise, emitStderr } = createMockChild({
      stdout: "result",
      stderr: "",
      exitCode: 0,
    });
    vi.mocked(execa).mockReturnValue(promise as any);

    // Mock agentLocalStorage to spy on emitToolLog
    const emitToolLogSpy = vi.fn();
    vi.doMock("../src/core/agent.js", () => ({
      agentLocalStorage: {
        getStore: () => ({ emitToolLog: emitToolLogSpy }),
      },
    }));

    const resultP = fastcontextTool.execute({ query: "test" }, "/tmp");
    await emitStderr(JSON.stringify({ event: "start", query: "test" }));
    await emitStderr(JSON.stringify({ event: "done", turns: 1 }));

    await resultP;

    // emitToolLog should NOT be called — progress goes to live panel only
    expect(emitToolLogSpy).not.toHaveBeenCalled();

    vi.doUnmock("../src/core/agent.js");
  });
});

describe("isFastContextReady", () => {
  it("returns true when both Python and vendor source exist", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    const { isFastContextReady } = await import("../src/core/fastcontextSetup.js");
    expect(isFastContextReady()).toBe(true);
  });

  it("returns false when Python is missing", async () => {
    vi.mocked(existsSync).mockImplementation((p: any) => {
      return !String(p).includes("python");
    });
    vi.resetModules();
    const { isFastContextReady } = await import("../src/core/fastcontextSetup.js");
    expect(isFastContextReady()).toBe(false);
  });

  it("returns false when sentinel verified file is missing", async () => {
    vi.mocked(existsSync).mockImplementation((p: any) => {
      return !String(p).includes(".verified");
    });
    vi.resetModules();
    const { isFastContextReady } = await import("../src/core/fastcontextSetup.js");
    expect(isFastContextReady()).toBe(false);
  });
});

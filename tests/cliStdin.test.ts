import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { describeCliStdin, ensureCliStdinFlowing } from "../src/utils/cliStdin.js";

describe("interactive CLI stdin contract", () => {
  it("resumes a paused TTY so Ink keeps receiving keystrokes", () => {
    const resume = vi.fn();
    const stdin = { isTTY: true, isPaused: () => true, resume, setRawMode: vi.fn() };

    expect(ensureCliStdinFlowing(stdin)).toBe(true);
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it("resumes a TTY that reports itself as already flowing", () => {
    const resume = vi.fn();
    expect(ensureCliStdinFlowing({ isTTY: true, isPaused: () => false, resume })).toBe(true);
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it("never resumes a piped or headless stream", () => {
    const resume = vi.fn();
    expect(ensureCliStdinFlowing({ isTTY: false, resume })).toBe(false);
    expect(resume).not.toHaveBeenCalled();
    expect(ensureCliStdinFlowing(undefined)).toBe(false);
  });

  it("survives a stream that cannot resume and does not rethrow", () => {
    const stdin = {
      isTTY: true,
      resume: () => {
        throw new Error("stdin closed");
      },
    };
    expect(ensureCliStdinFlowing(stdin)).toBe(false);
  });

  it("describes the paused-TTY precondition that explains a deaf UI", () => {
    expect(
      describeCliStdin(
        { isTTY: true, isPaused: () => true, setRawMode: () => undefined },
        { isTTY: true }
      )
    ).toEqual({
      stdinIsTTY: true,
      stdinWasPaused: true,
      rawModeSupported: true,
      stdoutIsTTY: true,
    });
  });

  it("defaults missing capability probes to false instead of throwing", () => {
    expect(describeCliStdin({ isTTY: true }, {})).toEqual({
      stdinIsTTY: true,
      stdinWasPaused: false,
      rawModeSupported: false,
      stdoutIsTTY: false,
    });
    expect(
      describeCliStdin(undefined, undefined)
    ).toEqual({
      stdinIsTTY: false,
      stdinWasPaused: false,
      rawModeSupported: false,
      stdoutIsTTY: false,
    });
  });

  // Guards the exact regression that removed this call in favour of pure
  // logging: the mount effect must resume stdin, not just report it.
  it("keeps the resume call in the App mount effect", () => {
    const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
    const appSource = readFileSync(path.join(root, "src", "app.tsx"), "utf8");
    const resumeIndex = appSource.indexOf("ensureCliStdinFlowing(process.stdin)");
    expect(resumeIndex).toBeGreaterThan(-1);

    const effectStart = appSource.lastIndexOf("useEffect(", resumeIndex);
    const mountEffect = appSource.slice(effectStart, resumeIndex + 400);

    expect(mountEffect).toContain("describeCliStdin(process.stdin, process.stdout)");
    expect(mountEffect).toContain("App component mounted");
  });
});

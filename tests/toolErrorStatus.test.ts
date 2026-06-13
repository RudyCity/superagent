import { describe, expect, it } from "vitest";
import { executeToolCall } from "../src/core/permissions.js";

describe("tool error status propagation", () => {
  it("marks missing read targets as tool errors", async () => {
    const result = await executeToolCall(
      {
        id: "missing-read",
        name: "read",
        args: { filePath: "definitely-missing-file.txt" },
      } as any,
      process.cwd()
    );

    expect(result.isError).toBe(true);
    expect(result.result).toContain("Error reading file:");
  });

  it("marks invalid grep regexes as tool errors", async () => {
    const result = await executeToolCall(
      {
        id: "invalid-grep",
        name: "grep",
        args: { pattern: "(?i)(secret)", path: "src" },
      } as any,
      process.cwd()
    );

    expect(result.isError).toBe(true);
    expect(result.result).toContain("Error:");
  });

  it("marks non-zero run_command exits as tool errors", async () => {
    const result = await executeToolCall(
      {
        id: "bad-command",
        name: "run_command",
        args: { command: "node -e \"process.exit(7)\"", timeout: 30000 },
      } as any,
      process.cwd()
    );

    expect(result.isError).toBe(true);
    expect(result.result).toContain("Exit code: 7");
  });
});

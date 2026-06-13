import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

describe("prompt and command guidance", () => {
  it("does not instruct Windows agents to chain commands with &&", () => {
    const config = fs.readFileSync(path.resolve(process.cwd(), "src/core/config.ts"), "utf-8");
    const prompts = fs.readFileSync(path.resolve(process.cwd(), "src/core/prompts.ts"), "utf-8");

    expect(config).not.toContain("Since Git Bash is available, you CAN");
    expect(`${config}\n${prompts}`).not.toContain("using `run_command` or `bash`");
  });

  it("documents the Windows command separator rule in runtime guidance", () => {
    const config = fs.readFileSync(path.resolve(process.cwd(), "src/core/config.ts"), "utf-8");
    const prompts = fs.readFileSync(path.resolve(process.cwd(), "src/core/prompts.ts"), "utf-8");
    const combined = `${config}\n${prompts}`;

    expect(combined).toContain("On Windows, use ';' to separate commands");
    expect(combined).toContain("Use \\`run_command\\` for validation commands");
  });
});

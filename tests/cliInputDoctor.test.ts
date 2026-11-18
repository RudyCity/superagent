import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

describe("standalone CLI input transport doctor", () => {
  it("reports non-interactive stdin immediately without starting an agent", () => {
    const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
    const result = spawnSync(
      process.execPath,
      ["scripts/cli-input-doctor.ts"],
      { cwd: root, encoding: "utf8", timeout: 10000, stdio: ["pipe", "pipe", "pipe"] },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("Terminal stdin: NOT A TTY");
    expect(result.stderr).toContain("no interactive TTY/raw-mode input");
    expect(result.stdout + result.stderr).not.toContain("API key");
  });
});

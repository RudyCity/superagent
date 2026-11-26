import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (relativePath: string) =>
  readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");

describe("CLI owns keyboard input for the whole interactive session", () => {
  it("keeps Ink stdin live while a piped terminal command is running", () => {
    const app = read("src/app.tsx");
    const start = app.indexOf("const runInteractiveProcess = async (");
    const end = app.indexOf('if (trimmed.startsWith("/"))', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const implementation = app.slice(start, end);
    expect(implementation).toContain("execa(command");
    expect(implementation).not.toMatch(/process\.stdin\.(pause|resume|setRawMode)\s*\(/);
    // A command must still be able to stream output; do not regain
    // responsiveness by removing the underlying execution feature.
    expect(implementation).toContain('childProcess.all.on("data"');
  });

  for (const path of ["src/hooks/useMouseScroll.ts", "src/hooks/useDashboardMouse.ts"]) {
    it(`does not steal stdin raw mode from Ink or tear down on a handled SIGINT: ${path}`, () => {
      const hook = read(path);
      expect(hook).not.toMatch(/process\.stdin\.setRawMode\s*\(/);
      expect(hook).not.toMatch(/process\.once\("(SIGINT|SIGTERM|uncaughtException)",\s*emergencyCleanup\)/);
      expect(hook).toContain('process.once("exit", emergencyCleanup)');
      expect(hook).toContain('internal_eventEmitter?.on("input", handleMouseInput)');
      expect(hook).not.toContain('process.stdin.on("data", handleMouseInput)');
    });
  }

  it("restores the terminal on actual process exit", () => {
    const cli = read("src/cliMain.tsx");
    expect(cli).toContain('process.on("exit", () => {');
    expect(cli).toContain("restoreTerminal();");
  });
});

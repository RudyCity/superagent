import { defineConfig } from "vitest/config";
import os from "os";
import fs from "node:fs";

// TEMP-DIAG: Vitest's getSourceMap reads a frame's file directly, so a frame
// whose "file" is a directory throws EISDIR and hides the real error. Report
// those frames so the offending test can be fixed. Removed after the fix.
function logDirectoryFrame(error: unknown, frame: { file?: string }): boolean {
  try {
    if (frame.file && fs.existsSync(frame.file) && fs.statSync(frame.file).isDirectory()) {
      const stack = error instanceof Error ? error.stack : String((error as any)?.stack ?? "");
      console.error("[dir-frame] " + frame.file + "\n[dir-frame-stack] " + String(stack).slice(0, 1200));
    }
  } catch {}
  return true;
}

// Avoid both extremes: one worker makes the large suite unnecessarily slow,
// while one fork per reported CPU can overwhelm Windows and create excess temp homes.
// Allow CI/developers to override the cap explicitly when they have measured capacity.
const requestedWorkers = Number.parseInt(process.env.SUPERAGENT_TEST_MAX_WORKERS ?? "", 10);
const maxWorkers =
  Number.isFinite(requestedWorkers) && requestedWorkers > 0
    ? requestedWorkers
    : Math.min(6, Math.max(1, os.cpus().length - 1));

export default defineConfig({
  test: {
    globals: true,
    include: ["tests/**/*.test.ts"],
    exclude: ["node_modules", "dist", ".agents", ".git"],
    globalSetup: ["tests/globalSetup.ts"],
    setupFiles: ["tests/setup.ts"],
    testTimeout: 30000,
    pool: "forks",
    maxWorkers,
    minWorkers: 1,
    onStackTrace: logDirectoryFrame,
  },
});

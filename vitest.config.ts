import { defineConfig } from "vitest/config";
import os from "os";

export default defineConfig({
  test: {
    globals: true,
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    exclude: ["node_modules", "dist", ".agents", ".git"],
    setupFiles: ["tests/setup.ts"],
    testTimeout: 30000,
    maxWorkers: Math.min(4, os.cpus().length),
  },
});

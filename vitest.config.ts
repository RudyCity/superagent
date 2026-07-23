import { defineConfig } from "vitest/config";
import os from "os";

export default defineConfig({
  test: {
    globals: true,
    include: ["tests/**/*.test.ts"],
    exclude: ["node_modules", "dist", ".agents", ".git"],
    setupFiles: ["tests/setup.ts"],
    testTimeout: 30000,
    pool: "forks",
  },
});

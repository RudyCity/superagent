import { defineConfig } from "vitest/config";
import os from "os";

// Some Windows developer machines report hundreds of logical CPUs. Letting
// Vitest fork one worker per reported CPU causes process/memory contention and
// leaves hundreds of isolated temp-home directories behind. Keep the default
// conservative while allowing CI/developers to override it explicitly.
const requestedWorkers = Number.parseInt(process.env.SUPERAGENT_TEST_MAX_WORKERS ?? "", 10);
const maxWorkers =
  Number.isFinite(requestedWorkers) && requestedWorkers > 0
    ? requestedWorkers
    : Math.min(4, Math.max(1, os.cpus().length - 1));

export default defineConfig({
  test: {
    globals: true,
    include: ["tests/**/*.test.ts"],
    exclude: ["node_modules", "dist", ".agents", ".git"],
    setupFiles: ["tests/setup.ts"],
    testTimeout: 30000,
    pool: "forks",
    maxWorkers,
    minWorkers: 1,
  },
});

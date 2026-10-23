import { beforeEach, afterEach, mock, vi } from "vitest";
import path from "path";
import fs from "fs";
import crypto from "crypto";

// Keep an interactive parent session from leaking its task-artifact context into
// child processes spawned by tests (notably CLI Bridge tests). Tests covering
// session-path behavior set SUPERAGENT_SESSION_PATH explicitly.
delete process.env.SUPERAGENT_SESSION_PATH;

// Keep optional ML/model dependencies deterministic in unit tests. Real model
// downloads and ONNX initialization belong in explicit integration tests.
vi.mock("@huggingface/transformers", () => ({
  // Offline transformer fixture for RMemory and translation tests.
  env: { allowRemoteModels: false, useBrowserCache: false, logLevel: "error", backends: { onnx: { logLevel: "error" } } },
  pipeline: vi.fn(async (task: string, model = "") => async (input: string | string[]) => {
    if (task === "translation") return [{ translation_text: String(input) }];
    if (task === "feature-extraction") {
      const dimensions = model.includes("nomic") ? 768 : 384;
      const count = Array.isArray(input) ? input.length : 1;
      return { data: new Float32Array(count * dimensions).fill(0.1), dispose: () => undefined };
    }
    return {};
  }),
}));
vi.mock("@xenova/transformers", () => ({
  env: { allowRemoteModels: false, useBrowserCache: false, backends: { onnx: {} }, logLevel: "error" },
  pipeline: async () => async (text: string) => [{ translation_text: text }],
}));

// Globally enable spying on read-only ESM modules
vi.mock("execa", { spy: true });
vi.mock("ink", { spy: true });
vi.mock("react", { spy: true });
vi.mock("ai", { spy: true });
vi.mock("fast-glob", { spy: true });
vi.mock("child_process", { spy: true });
vi.mock("node:child_process", { spy: true });

// Each test file gets its own home/config directory. Worker IDs are reused
// across files, so using only VITEST_WORKER_ID lets a later file delete a prior
// file's directory while unawaited background work is still flushing.
vi.mock("os", async (importOriginal) => {
  const original = await importOriginal<typeof import("os")>();
  return {
    ...original,
    homedir: () => {
      const configuredHome = process.env.SUPERAGENT_TEST_HOME_DIR;
      if (configuredHome) return configuredHome;
      const workerId = process.env.VITEST_WORKER_ID || `bun-${process.pid}`;
      return path.join(process.cwd(), "tests", `temp-home-worker-${workerId}`);
    }
  };
});

const workerId = process.env.VITEST_WORKER_ID || `bun-${process.pid}`;
const workerHomeDir = path.join(
  process.cwd(),
  "tests",
  `temp-home-worker-${workerId}-${process.pid}-${crypto.randomUUID()}`,
);
const workerConfigDir = path.join(workerHomeDir, ".superagent-r");
process.env.SUPERAGENT_TEST_HOME_DIR = workerHomeDir;
process.env.SUPERAGENT_CONFIG_DIR = workerConfigDir;

fs.mkdirSync(workerConfigDir, { recursive: true });

// Protect tests against global environment and command-line argument pollution
let originalArgv: string[];
let originalEnv: Record<string, string | undefined>;

beforeEach(() => {
  originalArgv = [...process.argv];
  originalEnv = { ...process.env };
});

afterEach(() => {
  process.argv = originalArgv;
  // Restore process.env key-by-key since process.env is a read-only object reference
  for (const key in process.env) {
    if (!(key in originalEnv)) {
      delete process.env[key];
    }
  }
  for (const key in originalEnv) {
    process.env[key] = originalEnv[key];
  }
});

// Polyfill Vitest functions for Bun Test compatibility

if (typeof vi !== "undefined") {
  // vi.mocked polyfill
  if (!(vi as any).mocked) {
    (vi as any).mocked = (fn: any) => fn;
  }

  // vi.doMock polyfill
  if (!(vi as any).doMock) {
    (vi as any).doMock = (modulePath: any, factory?: any) => {
      if (typeof mock !== "undefined" && typeof (mock as any).module === "function") {
        (mock as any).module(modulePath, factory);
      } else if (typeof vi !== "undefined") {
        const mockFn = (vi as any)["mock"];
        if (typeof mockFn === "function") {
          mockFn.call(vi, modulePath, factory);
        }
      }
      return vi;
    };
  }

  // vi.hoisted polyfill
  if (!(vi as any).hoisted) {
    (vi as any).hoisted = (factory: any) => factory();
  }

  // vi.stubGlobal and vi.unstubAllGlobals polyfills
  const stubbedGlobals = new Map<any, any>();
  if (!(vi as any).stubGlobal) {
    (vi as any).stubGlobal = function (name: any, value: any) {
      stubbedGlobals.set(name, (globalThis as any)[name]);
      (globalThis as any)[name] = value;
      return vi;
    };
  }
  if (!(vi as any).unstubAllGlobals) {
    (vi as any).unstubAllGlobals = function () {
      for (const [name, originalValue] of stubbedGlobals.entries()) {
        if (originalValue === undefined) {
          delete (globalThis as any)[name];
        } else {
          (globalThis as any)[name] = originalValue;
        }
      }
      stubbedGlobals.clear();
      return vi;
    };
  }

  // vi.waitFor polyfill
  if (!(vi as any).waitFor) {
    (vi as any).waitFor = async function (callback: () => any, options: { timeout?: number; interval?: number } = {}) {
      const timeout = options.timeout ?? 10000;
      const interval = options.interval ?? 50;
      const start = Date.now();
      let lastError: any;
      while (Date.now() - start < timeout) {
        try {
          return await callback();
        } catch (err) {
          lastError = err;
          await new Promise((resolve) => setTimeout(resolve, interval));
        }
      }
      throw lastError ?? new Error("vi.waitFor timed out");
    };
  }

  // vi.importActual polyfill using pathToFileURL for Windows ES modules support
  if (!(vi as any).importActual) {
    (vi as any).importActual = async function (modulePath: string) {
      let callerDir = process.cwd();
      try {
        const stack = new Error().stack || "";
        const lines = stack.split("\n");
        for (const line of lines) {
          if (line.includes("setup.ts")) continue;
          const match = line.match(/(?:at\s+)?([a-zA-Z]:\\[^\s:]+|\/[^\s:]+)/);
          if (match) {
            callerDir = path.dirname(match[1]);
            break;
          }
        }
      } catch {}

      let importPath = modulePath;
      if (modulePath.startsWith(".")) {
        importPath = path.resolve(callerDir, modulePath);
      }
      const { pathToFileURL } = require("url");
      importPath = pathToFileURL(importPath).href;
      return await import(importPath + "?original");
    };
  }
}




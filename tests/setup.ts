import { beforeEach, afterEach, mock, vi } from "vitest";
import path from "path";
import fs from "fs";

// Globally mock @huggingface/transformers to prevent ONNX runtime hangs on Windows under Bun
if (typeof mock !== "undefined" && typeof mock.module === "function") {
  mock.module("@huggingface/transformers", () => ({
    pipeline: () => Promise.resolve(() => ({})),
  }));
} else {
  vi.mock("@huggingface/transformers", () => ({
    pipeline: () => Promise.resolve(() => ({})),
  }));
}

// Globally enable spying on read-only ESM modules
vi.mock("execa", { spy: true });
vi.mock("ink", { spy: true });
vi.mock("react", { spy: true });
vi.mock("ai", { spy: true });
vi.mock("fast-glob", { spy: true });
vi.mock("child_process", { spy: true });
vi.mock("node:child_process", { spy: true });

// Globally mock os.homedir() to return the isolated worker home directory
vi.mock("os", async (importOriginal) => {
  const original = await importOriginal<typeof import("os")>();
  return {
    ...original,
    homedir: () => {
      const workerId = process.env.VITEST_WORKER_ID || `bun-${process.pid}`;
      const path = require("path");
      return path.join(process.cwd(), "tests", `temp-home-worker-${workerId}`);
    }
  };
});

// Isolate configuration directory per Vitest worker to prevent parallel test lock contention
const workerId = process.env.VITEST_WORKER_ID || `bun-${process.pid}`;
const workerHomeDir = path.join(process.cwd(), "tests", `temp-home-worker-${workerId}`);
const workerConfigDir = path.join(workerHomeDir, ".superagent-r");

// Clean up any stale directory from a previous Vitest run at startup
if (fs.existsSync(workerHomeDir)) {
  try {
    fs.rmSync(workerHomeDir, { recursive: true, force: true });
  } catch {}
}

process.env.SUPERAGENT_CONFIG_DIR = workerConfigDir;

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




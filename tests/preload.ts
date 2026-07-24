import Yoga from "yoga-layout";
import path from "path";
import fs from "fs";
import { mock } from "vitest";

function parseStackTraceLine(line: string): string | null {
  let filePath = line.trim();
  if (filePath.startsWith("at ")) {
    filePath = filePath.substring(3).trim();
  }
  const openParen = filePath.lastIndexOf("(");
  const closeParen = filePath.lastIndexOf(")");
  if (openParen !== -1 && closeParen !== -1 && closeParen > openParen) {
    filePath = filePath.substring(openParen + 1, closeParen).trim();
  }
  const parts = filePath.split(":");
  while (parts.length > 1) {
    const last = parts[parts.length - 1];
    if (/^\d+$/.test(last)) {
      parts.pop();
    } else {
      break;
    }
  }
  filePath = parts.join(":");
  if (path.isAbsolute(filePath)) {
    return filePath;
  }
  return null;
}

// Globally mock @huggingface/transformers to prevent ONNX runtime hangs on Windows under Bun
if (typeof mock !== "undefined" && typeof mock.module === "function") {
  mock.module("@huggingface/transformers", () => ({
    pipeline: () => Promise.resolve(() => ({})),
  }));
}

// Isolate configuration directory per worker to prevent parallel test lock contention
const workerId = process.env.VITEST_WORKER_ID || `bun-${process.pid}`;
const workerHomeDir = path.join(process.cwd(), "tests", `temp-home-worker-${workerId}`);
const workerConfigDir = path.join(workerHomeDir, ".superagent-r");

// Clean up any stale directory from a previous run at startup
if (fs.existsSync(workerHomeDir)) {
  try {
    fs.rmSync(workerHomeDir, { recursive: true, force: true });
  } catch {}
}

process.env.SUPERAGENT_CONFIG_DIR = workerConfigDir;

// Force test environment flags for Bun Test compatibility
process.env.VITEST = "true";

// Polyfill vi globals for Bun Test compatibility by importing and mutating the vi object from vitest
import { vi } from "vitest";

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
          if (line.includes("setup.ts") || line.includes("preload.ts")) continue;
          const parsedPath = parseStackTraceLine(line);
          if (parsedPath) {
            callerDir = path.dirname(parsedPath);
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

  // vi.mock polyfill to inject importOriginal callback parameter under Bun using a lazy Proxy
  const originalMock = (vi as any).mock;
  (vi as any).mock = function (modulePath: string, factory?: any) {
    let callerDir = process.cwd();
    try {
      const stack = new Error().stack || "";
      const lines = stack.split("\n");
      for (const line of lines) {
        if (line.includes("setup.ts") || line.includes("preload.ts")) continue;
        const parsedPath = parseStackTraceLine(line);
        if (parsedPath) {
          callerDir = path.dirname(parsedPath);
          break;
        }
      }
    } catch {}

    let importPath = modulePath;
    if (modulePath.startsWith(".")) {
      importPath = path.resolve(callerDir, modulePath);
    }
    importPath = importPath.replace(/\\/g, "/");

    const pathsToMock = [importPath];
    const getExtVariant = (p: string) => {
      if (p.endsWith(".js")) return p.slice(0, -3) + ".ts";
      if (p.endsWith(".jsx")) return p.slice(0, -4) + ".tsx";
      return null;
    };
    const ext1 = getExtVariant(importPath);
    if (ext1) pathsToMock.push(ext1);

    let altImportPath: string | null = null;
    if (importPath.match(/^[a-zA-Z]:/)) {
      const firstChar = importPath[0];
      const isUpper = firstChar === firstChar.toUpperCase();
      const altChar = isUpper ? firstChar.toLowerCase() : firstChar.toUpperCase();
      altImportPath = altChar + importPath.slice(1);
      pathsToMock.push(altImportPath);
      const ext2 = getExtVariant(altImportPath);
      if (ext2) pathsToMock.push(ext2);
    }

    if (typeof factory === "function") {

      const importOriginal = () => {
        let cachedModule: any = null;
        const loadModule = () => {
          if (cachedModule) return cachedModule;
          try {
            cachedModule = require(importPath + "?original");
          } catch {
            try {
              cachedModule = require(importPath);
            } catch (e) {
              cachedModule = {};
            }
          }
          return cachedModule;
        };

        return new Proxy({}, {
          get(target, prop) {
            // Return a wrapper function to defer loading until actual invocation
            const wrapper = function (this: any, ...args: any[]) {
              const mod = loadModule();
              const val = mod[prop];
              if (typeof val === "function") {
                return val.apply(this, args);
              }
              return val;
            };

            // Define custom valueOf and toString to let it behave like a primitive if coerced
            wrapper.valueOf = () => {
              const mod = loadModule();
              const val = mod[prop];
              return typeof val === "function" ? val : val;
            };
            wrapper.toString = () => {
              const mod = loadModule();
              return String(mod[prop]);
            };

            return wrapper;
          }
        });
      };

      const wrappedFactory = () => {
        return factory(importOriginal);
      };

      for (const p of pathsToMock) {
        mock.module(p, wrappedFactory);
      }
      return vi;
    }
    for (const p of pathsToMock) {
      mock.module(p, factory);
    }
    return vi;
  };
}

import { beforeEach, afterEach } from "vitest";

// Protect tests against global environment, command-line argument, and spy mock pollution
let originalArgv: string[];
let originalEnv: Record<string, string | undefined>;

beforeEach(() => {
  originalArgv = [...process.argv];
  originalEnv = { ...process.env };
});

afterEach(() => {
  vi.restoreAllMocks();
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

import path from "path";
import fs from "fs";

// Isolate configuration directory per worker to prevent parallel test lock contention
const workerId = process.env.VITEST_WORKER_ID || "0";
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

  // vi.mock polyfill to inject importOriginal callback parameter under Bun using a lazy Proxy
  const originalMock = (vi as any).mock;
  (vi as any).mock = function (modulePath: string, factory?: any) {
    if (typeof factory === "function") {
      let callerDir = process.cwd();
      try {
        const stack = new Error().stack || "";
        const lines = stack.split("\n");
        for (const line of lines) {
          if (line.includes("setup.ts") || line.includes("preload.ts")) continue;
          const match = line.match(/(?:at\s+)?([a-zA-Z]:\\[^\s:]+|\/[^\s:]+)/);
          if (match) {
            callerDir = path.dirname(match[1]);
            break;
          }
        }
      } catch {}

      const importOriginal = () => {
        let importPath = modulePath;
        if (modulePath.startsWith(".")) {
          importPath = path.resolve(callerDir, modulePath);
        }
        importPath = importPath.replace(/\\/g, "/");

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

      const wrappedFactory = async () => {
        return await factory(importOriginal);
      };

      return originalMock(modulePath, wrappedFactory);
    }
    return originalMock(modulePath, factory);
  };
}

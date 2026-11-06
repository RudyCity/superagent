import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveDelegateCorePort } from "../src/core/runtime/delegateCoreEndpoint.js";

const oldPublic = process.env.SUPERAGENT_CORE_PUBLIC_PORT;
const oldPort = process.env.SUPERAGENT_CORE_PORT;
const roots: string[] = [];
afterEach(() => {
  if (oldPublic === undefined) delete process.env.SUPERAGENT_CORE_PUBLIC_PORT;
  else process.env.SUPERAGENT_CORE_PUBLIC_PORT = oldPublic;
  if (oldPort === undefined) delete process.env.SUPERAGENT_CORE_PORT;
  else process.env.SUPERAGENT_CORE_PORT = oldPort;
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("Delegate Core endpoint resolution", () => {
  it("prefers explicit Core port configuration", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-core-port-"));
    roots.push(root);
    process.env.SUPERAGENT_CORE_PUBLIC_PORT = "8123";
    expect(resolveDelegateCorePort(root)).toBe(8123);
  });

  it("rejects malformed explicit Core port configuration", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-core-port-"));
    roots.push(root);
    process.env.SUPERAGENT_CORE_PUBLIC_PORT = "nope";
    expect(() => resolveDelegateCorePort(root)).toThrow("DELEGATE_CORE_PORT_INVALID");
  });

  it("falls back to the production default when no trusted discovery exists", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-core-port-"));
    roots.push(root);
    delete process.env.SUPERAGENT_CORE_PUBLIC_PORT;
    delete process.env.SUPERAGENT_CORE_PORT;
    expect(resolveDelegateCorePort(root)).toBe(7888);
  });
});

import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { augmentWindowsEnvPath } from "../src/core/tools/helpers.js";

describe("Windows MCP toolchain PATH", () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const roots: string[] = [];
  afterEach(() => {
    Object.defineProperty(process, "platform", originalPlatform);
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  });

  it("adds only an installed per-user Bun executable directory", () => {
    const user = fs.mkdtempSync(path.join(os.tmpdir(), "superagent-win-bun-"));
    roots.push(user);
    const bunBin = path.join(user, ".bun", "bin");
    fs.mkdirSync(bunBin, { recursive: true });
    fs.writeFileSync(path.join(bunBin, "bun.exe"), "");
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });

    const env = augmentWindowsEnvPath({ USERPROFILE: user, PATH: "C:\\Windows\\System32" });
    expect(env.PATH?.split(";")).toContain(bunBin);
    expect(env.Path).toBe(env.PATH);

    const again = augmentWindowsEnvPath(env);
    expect(again.PATH?.split(";").filter(value => value === bunBin)).toHaveLength(1);
  });

  it("does not invent a Bun path when bun.exe is missing", () => {
    const user = fs.mkdtempSync(path.join(os.tmpdir(), "superagent-no-bun-"));
    roots.push(user);
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    const env = augmentWindowsEnvPath({ USERPROFILE: user, PATH: "C:\\Windows\\System32" });
    expect(env.PATH).not.toContain(path.join(user, ".bun", "bin"));
  });
});

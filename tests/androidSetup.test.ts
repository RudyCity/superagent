import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as execaModule from "execa";

const {
  isAndroidCliInstalledGlobally,
  isAndroidCliInstalledLocally,
  getLocalAndroidCliPath,
  isRgInstalledGlobally,
  isRgInstalledLocally,
  getLocalRgPath,
  isCurlInstalledGlobally,
  isCurlInstalledLocally,
  getLocalCurlPath,
  isUvInstalledGlobally,
  isUvInstalledLocally,
  getLocalUvPath,
  isPythonInstalled,
  getLocalOfficeCliPath,
  isOfficeCliInstalledLocally,
  isOfficeCliInstalledGlobally,
  isRmemoryInstalled
} = await import("../src/core/androidSetup.js");

describe("androidSetup", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(execaModule, "execa").mockImplementation(((cmd: string, args: string[]) => {
      if (cmd === "where.exe" || cmd === "which") {
        return Promise.resolve({ exitCode: 0, stdout: "path/to/cmd" });
      }
      return Promise.resolve({ exitCode: 0 });
    }) as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should check if android is installed globally", async () => {
    const installed = await isAndroidCliInstalledGlobally();
    expect(installed).toBe(true);
  });

  it("should construct local android CLI path correctly", () => {
    const localPath = getLocalAndroidCliPath();
    expect(localPath).toBeDefined();
    expect(localPath.toLowerCase()).toContain("android");
  });

  it("should check if android is installed locally", async () => {
    const installed = await isAndroidCliInstalledLocally();
    expect(typeof installed).toBe("boolean");
  });

  it("should check if rg is installed globally", async () => {
    const installed = await isRgInstalledGlobally();
    expect(installed).toBe(true);
  });

  it("should construct local rg path correctly", () => {
    const localPath = getLocalRgPath();
    expect(localPath).toBeDefined();
    expect(localPath.toLowerCase()).toContain("rg");
  });

  it("should check if rg is installed locally", async () => {
    const installed = await isRgInstalledLocally();
    expect(typeof installed).toBe("boolean");
  });

  it("should check if curl is installed globally", async () => {
    const installed = await isCurlInstalledGlobally();
    expect(installed).toBe(true);
  });

  it("should construct local curl path correctly", () => {
    const localPath = getLocalCurlPath();
    expect(localPath).toBeDefined();
    expect(localPath.toLowerCase()).toContain("curl");
  });

  it("should check if curl is installed locally", async () => {
    const installed = await isCurlInstalledLocally();
    expect(typeof installed).toBe("boolean");
  });

  it("should check if uv is installed globally", async () => {
    const installed = await isUvInstalledGlobally();
    expect(installed).toBe(true);
  });

  it("should construct local uv path correctly", () => {
    const localPath = getLocalUvPath();
    expect(localPath).toBeDefined();
    expect(localPath.toLowerCase()).toContain("uv");
  });

  it("should check if uv is installed locally", async () => {
    const installed = await isUvInstalledLocally();
    expect(typeof installed).toBe("boolean");
  });

  it("should check if Python is installed", async () => {
    const installed = await isPythonInstalled();
    expect(installed).toBe(true);
  });

  it("should construct local officecli path correctly", () => {
    const localPath = getLocalOfficeCliPath();
    expect(localPath).toBeDefined();
    expect(localPath.toLowerCase()).toContain("officecli");
  });

  it("should check if officecli is installed locally", async () => {
    const installed = await isOfficeCliInstalledLocally();
    expect(typeof installed).toBe("boolean");
  });

  it("should check if officecli is installed globally", async () => {
    const installed = await isOfficeCliInstalledGlobally();
    expect(installed).toBe(true);
  });

  it("should check if r-memory is installed", async () => {
    const installed = await isRmemoryInstalled();
    expect(typeof installed).toBe("boolean");
  });
});

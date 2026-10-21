import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  isTunnelClientAvailable,
  ensureTunnelClientInstalled,
  clearTunnelClientCache,
} from "../src/core/setup/tunnelClientSetup.js";
import { clearSystemCheckCache } from "../src/core/config/systemCache.js";
import * as openaiTunnelModule from "../src/core/mcp/openaiTunnelClient.js";
import { execa } from "execa";

// Never execute a real global Bun package install from a unit test. Installation
// can hang on network/registry contention and has system-wide side effects.
vi.mock("execa", () => ({
  execa: vi.fn(async () => { throw new Error("synthetic offline Bun failure"); }),
}));

describe("tunnelClientSetup", () => {
  let tempHome: string;
  let homedirSpy: { mockRestore(): void };

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "tunnel-setup-test-"));
    homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(tempHome);
    clearTunnelClientCache();
    clearSystemCheckCache();
    vi.mocked(execa).mockClear();
  });

  afterEach(() => {
    homedirSpy?.mockRestore();
    clearTunnelClientCache();
    clearSystemCheckCache();
    fs.rmSync(tempHome, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("reports available when binary is discovered", async () => {
    const fakeBin = path.join(tempHome, "fake-tunnel-client.exe");
    vi.spyOn(openaiTunnelModule, "findTunnelClientBinary").mockReturnValue(fakeBin);

    const available = await isTunnelClientAvailable();
    expect(available).toBe(true);
  });

  it("reports unavailable when binary is not discovered", async () => {
    vi.spyOn(openaiTunnelModule, "findTunnelClientBinary").mockReturnValue(null);

    const available = await isTunnelClientAvailable();
    expect(available).toBe(false);
  });

  it("skips installation if already available", async () => {
    const fakeBin = path.join(tempHome, "fake-tunnel-client.exe");
    vi.spyOn(openaiTunnelModule, "findTunnelClientBinary").mockReturnValue(fakeBin);

    let stageReported = "";
    await ensureTunnelClientInstalled((_d, _t, stage) => {
      stageReported = stage;
    });

    expect(stageReported).toBe("done");
  });

  it("gracefully attempts Bun global installation when not available and finishes without uncaught error", async () => {
    vi.spyOn(openaiTunnelModule, "findTunnelClientBinary").mockReturnValue(null);

    let stageReported = "";
    await ensureTunnelClientInstalled((_d, _t, stage) => {
      stageReported = stage;
    });

    expect(stageReported).toBe("done");
    expect(execa).toHaveBeenCalledOnce();
    expect(execa).toHaveBeenCalledWith(
      process.versions.bun ? process.execPath : "bun",
      ["add", "-g", "@openai/tunnel-client"], {
      stdio: "ignore", timeout: 45000,
    });
  });
});

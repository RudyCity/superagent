import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import os from "os";
import fs from "fs";
import { spawn, ChildProcess } from "child_process";
import {
  saveTunnelState,
  readTunnelState,
  clearTunnelState,
  stopQuickTunnel,
  stopAllQuickTunnels,
  isProcessRunning,
  isOwnQuickTunnelProcess,
  clearWsRemoteUrl,
  TunnelUrlScanner,
} from "../src/core/remoteAgent/cloudflareTunnel.js";
import {
  loadRemoteAgentConfig,
  updateRemoteAgentConfig,
} from "../src/core/remoteAgent/config.js";

/**
 * Regression tests for the 2026-10-05 tunnel bug-fix batch:
 *  Bug 1 - tunnel URL split across stdout/stderr chunk boundaries
 *  Bug 2 - stop paths must never kill foreign cloudflared processes
 *  Bug 3 - default tunnel.json is sticky, not last-write-wins
 *  Bug 4 - wsRemoteUrl is cleared on every stop/exit path
 */
describe("Tunnel bug fixes (regression)", () => {
  let tmpHome: string;
  let homedirSpy: { mockRestore(): void };
  const liveChildren: ChildProcess[] = [];

  const metaFor = (port: number, pid = 424242) => ({
    pid,
    publicUrl: `https://sub-${port}.trycloudflare.com`,
    wssUrl: `wss://sub-${port}.trycloudflare.com/muse`,
    localUrl: `http://127.0.0.1:${port}`,
    port,
    startedAt: Date.now(),
  });

  const spawnSleeper = async (): Promise<ChildProcess> => {
    const child = spawn(process.execPath, ["-e", "setInterval(function(){}, 1000);"], {
      stdio: "ignore",
    });
    liveChildren.push(child);
    // Give the OS a moment so process listings / /proc see the new PID.
    await new Promise((r) => setTimeout(r, 400));
    expect(isProcessRunning(child.pid!)).toBe(true);
    return child;
  };

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "cf-fix-test-"));
    homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
    clearTunnelState("all");
    updateRemoteAgentConfig({ wsRemoteUrl: undefined });
  });

  afterEach(() => {
    for (const c of liveChildren) {
      try {
        c.kill("SIGKILL");
      } catch {}
    }
    liveChildren.length = 0;
    homedirSpy.mockRestore();
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    } catch {}
  });

  describe("Bug 1: URL split across output chunks", () => {
    it("detects a URL split across two chunks", () => {
      const s = new TunnelUrlScanner();
      expect(
        s.push("2026-10-05T07:00:00Z INF Registered tunnel connection https://my-tun")
      ).toBeNull();
      expect(s.push("nel-01.trycloudflare.com")).toBe("https://my-tunnel-01.trycloudflare.com");
    });

    it("detects a URL inside a single chunk", () => {
      const s = new TunnelUrlScanner();
      expect(s.push("INF https://abc-123.trycloudflare.com ready")).toBe(
        "https://abc-123.trycloudflare.com"
      );
    });

    it("keeps the buffer bounded and still detects after garbage", () => {
      const s = new TunnelUrlScanner();
      s.push("x".repeat(20000));
      expect(s.push("https://late-99.trycloudflare.com up")).toBe(
        "https://late-99.trycloudflare.com"
      );
    });

    it("returns null when no URL is present", () => {
      const s = new TunnelUrlScanner();
      expect(s.push("INF Starting cloudflared")).toBeNull();
      expect(s.push("INF Version 2026.1.0")).toBeNull();
    });
  });

  describe("Bug 2: stop paths never kill foreign processes", () => {
    it("isOwnQuickTunnelProcess rejects a foreign process", async () => {
      const child = await spawnSleeper();
      expect(await isOwnQuickTunnelProcess(child.pid!, "http://127.0.0.1:59999")).toBe(false);
      expect(isProcessRunning(child.pid!)).toBe(true);
    });

    it("stopQuickTunnel cleans stale state but leaves a foreign PID alive", async () => {
      const child = await spawnSleeper();
      saveTunnelState(metaFor(59999, child.pid!));
      expect(readTunnelState(59999)?.pid).toBe(child.pid);
      await stopQuickTunnel(59999);
      expect(isProcessRunning(child.pid!)).toBe(true);
      expect(readTunnelState(59999)).toBeNull();
    });

    it("stopAll does not terminate foreign processes", async () => {
      const child = await spawnSleeper();
      saveTunnelState(metaFor(59998, child.pid!));
      await stopAllQuickTunnels();
      expect(isProcessRunning(child.pid!)).toBe(true);
      expect(readTunnelState(59998)).toBeNull();
    });
  });

  describe("Bug 3: sticky default tunnel state", () => {
    it("keeps the first-started tunnel as the default", () => {
      saveTunnelState(metaFor(9225));
      expect(readTunnelState()?.port).toBe(9225);
      saveTunnelState(metaFor(9226));
      expect(readTunnelState(9226)?.port).toBe(9226);
      expect(readTunnelState()?.port).toBe(9225);
    });

    it("updates the default when the same port re-saves", () => {
      saveTunnelState(metaFor(9225));
      const again = {
        ...metaFor(9225),
        publicUrl: "https://new-9225.trycloudflare.com",
        wssUrl: "wss://new-9225.trycloudflare.com/muse",
      };
      saveTunnelState(again);
      expect(readTunnelState()?.publicUrl).toBe("https://new-9225.trycloudflare.com");
    });

    it("clears the default only when its owning port is cleared", () => {
      saveTunnelState(metaFor(9225));
      saveTunnelState(metaFor(9226));
      clearTunnelState(9226);
      expect(readTunnelState()?.port).toBe(9225);
      expect(readTunnelState(9226)).toBeNull();
      clearTunnelState(9225);
      expect(readTunnelState()).toBeNull();
    });
  });

  describe("Bug 4: wsRemoteUrl cleanup on stop", () => {
    it("clearWsRemoteUrl only clears a matching URL", () => {
      updateRemoteAgentConfig({ wsRemoteUrl: "wss://keep.trycloudflare.com/muse" });
      clearWsRemoteUrl("wss://other.trycloudflare.com/muse");
      expect(loadRemoteAgentConfig().wsRemoteUrl).toBe("wss://keep.trycloudflare.com/muse");
      clearWsRemoteUrl("wss://keep.trycloudflare.com/muse");
      expect(loadRemoteAgentConfig().wsRemoteUrl).toBeUndefined();
    });

    it("stopQuickTunnel clears the stopped tunnel's wsRemoteUrl", async () => {
      const m = metaFor(59997);
      updateRemoteAgentConfig({ wsRemoteUrl: m.wssUrl });
      saveTunnelState(m); // pid 424242 is not running: stale state
      await stopQuickTunnel(59997);
      expect(loadRemoteAgentConfig().wsRemoteUrl).toBeUndefined();
      expect(readTunnelState(59997)).toBeNull();
    });

    it("stopQuickTunnel preserves another tunnel's wsRemoteUrl", async () => {
      const m = metaFor(59996);
      updateRemoteAgentConfig({ wsRemoteUrl: "wss://live-other.trycloudflare.com/muse" });
      saveTunnelState(m);
      await stopQuickTunnel(59996);
      expect(loadRemoteAgentConfig().wsRemoteUrl).toBe("wss://live-other.trycloudflare.com/muse");
    });

    it("stopAll clears wsRemoteUrl unconditionally", async () => {
      updateRemoteAgentConfig({ wsRemoteUrl: "wss://whatever.trycloudflare.com/muse" });
      saveTunnelState(metaFor(59995));
      await stopAllQuickTunnels();
      expect(loadRemoteAgentConfig().wsRemoteUrl).toBeUndefined();
    });
  });
});


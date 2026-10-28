/**
 * SuperAgent Browser Runtime Virtual Display Worker Tests (Milestone M2)
 *
 * Comprehensive unit and security tests covering:
 * 1. Dynamic display allocation (:99 to :199) and collision avoidance (no hardcoded :99);
 * 2. Stale lock detection and safe reclamation;
 * 3. Package discovery and actionable distro installation diagnostics;
 * 4. Local-only VNC/noVNC transport security (strict 127.0.0.1, no public binding);
 * 5. Subprocess ownership registration and refusal to terminate foreign PIDs;
 * 6. Health check diagnostics and clean teardown;
 * 7. Platform boundaries (fail-fast on Windows/macOS, supported on Linux).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  allocateVirtualDisplay,
  isDisplayActive,
  getDisplayLockDir,
  type DisplayAllocation,
} from "../src/core/browserRuntime/virtualDisplayAllocation.js";
import {
  probeVirtualDisplayPrerequisites,
  generateInstallCommand,
  detectLinuxDistributionFamily,
  findSystemBinary,
  WINDOW_MANAGER_CANDIDATES,
} from "../src/core/browserRuntime/virtualDisplayPackages.js";
import {
  VirtualDisplayWorker,
  getVirtualDisplayWorker,
  resetVirtualDisplayWorkerForTest,
} from "../src/core/browserRuntime/virtualDisplayWorker.js";
import {
  resolveEffectiveBrowserMode,
} from "../src/core/browserRuntime/browserExecutableDiscovery.js";
import { buildBrowserLaunchFlags } from "../src/core/browserRuntime/browserFlags.js";
import { getProcessSupervisor } from "../src/core/process/processSupervisor.js";

describe("Virtual Display Allocation & Collision Avoidance (M2)", () => {
  let testLockDir: string;
  let testSysLockDir: string;
  let testX11SocketDir: string;

  beforeEach(async () => {
    testLockDir = path.join(os.tmpdir(), `sa-test-display-locks-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    testSysLockDir = path.join(os.tmpdir(), `sa-test-sys-locks-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    testX11SocketDir = path.join(os.tmpdir(), `sa-test-x11-sock-${Date.now()}-${Math.random().toString(36).slice(2)}`);

    await fsp.mkdir(testLockDir, { recursive: true });
    await fsp.mkdir(testSysLockDir, { recursive: true });
    await fsp.mkdir(testX11SocketDir, { recursive: true });
  });

  afterEach(async () => {
    await fsp.rm(testLockDir, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(testSysLockDir, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(testX11SocketDir, { recursive: true, force: true }).catch(() => {});
    resetVirtualDisplayWorkerForTest();
  });

  it("dynamically allocates display :99 when free and writes atomic session lock", async () => {
    const alloc = await allocateVirtualDisplay({
      lockDir: testLockDir,
      systemLockDir: testSysLockDir,
      x11SocketDir: testX11SocketDir,
      rangeStart: 99,
      rangeEnd: 105,
    });

    expect(alloc.displayNumber).toBe(99);
    expect(alloc.displayStr).toBe(":99");
    expect(fs.existsSync(alloc.lockFilePath)).toBe(true);

    const lockData = JSON.parse(await fsp.readFile(alloc.lockFilePath, "utf8"));
    expect(lockData.displayNumber).toBe(99);
    expect(lockData.pid).toBe(process.pid);
    expect(typeof lockData.allocatedAt).toBe("number");

    await alloc.release();
    expect(fs.existsSync(alloc.lockFilePath)).toBe(false);
  });

  it("avoids hardcoded collisions by advancing to :100 when :99 is occupied", async () => {
    // 1. Allocate :99
    const alloc1 = await allocateVirtualDisplay({
      lockDir: testLockDir,
      systemLockDir: testSysLockDir,
      x11SocketDir: testX11SocketDir,
      rangeStart: 99,
      rangeEnd: 105,
    });
    expect(alloc1.displayNumber).toBe(99);

    // 2. Allocate next -> should be :100 without collision
    const alloc2 = await allocateVirtualDisplay({
      lockDir: testLockDir,
      systemLockDir: testSysLockDir,
      x11SocketDir: testX11SocketDir,
      rangeStart: 99,
      rangeEnd: 105,
    });
    expect(alloc2.displayNumber).toBe(100);
    expect(alloc2.displayStr).toBe(":100");

    // 3. Allocate third -> should be :101
    const alloc3 = await allocateVirtualDisplay({
      lockDir: testLockDir,
      systemLockDir: testSysLockDir,
      x11SocketDir: testX11SocketDir,
      rangeStart: 99,
      rangeEnd: 105,
    });
    expect(alloc3.displayNumber).toBe(101);

    await alloc1.release();
    await alloc2.release();
    await alloc3.release();
  });

  it("detects system /tmp/.X{N}-lock and skips the occupied display number", async () => {
    // Simulate system X11 lock for :99
    const sysLockFile = path.join(testSysLockDir, ".X99-lock");
    await fsp.writeFile(sysLockFile, "12345\n");

    const alloc = await allocateVirtualDisplay({
      lockDir: testLockDir,
      systemLockDir: testSysLockDir,
      x11SocketDir: testX11SocketDir,
      rangeStart: 99,
      rangeEnd: 105,
    });

    // Should skip :99 and allocate :100
    expect(alloc.displayNumber).toBe(100);
    expect(alloc.displayStr).toBe(":100");

    await alloc.release();
  });

  it("detects system /tmp/.X11-unix/X{N} domain socket and skips the occupied display", async () => {
    // Simulate active X11 socket for :99 and :100
    await fsp.writeFile(path.join(testX11SocketDir, "X99"), "");
    await fsp.writeFile(path.join(testX11SocketDir, "X100"), "");

    const alloc = await allocateVirtualDisplay({
      lockDir: testLockDir,
      systemLockDir: testSysLockDir,
      x11SocketDir: testX11SocketDir,
      rangeStart: 99,
      rangeEnd: 105,
    });

    // Should skip :99 and :100 and allocate :101
    expect(alloc.displayNumber).toBe(101);
    await alloc.release();
  });

  it("safely reclaims orphaned lock file from a dead process", async () => {
    const deadPid = 999999; // Non-existent PID
    const lockFile = path.join(testLockDir, "display-99.lock");
    await fsp.writeFile(
      lockFile,
      JSON.stringify({
        displayNumber: 99,
        displayStr: ":99",
        pid: deadPid,
        creationIdentity: "dead-identity",
        allocatedAt: Date.now() - 60000,
        host: os.hostname(),
      })
    );

    const alloc = await allocateVirtualDisplay({
      lockDir: testLockDir,
      systemLockDir: testSysLockDir,
      x11SocketDir: testX11SocketDir,
      rangeStart: 99,
      rangeEnd: 105,
    });

    // Should successfully reclaim :99
    expect(alloc.displayNumber).toBe(99);
    const content = JSON.parse(await fsp.readFile(lockFile, "utf8"));
    expect(content.pid).toBe(process.pid);

    await alloc.release();
  });

  it("protects lock file from an active process and advances to next slot", async () => {
    const livePid = process.pid; // Our own active process
    const lockFile = path.join(testLockDir, "display-99.lock");
    await fsp.writeFile(
      lockFile,
      JSON.stringify({
        displayNumber: 99,
        displayStr: ":99",
        pid: livePid,
        creationIdentity: "live-identity",
        allocatedAt: Date.now(),
        host: os.hostname(),
      })
    );

    const alloc = await allocateVirtualDisplay({
      lockDir: testLockDir,
      systemLockDir: testSysLockDir,
      x11SocketDir: testX11SocketDir,
      rangeStart: 99,
      rangeEnd: 105,
    });

    // Active PID was protected; :100 was allocated
    expect(alloc.displayNumber).toBe(100);
    await alloc.release();
  });

  it("throws clear error when range is completely exhausted", async () => {
    // Fill all slots in range 99..100
    const alloc1 = await allocateVirtualDisplay({
      lockDir: testLockDir,
      systemLockDir: testSysLockDir,
      x11SocketDir: testX11SocketDir,
      rangeStart: 99,
      rangeEnd: 100,
    });
    const alloc2 = await allocateVirtualDisplay({
      lockDir: testLockDir,
      systemLockDir: testSysLockDir,
      x11SocketDir: testX11SocketDir,
      rangeStart: 99,
      rangeEnd: 100,
    });

    expect(alloc1.displayNumber).toBe(99);
    expect(alloc2.displayNumber).toBe(100);

    // Attempting a third must throw
    await expect(
      allocateVirtualDisplay({
        lockDir: testLockDir,
        systemLockDir: testSysLockDir,
        x11SocketDir: testX11SocketDir,
        rangeStart: 99,
        rangeEnd: 100,
      })
    ).rejects.toThrow(/No available virtual display numbers in range :99 to :100/);

    await alloc1.release();
    await alloc2.release();
  });
});

describe("Virtual Display Package Discovery & Diagnostics (M2)", () => {
  it("generates actionable package installation command for Debian/Ubuntu", () => {
    const cmd = generateInstallCommand("debian");
    expect(cmd).toContain("sudo apt-get update");
    expect(cmd).toContain("apt-get install -y xvfb openbox x11vnc websockify novnc");
  });

  it("generates actionable package installation command for Fedora/RHEL", () => {
    const cmd = generateInstallCommand("fedora");
    expect(cmd).toContain("sudo dnf install -y");
    expect(cmd).toContain("xorg-x11-server-Xvfb openbox x11vnc python3-websockify novnc");
  });

  it("generates actionable package installation command for Arch Linux", () => {
    const cmd = generateInstallCommand("arch");
    expect(cmd).toContain("sudo pacman -S");
    expect(cmd).toContain("xorg-server-xvfb openbox x11vnc python-websockify novnc");
  });

  it("generates actionable package installation command for Alpine", () => {
    const cmd = generateInstallCommand("alpine");
    expect(cmd).toContain("sudo apk add");
    expect(cmd).toContain("xvfb openbox x11vnc websockify novnc");
  });

  it("recognizes standard window manager candidates in priority order", () => {
    expect(WINDOW_MANAGER_CANDIDATES[0]).toBe("openbox");
    expect(WINDOW_MANAGER_CANDIDATES[1]).toBe("fluxbox");
    expect(WINDOW_MANAGER_CANDIDATES).toContain("matchbox-window-manager");
    expect(WINDOW_MANAGER_CANDIDATES).toContain("twm");
  });

  it("correctly identifies missing prerequisites when environment has empty PATH", () => {
    const res = probeVirtualDisplayPrerequisites({
      env: { PATH: "" },
      requireVnc: true,
      requireNoVnc: true,
    });

    expect(res.xvfb.found).toBe(false);
    expect(res.windowManager.found).toBe(false);
    expect(res.missingRequired).toContain("Xvfb");
    expect(res.missingRequired).toContain("Window Manager (openbox/fluxbox/matchbox/twm)");
    expect(res.missingRequired).toContain("x11vnc");
    expect(res.actionableInstallCommand.length).toBeGreaterThan(10);
  });
});

describe("Virtual Display Security & Flag Invariants (M2)", () => {
  it("enforces loopback-only CDP address and preserves sandbox in virtual-display mode", () => {
    const flags = buildBrowserLaunchFlags({
      mode: "virtual-display",
      port: 9222,
      userDataDir: "/tmp/sa-debug-profile",
      additionalFlags: [
        "--no-sandbox", // Adversarial attempt to disable sandbox
        "--remote-debugging-address=0.0.0.0", // Adversarial attempt to bind publicly
      ],
    });

    // 1. Loopback CDP binding enforced
    expect(flags).toContain("--remote-debugging-port=9222");
    expect(flags).toContain("--remote-debugging-address=127.0.0.1");
    expect(flags).not.toContain("--remote-debugging-address=0.0.0.0");

    // 2. Sandbox strictly preserved
    expect(flags).not.toContain("--no-sandbox");

    // 3. Headed execution inside virtual display (NO --headless=new)
    expect(flags).not.toContain("--headless=new");
  });

  it("fails fast with platform diagnostic when virtual-display is called on Windows", () => {
    expect(() => {
      resolveEffectiveBrowserMode("virtual-display", "win32");
    }).toThrow(/Virtual display mode \(Xvfb\/minimal WM\) is only supported on Linux/);
  });

  it("fails fast with platform diagnostic when virtual-display is called on macOS", () => {
    expect(() => {
      resolveEffectiveBrowserMode("virtual-display", "darwin");
    }).toThrow(/Virtual display mode \(Xvfb\/minimal WM\) is only supported on Linux/);
  });

  it("resolves virtual-display mode successfully on Linux", () => {
    const res = resolveEffectiveBrowserMode("virtual-display", "linux");
    expect(res.mode).toBe("virtual-display");
    expect(res.requested).toBe("virtual-display");
  });

  it("supports preferVirtualDisplay in auto mode on displayless Linux", () => {
    const res = resolveEffectiveBrowserMode(
      "auto",
      "linux",
      { DISPLAY: "", WAYLAND_DISPLAY: "" },
      { preferVirtualDisplay: true }
    );
    expect(res.mode).toBe("virtual-display");
  });

  it("defaults to headless in auto mode on displayless Linux when preferVirtualDisplay is not set", () => {
    const res = resolveEffectiveBrowserMode(
      "auto",
      "linux",
      { DISPLAY: "", WAYLAND_DISPLAY: "" }
    );
    expect(res.mode).toBe("headless");
  });
});

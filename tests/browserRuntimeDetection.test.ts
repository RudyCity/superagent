/**
 * Browser Runtime Detection & Environment Probing Unit Tests (Milestone M1)
 *
 * Validates display environment probing, effective mode resolution, executable candidate fallback,
 * and fail-fast behavior for reserved virtual-display mode.
 */

import { describe, it, expect } from "bun:test";
import {
  probeLinuxDisplayEnvironment,
  resolveEffectiveBrowserMode,
  discoverBrowserExecutable,
  LINUX_EXECUTABLE_CANDIDATES,
} from "../src/core/browserRuntime/browserExecutableDiscovery.js";

describe("Browser Runtime Environment & Mode Probing", () => {
  describe("probeLinuxDisplayEnvironment", () => {
    it("detects X11 display when DISPLAY is set", () => {
      const env = { DISPLAY: ":0" };
      const res = probeLinuxDisplayEnvironment(env);
      expect(res.hasDisplay).toBe(true);
      expect(res.displayType).toBe("x11");
      expect(res.displayVar).toBe(":0");
      expect(res.waylandVar).toBe(null);
    });

    it("detects Wayland display when WAYLAND_DISPLAY is set", () => {
      const env = { WAYLAND_DISPLAY: "wayland-0" };
      const res = probeLinuxDisplayEnvironment(env);
      expect(res.hasDisplay).toBe(true);
      expect(res.displayType).toBe("wayland");
      expect(res.displayVar).toBe(null);
      expect(res.waylandVar).toBe("wayland-0");
    });

    it("detects absence of display server when neither variable is set", () => {
      const env = {};
      const res = probeLinuxDisplayEnvironment(env);
      expect(res.hasDisplay).toBe(false);
      expect(res.displayType).toBe("none");
      expect(res.displayVar).toBe(null);
      expect(res.waylandVar).toBe(null);
    });

    it("ignores whitespace-only display environment variables", () => {
      const env = { DISPLAY: "   ", WAYLAND_DISPLAY: "" };
      const res = probeLinuxDisplayEnvironment(env);
      expect(res.hasDisplay).toBe(false);
      expect(res.displayType).toBe("none");
    });
  });

  describe("resolveEffectiveBrowserMode", () => {
    it("resolves virtual-display on Linux and fails fast on non-Linux platforms", () => {
      const resLinux = resolveEffectiveBrowserMode("virtual-display", "linux");
      expect(resLinux.mode).toBe("virtual-display");
      expect(resLinux.requested).toBe("virtual-display");

      expect(() => {
        resolveEffectiveBrowserMode("virtual-display", "win32");
      }).toThrow(/only supported on Linux/);

      expect(() => {
        resolveEffectiveBrowserMode("virtual-display", "darwin");
      }).toThrow(/only supported on Linux/);
    });

    it("resolves auto mode on displayless Linux to virtual-display when preferVirtualDisplay is requested", () => {
      const res = resolveEffectiveBrowserMode("auto", "linux", {}, { preferVirtualDisplay: true });
      expect(res.mode).toBe("virtual-display");
      expect(res.requested).toBe("auto");
    });

    it("resolves auto mode on displayless Linux to headless", () => {
      const res = resolveEffectiveBrowserMode("auto", "linux", {});
      expect(res.mode).toBe("headless");
      expect(res.requested).toBe("auto");
    });

    it("resolves auto mode on Linux with active DISPLAY to headed", () => {
      const res = resolveEffectiveBrowserMode("auto", "linux", { DISPLAY: ":1" });
      expect(res.mode).toBe("headed");
      expect(res.requested).toBe("auto");
    });

    it("resolves auto mode on Linux with WAYLAND_DISPLAY to headed", () => {
      const res = resolveEffectiveBrowserMode("auto", "linux", { WAYLAND_DISPLAY: "wayland-1" });
      expect(res.mode).toBe("headed");
      expect(res.requested).toBe("auto");
    });

    it("fails fast when headed is requested on Linux without display server", () => {
      expect(() => {
        resolveEffectiveBrowserMode("headed", "linux", {});
      }).toThrow(/Cannot launch Chrome in 'headed' mode on Linux because neither DISPLAY nor WAYLAND_DISPLAY is set/);
    });

    it("allows headed mode on Linux when DISPLAY is present", () => {
      const res = resolveEffectiveBrowserMode("headed", "linux", { DISPLAY: ":0" });
      expect(res.mode).toBe("headed");
    });

    it("resolves headless mode on any platform regardless of display", () => {
      expect(resolveEffectiveBrowserMode("headless", "linux", { DISPLAY: ":0" }).mode).toBe("headless");
      expect(resolveEffectiveBrowserMode("headless", "linux", {}).mode).toBe("headless");
      expect(resolveEffectiveBrowserMode("headless", "win32", {}).mode).toBe("headless");
      expect(resolveEffectiveBrowserMode("headless", "darwin", {}).mode).toBe("headless");
    });

    it("preserves default headed mode for auto on Windows and macOS", () => {
      expect(resolveEffectiveBrowserMode("auto", "win32", {}).mode).toBe("headed");
      expect(resolveEffectiveBrowserMode("auto", "darwin", {}).mode).toBe("headed");
    });
  });

  describe("discoverBrowserExecutable", () => {
    it("respects explicit overridePath if file exists", () => {
      // Use process.execPath as a known existing binary on the system
      const res = discoverBrowserExecutable(process.execPath, "linux");
      expect(res.found).toBe(true);
      expect(res.executable).toBe(process.execPath);
    });

    it("enumerates canonical Linux candidate executables", () => {
      const res = discoverBrowserExecutable(undefined, "linux", { PATH: "" });
      expect(res.candidatesProbed.length).toBeGreaterThanOrEqual(LINUX_EXECUTABLE_CANDIDATES.length);
      for (const candidate of LINUX_EXECUTABLE_CANDIDATES) {
        expect(res.candidatesProbed.some((p) => p.includes(candidate))).toBe(true);
      }
    });

    it("returns actionable error message on Linux when no executable is found", () => {
      const res = discoverBrowserExecutable(undefined, "linux", { PATH: "" });
      if (!res.found) {
        expect(res.error).toBeDefined();
        expect(res.error).toContain("No Chrome or Chromium executable found");
        expect(res.error).toContain("apt-get install");
      }
    });

    it("probes standard Windows candidates on win32", () => {
      const res = discoverBrowserExecutable(undefined, "win32", {});
      expect(res.candidatesProbed.some((p) => p.includes("Application\\chrome.exe") || p === "chrome.exe")).toBe(true);
    });
  });
});

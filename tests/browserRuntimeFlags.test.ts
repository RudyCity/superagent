/**
 * Browser Launch Flags Security & Normalization Unit Tests (Milestone M1)
 *
 * Enforces loopback-only CDP binding, isolated user-data-dir, headless mode arguments,
 * and sandbox preservation invariants (strict rejection of --no-sandbox).
 */

import { describe, it, expect } from "bun:test";
import { buildBrowserLaunchFlags } from "../src/core/browserRuntime/browserFlags.js";

describe("Browser Launch Flags Security & Normalization", () => {
  it("enforces loopback-only CDP binding and isolated profile defaults", () => {
    const flags = buildBrowserLaunchFlags({
      mode: "headless",
      port: 9222,
      userDataDir: "/tmp/test-profile",
    });

    expect(flags).toContain("--remote-debugging-port=9222");
    expect(flags).toContain("--remote-debugging-address=127.0.0.1");
    expect(flags).toContain("--user-data-dir=/tmp/test-profile");
    expect(flags).toContain("--no-first-run");
    expect(flags).toContain("--no-default-browser-check");
    expect(flags).toContain("--headless=new");
    expect(flags).toContain("--disable-gpu");
  });

  it("omits headless flags in headed mode", () => {
    const flags = buildBrowserLaunchFlags({
      mode: "headed",
      port: 9222,
      userDataDir: "/tmp/test-profile",
    });

    expect(flags).toContain("--remote-debugging-port=9222");
    expect(flags).toContain("--remote-debugging-address=127.0.0.1");
    expect(flags.some((f) => f.includes("--headless"))).toBe(false);
    expect(flags.some((f) => f.includes("--disable-gpu"))).toBe(false);
  });

  it("strips --no-sandbox from additionalFlags to preserve sandbox boundaries", () => {
    const flags = buildBrowserLaunchFlags({
      mode: "headless",
      port: 9222,
      userDataDir: "/tmp/test-profile",
      additionalFlags: [
        "--no-sandbox",
        "--disable-web-security",
        "--disable-setuid-sandbox",
        "--enable-logging",
      ],
    });

    expect(flags.includes("--no-sandbox")).toBe(false);
    expect(flags.includes("--disable-web-security")).toBe(false);
    expect(flags.includes("--disable-setuid-sandbox")).toBe(false);
    expect(flags).toContain("--enable-logging");
  });

  it("prohibits external remote-debugging-address override", () => {
    const flags = buildBrowserLaunchFlags({
      mode: "headless",
      port: 9222,
      userDataDir: "/tmp/test-profile",
      additionalFlags: ["--remote-debugging-address=0.0.0.0"],
    });

    // Must remain 127.0.0.1; 0.0.0.0 must be dropped
    expect(flags).toContain("--remote-debugging-address=127.0.0.1");
    expect(flags.includes("--remote-debugging-address=0.0.0.0")).toBe(false);
  });

  it("applies profile directory when specified", () => {
    const flags = buildBrowserLaunchFlags({
      mode: "headless",
      port: 9222,
      userDataDir: "/tmp/test-profile",
      profileName: "Profile 2",
    });

    expect(flags).toContain("--profile-directory=Profile 2");
  });

  it("applies media bypass flags when useFakeMediaUi is true", () => {
    const flags = buildBrowserLaunchFlags({
      mode: "headless",
      port: 9222,
      userDataDir: "/tmp/test-profile",
      useFakeMediaUi: true,
      autoSelectDesktopCaptureSource: "Entire screen",
    });

    expect(flags).toContain('--auto-select-desktop-capture-source=Entire screen');
    expect(flags).toContain("--use-fake-ui-for-media-stream");
    expect(flags).toContain("--enable-usermedia-screen-capturing");
  });

  it("places target URL at the end of the argument list", () => {
    const flags = buildBrowserLaunchFlags({
      mode: "headless",
      port: 9222,
      userDataDir: "/tmp/test-profile",
      url: "https://example.com/test",
    });

    expect(flags[flags.length - 1]).toBe("https://example.com/test");
  });

  it("rejects invalid remote debugging ports", () => {
    expect(() => {
      buildBrowserLaunchFlags({
        mode: "headless",
        port: 80, // privileged port (< 1024)
        userDataDir: "/tmp/test-profile",
      });
    }).toThrow(/Invalid CDP remote debugging port/);

    expect(() => {
      buildBrowserLaunchFlags({
        mode: "headless",
        port: 70000, // out of range (> 65535)
        userDataDir: "/tmp/test-profile",
      });
    }).toThrow(/Invalid CDP remote debugging port/);
  });
});

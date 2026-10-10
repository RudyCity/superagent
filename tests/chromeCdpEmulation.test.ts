import { describe, it, expect, vi } from "vitest";
import {
  executeDeviceEmulationCommand,
  DEVICE_PRESETS,
  getDevicePreset,
  listDevicePresets,
} from "../src/core/tools/chromeCdpEmulation.js";

describe("chromeCdpEmulation", () => {
  it("exposes built-in presets for mobile, tablet, and desktop", () => {
    const presets = listDevicePresets();
    expect(presets).toContain("mobile");
    expect(presets).toContain("tablet");
    expect(presets).toContain("desktop");
    expect(presets).toContain("android");
    expect(presets).toContain("laptop");

    const mobile = getDevicePreset("mobile");
    expect(mobile).toBeDefined();
    expect(mobile?.width).toBe(390);
    expect(mobile?.height).toBe(844);
    expect(mobile?.deviceScaleFactor).toBe(3);
    expect(mobile?.mobile).toBe(true);
    expect(mobile?.touch).toBe(true);

    const tablet = getDevicePreset("tablet");
    expect(tablet).toBeDefined();
    expect(tablet?.width).toBe(820);
    expect(tablet?.height).toBe(1180);
    expect(tablet?.mobile).toBe(true);

    const desktop = getDevicePreset("desktop");
    expect(desktop).toBeDefined();
    expect(desktop?.width).toBe(1920);
    expect(desktop?.height).toBe(1080);
    expect(desktop?.mobile).toBe(false);
    expect(desktop?.touch).toBe(false);
  });

  it("applies mobile preset with metrics, touch, and userAgent override", async () => {
    const calls: { method: string; params: any }[] = [];
    const mockCdpSend = async (_target: any, method: string, params: any) => {
      calls.push({ method, params });
      if (method === "Runtime.evaluate") {
        return {
          result: {
            value: JSON.stringify({ innerWidth: 390, innerHeight: 844, dpr: 3, mobile: true }),
          },
        };
      }
      return {};
    };

    const target = { id: "tab-1", title: "Laris Mobile Test", webSocketDebuggerUrl: "ws://..." } as any;
    const res = await executeDeviceEmulationCommand(mockCdpSend, target, { preset: "mobile" });

    expect(res).toContain("mobile");
    expect(res).toContain("390x844");
    expect(res).toContain("3x");
    expect(res).toContain("mobile: true");
    expect(res).toContain("touch: true");

    const metricsCall = calls.find((c) => c.method === "Emulation.setDeviceMetricsOverride");
    expect(metricsCall).toBeDefined();
    expect(metricsCall?.params.width).toBe(390);
    expect(metricsCall?.params.height).toBe(844);
    expect(metricsCall?.params.mobile).toBe(true);

    const touchCall = calls.find((c) => c.method === "Emulation.setTouchEmulationEnabled");
    expect(touchCall).toBeDefined();
    expect(touchCall?.params.enabled).toBe(true);

    const uaCall = calls.find((c) => c.method === "Emulation.setUserAgentOverride");
    expect(uaCall).toBeDefined();
    expect(uaCall?.params.userAgent).toContain("iPhone");
  });

  it("applies tablet preset with orientation support", async () => {
    const calls: { method: string; params: any }[] = [];
    const mockCdpSend = async (_target: any, method: string, params: any) => {
      calls.push({ method, params });
      if (method === "Runtime.evaluate") {
        return {
          result: {
            value: JSON.stringify({ innerWidth: 1180, innerHeight: 820, dpr: 2, mobile: true }),
          },
        };
      }
      return {};
    };

    const target = { id: "tab-2", title: "Laris Tablet Landscape", webSocketDebuggerUrl: "ws://..." } as any;
    const res = await executeDeviceEmulationCommand(mockCdpSend, target, {
      device: "tablet",
      orientation: "landscape",
    });

    expect(res).toContain("tablet");
    expect(res).toContain("landscape");

    const metricsCall = calls.find((c) => c.method === "Emulation.setDeviceMetricsOverride");
    expect(metricsCall).toBeDefined();
    expect(metricsCall?.params.width).toBe(1180);
    expect(metricsCall?.params.height).toBe(820);
    expect(metricsCall?.params.screenOrientation?.type).toBe("landscapePrimary");
  });

  it("resets emulation back to host window dimensions", async () => {
    const calls: { method: string; params: any }[] = [];
    const mockCdpSend = async (_target: any, method: string, params: any) => {
      calls.push({ method, params });
      if (method === "Runtime.evaluate") {
        return {
          result: {
            value: JSON.stringify({ innerWidth: 1920, innerHeight: 960, dpr: 1, mobile: false }),
          },
        };
      }
      return {};
    };

    const target = { id: "tab-3", title: "Laris Reset", webSocketDebuggerUrl: "ws://..." } as any;
    const res = await executeDeviceEmulationCommand(mockCdpSend, target, { preset: "reset" });

    expect(res).toContain("cleared");
    expect(calls.some((c) => c.method === "Emulation.clearDeviceMetricsOverride")).toBe(true);
    expect(calls.some((c) => c.method === "Emulation.setTouchEmulationEnabled" && !c.params.enabled)).toBe(true);
    expect(calls.some((c) => c.method === "Emulation.setUserAgentOverride" && c.params.userAgent === "")).toBe(true);
  });

  it("handles custom dimensions and touch configuration", async () => {
    const calls: { method: string; params: any }[] = [];
    const mockCdpSend = async (_target: any, method: string, params: any) => {
      calls.push({ method, params });
      return {};
    };

    const target = { id: "tab-4", title: "Custom Device", webSocketDebuggerUrl: "ws://..." } as any;
    const res = await executeDeviceEmulationCommand(mockCdpSend, target, {
      width: 500,
      height: 900,
      scale: 2,
      mobile: true,
      touch: true,
    });

    expect(res).toContain("500x900");
    const metricsCall = calls.find((c) => c.method === "Emulation.setDeviceMetricsOverride");
    expect(metricsCall?.params.width).toBe(500);
    expect(metricsCall?.params.height).toBe(900);
    expect(metricsCall?.params.deviceScaleFactor).toBe(2);
  });

  it("returns preset list when requested", async () => {
    const mockCdpSend = async () => ({});
    const target = { id: "tab-5", title: "Presets", webSocketDebuggerUrl: "ws://..." } as any;
    const res = await executeDeviceEmulationCommand(mockCdpSend, target, { list_presets: true });
    expect(res).toContain("Available device presets:");
    expect(res).toContain("mobile");
    expect(res).toContain("tablet");
    expect(res).toContain("desktop");
  });
});
